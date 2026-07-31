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

	readyTimeout = 60 * time.Second
)

var (
	once sync.Once
	dsn  string
	err  error
)

// Postgres returns a pool against a database carrying the full schema. It
// reuses TEST_POSTGRES_DSN when set, otherwise starts a container. Tests skip
// rather than fail when neither is available, so `go test ./...` still works on
// a machine with no Docker.
func Postgres(t *testing.T) *pgxpool.Pool {
	t.Helper()

	once.Do(func() { dsn, err = resolve() })

	if err != nil {
		t.Skipf("no test Postgres available: %v", err)
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
func Truncate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	const q = `TRUNCATE ledger_entries, settlements, consumed_assertions, search_requests,
	                    listings, products, publishers, merchants
	           RESTART IDENTITY CASCADE`

	if _, execErr := pool.Exec(context.Background(), q); execErr != nil {
		t.Fatalf("truncate: %v", execErr)
	}
}

func resolve() (string, error) {
	if existing := strings.TrimSpace(os.Getenv("TEST_POSTGRES_DSN")); existing != "" {
		return existing, applySchema(existing)
	}

	if _, lookErr := exec.LookPath("docker"); lookErr != nil {
		return "", fmt.Errorf("set TEST_POSTGRES_DSN or install Docker")
	}

	started := fmt.Sprintf(
		"postgres://agentic:agentic@127.0.0.1:%s/agentic?sslmode=disable", hostPort)

	// A container from a previous run already carries the schema and data we
	// truncate anyway, so reuse beats tearing down and paying startup again.
	if running() {
		return started, applySchema(started)
	}

	cmd := exec.Command("docker", "run", "-d", "--rm",
		"--name", containerName,
		"-e", "POSTGRES_USER=agentic",
		"-e", "POSTGRES_PASSWORD=agentic",
		"-e", "POSTGRES_DB=agentic",
		"-p", hostPort+":5432",
		image)

	if out, runErr := cmd.CombinedOutput(); runErr != nil {
		return "", fmt.Errorf("start %s: %v: %s", image, runErr, out)
	}

	if waitErr := waitReady(); waitErr != nil {
		return "", waitErr
	}

	return started, applySchema(started)
}

func running() bool {
	out, _ := exec.Command("docker", "ps", "-q", "-f", "name="+containerName).Output()

	return len(strings.TrimSpace(string(out))) > 0
}

func waitReady() error {
	deadline := time.Now().Add(readyTimeout)

	for time.Now().Before(deadline) {
		if exec.Command("docker", "exec", containerName, "pg_isready", "-U", "agentic").Run() == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}

	return fmt.Errorf("%s did not become ready within %v", containerName, readyTimeout)
}

// applySchema runs the same migration files docker-compose mounts into the
// Postgres entrypoint, so tests exercise the schema the demo actually ships
// rather than one written to suit them.
func applySchema(target string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, poolErr := pgxpool.New(ctx, target)
	if poolErr != nil {
		return fmt.Errorf("connect for schema load: %w", poolErr)
	}
	defer pool.Close()

	var exists bool
	if scanErr := pool.QueryRow(ctx,
		`SELECT to_regclass('public.settlements') IS NOT NULL`).Scan(&exists); scanErr != nil {
		return fmt.Errorf("probe schema: %w", scanErr)
	}
	if exists {
		return nil
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
		statements, readErr := os.ReadFile(file)
		if readErr != nil {
			return fmt.Errorf("read %s: %w", file, readErr)
		}
		if _, execErr := pool.Exec(ctx, string(statements)); execErr != nil {
			return fmt.Errorf("apply %s: %w", filepath.Base(file), execErr)
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
