// Package testsupport provides a real Postgres for tests that cannot be
// written honestly against a mock.
//
// The settlement store's correctness lives in constraints, transactions, and
// aggregate types, none of which a fake database enforces. A mock would have
// happily accepted the numeric-into-int scan that a reviewer caught by reading
// SQL, which is precisely the class of bug worth spending a container on.
package testsupport

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// A fixed name so a killed test run leaves one container to clean up
	// rather than one per package.
	containerName = "agentic-attribution-test-postgres"
	hostPort      = "55432"
	image         = "postgres:17-alpine"

	adminDatabase = "agentic"

	readyTimeout = 60 * time.Second
)

// ErrNoDatabase reports the one condition worth skipping over: this machine
// offers no way to reach a Postgres at all.
//
// Everything else fails the run. A pull that times out, a port already bound,
// or a migration that no longer applies are all real problems, and a suite
// that skips itself on them reports green while testing nothing.
var ErrNoDatabase = errors.New("no test Postgres available")

var (
	once sync.Once
	dsn  string
	err  error
)

// Postgres returns a pool against a database carrying the full schema. It
// reuses TEST_POSTGRES_DSN when set, otherwise starts a container.
func Postgres(t *testing.T) *pgxpool.Pool {
	t.Helper()

	once.Do(func() { dsn, err = resolve() })

	switch {
	case errors.Is(err, ErrNoDatabase):
		t.Skipf("%v", err)
	case err != nil:
		// Deliberately fatal. Skipping here would turn a broken container, a
		// bound port, or a migration that stopped applying into a green run.
		t.Fatalf("the test database is reachable but unusable: %v", err)
	}

	pool, poolErr := pgxpool.New(context.Background(), dsn)
	if poolErr != nil {
		t.Fatalf("connect to the test database: %v", poolErr)
	}
	t.Cleanup(pool.Close)

	Truncate(t, pool)

	return pool
}

// Truncate empties every table between tests. RESTART IDENTITY resets the
// ledger's sequence so entry identifiers stay predictable, and CASCADE handles
// the foreign keys without needing a hand-maintained ordering.
//
// schema_migrations stays out of the list deliberately: it records what has
// already been applied, and clearing it would make every later test reapply
// migrations against a schema that already carries them.
func Truncate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	const q = `TRUNCATE ledger_entries, settlements, consumed_assertions, search_requests,
	                    listings, products, publishers, merchants
	           RESTART IDENTITY CASCADE`

	if _, execErr := pool.Exec(context.Background(), q); execErr != nil {
		t.Fatalf("truncate: %v", execErr)
	}
}

// databaseName derives a database of the calling package's own from the test
// binary's name.
//
// `go test ./...` runs packages in parallel, so two packages sharing one
// database truncate each other's rows mid-run. They then pass individually and
// fail together, which is the worst way for a suite to be wrong.
//
// An advisory lock would also prevent the interleaving, at the cost of every
// database-backed package waiting on every other one. A database each removes
// the contention rather than scheduling around it, and keeps a failing
// package's leftover rows out of the next package's view.
func databaseName() string {
	base := filepath.Base(os.Args[0])
	base = strings.TrimSuffix(base, ".exe")
	base = strings.TrimSuffix(base, ".test")

	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		default:
			return '_'
		}
	}, base)

	if cleaned == "" {
		cleaned = "shared"
	}

	return "agentic_test_" + cleaned
}

func resolve() (string, error) {
	if existing := strings.TrimSpace(os.Getenv("TEST_POSTGRES_DSN")); existing != "" {
		return existing, applySchema(existing)
	}

	if _, lookErr := exec.LookPath("docker"); lookErr != nil {
		return "", fmt.Errorf("%w: set TEST_POSTGRES_DSN or install Docker", ErrNoDatabase)
	}

	if !running() {
		cmd := exec.Command("docker", "run", "-d", "--rm",
			"--name", containerName,
			"-e", "POSTGRES_USER=agentic",
			"-e", "POSTGRES_PASSWORD=agentic",
			"-e", "POSTGRES_DB="+adminDatabase,
			"-p", hostPort+":5432",
			image)

		// `go test ./...` starts every package's binary at once, so two of
		// them can both find no container and both try to start one. Losing
		// that race is fine and the winner's container serves everyone; only
		// a failure for some other reason is worth reporting.
		if out, runErr := cmd.CombinedOutput(); runErr != nil && !nameAlreadyTaken(out) {
			return "", fmt.Errorf("start %s: %v: %s", image, runErr, out)
		}

		if waitErr := waitReady(); waitErr != nil {
			return "", waitErr
		}
	}

	database := databaseName()

	if createErr := createDatabase(connectionString(adminDatabase), database); createErr != nil {
		return "", createErr
	}

	owned := connectionString(database)

	return owned, applySchema(owned)
}

func connectionString(database string) string {
	return fmt.Sprintf("postgres://agentic:agentic@127.0.0.1:%s/%s?sslmode=disable", hostPort, database)
}

// createDatabase gives the calling package a database of its own. CREATE
// DATABASE cannot run inside a transaction and carries no IF NOT EXISTS, so an
// existing one gets detected first and a lost race gets tolerated.
func createDatabase(admin, name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, poolErr := pgxpool.New(ctx, admin)
	if poolErr != nil {
		return fmt.Errorf("connect to create %s: %w", name, poolErr)
	}
	defer pool.Close()

	var exists bool
	if scanErr := pool.QueryRow(ctx,
		"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", name).Scan(&exists); scanErr != nil {
		return fmt.Errorf("probe for %s: %w", name, scanErr)
	}
	if exists {
		return nil
	}

	if _, execErr := pool.Exec(ctx, "CREATE DATABASE "+name); execErr != nil {
		// Another package's binary may have won the race, which is fine.
		if !strings.Contains(execErr.Error(), "already exists") {
			return fmt.Errorf("create database %s: %w", name, execErr)
		}
	}

	return nil
}

// nameAlreadyTaken reports the one docker run failure that means success:
// another process already started the container we wanted.
func nameAlreadyTaken(output []byte) bool {
	return strings.Contains(string(output), "already in use")
}

func running() bool {
	out, _ := exec.Command("docker", "ps", "-q", "-f", "name="+containerName).Output()

	return len(strings.TrimSpace(string(out))) > 0
}

// waitReady probes with a real connection from the host rather than with
// pg_isready inside the container.
//
// The official image runs a temporary server on a unix socket while initdb
// completes, and pg_isready answers against that socket well before the real
// server accepts TCP. Trusting it produces a connection reset a moment later,
// on whichever package lost the start race, which reads as a broken database
// rather than as one still starting.
func waitReady() error {
	deadline := time.Now().Add(readyTimeout)
	target := connectionString(adminDatabase)

	var last error

	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)

		pool, poolErr := pgxpool.New(ctx, target)
		if poolErr == nil {
			last = pool.Ping(ctx)
			pool.Close()
		} else {
			last = poolErr
		}

		cancel()

		if last == nil {
			return nil
		}

		time.Sleep(300 * time.Millisecond)
	}

	return fmt.Errorf("%s did not accept connections within %v: %w", containerName, readyTimeout, last)
}

const migrationsTable = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	filename   TEXT PRIMARY KEY,
	applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`

// applySchema runs whichever migrations this database has not seen, recording
// each one as it lands.
//
// Probing for a single table instead would call a partially migrated database
// finished. A run interrupted between two files, or a migration added after a
// container was already warm, would leave tests running against a stale schema
// and reporting green. Recording filenames makes "already applied" a fact
// rather than an inference.
func applySchema(target string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, poolErr := pgxpool.New(ctx, target)
	if poolErr != nil {
		return fmt.Errorf("connect for schema load: %w", poolErr)
	}
	defer pool.Close()

	if _, execErr := pool.Exec(ctx, migrationsTable); execErr != nil {
		return fmt.Errorf("create schema_migrations: %w", execErr)
	}

	files, globErr := filepath.Glob(filepath.Join(repoRoot(), "db", "migrations", "*.sql"))
	if globErr != nil {
		return fmt.Errorf("find migrations: %w", globErr)
	}
	if len(files) == 0 {
		return fmt.Errorf("no migrations under %s", repoRoot())
	}
	sort.Strings(files)

	for _, file := range files {
		name := filepath.Base(file)

		var applied bool
		if scanErr := pool.QueryRow(ctx,
			"SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1)",
			name).Scan(&applied); scanErr != nil {
			return fmt.Errorf("probe %s: %w", name, scanErr)
		}
		if applied {
			continue
		}

		statements, readErr := os.ReadFile(file)
		if readErr != nil {
			return fmt.Errorf("read %s: %w", name, readErr)
		}

		// The migration and its record commit together, so an interrupted run
		// never marks a file applied that did not finish.
		tx, txErr := pool.Begin(ctx)
		if txErr != nil {
			return fmt.Errorf("begin %s: %w", name, txErr)
		}

		if _, execErr := tx.Exec(ctx, string(statements)); execErr != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", name, execErr)
		}

		if _, execErr := tx.Exec(ctx,
			"INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
			name); execErr != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record %s: %w", name, execErr)
		}

		if commitErr := tx.Commit(ctx); commitErr != nil {
			return fmt.Errorf("commit %s: %w", name, commitErr)
		}
	}

	return nil
}

// repoRoot derives the module root from this file's own compile-time path,
// which holds regardless of which package's directory the test runs from.
func repoRoot() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "."
	}

	return filepath.Dir(filepath.Dir(filepath.Dir(file)))
}
