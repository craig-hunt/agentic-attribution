// Package ingest loads the catalog into Postgres and rebuilds the OpenSearch
// index from it. The Postgres path optimizes for write throughput; the search
// path never observes a partial load. See docs/adr/0002.
package ingest

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ListingPartitions must match the MODULUS in 001_schema.sql. A mismatch
// silently misroutes rows during the swap rather than failing, which makes
// this the most dangerous constant in the pipeline.
const ListingPartitions = 8

// Staging tables are UNLOGGED. They skip WAL entirely, which roughly doubles
// COPY throughput. Safe here because a crash mid-load means re-running the
// load, not losing committed data.
const createStagingListings = `
CREATE UNLOGGED TABLE IF NOT EXISTS listings_staging (
    listing_id      TEXT   NOT NULL,
    product_id      TEXT   NOT NULL,
    merchant_id     TEXT   NOT NULL,
    merchant_sku    TEXT   NOT NULL,
    listing_title   TEXT   NOT NULL,
    price_cents     BIGINT NOT NULL,
    currency        TEXT   NOT NULL,
    in_stock        BOOLEAN NOT NULL,
    commission_bps  INTEGER NOT NULL,
    deep_link_url   TEXT   NOT NULL
)`

type PhaseTiming struct {
	Phase    string        `json:"phase"`
	Rows     int64         `json:"rows"`
	Duration time.Duration `json:"duration"`
}

func (p PhaseTiming) RowsPerSecond() float64 {
	if p.Duration <= 0 {
		return 0
	}
	return float64(p.Rows) / p.Duration.Seconds()
}

type PostgresLoader struct {
	pool *pgxpool.Pool
}

func NewPostgresLoader(pool *pgxpool.Pool) *PostgresLoader {
	return &PostgresLoader{pool: pool}
}

// LoadReference loads merchants, publishers, and products. These tables carry
// foreign keys the listings load depends on, so they land first and use a
// plain upsert rather than the partition-swap path.
func (l *PostgresLoader) LoadReference(ctx context.Context, seedDir string) ([]PhaseTiming, error) {
	var timings []PhaseTiming

	specs := []struct {
		phase    string
		file     string
		table    string
		columns  []string
		conflict string
	}{
		{
			phase: "copy_merchants", file: "merchants.csv", table: "merchants",
			columns:  []string{"merchant_id", "name", "default_commission_bps", "hold_period_days", "reversal_window_days"},
			conflict: "merchant_id",
		},
		{
			phase: "copy_publishers", file: "publishers.csv", table: "publishers",
			columns:  []string{"publisher_id", "name", "payout_currency"},
			conflict: "publisher_id",
		},
		{
			phase: "copy_products", file: "products.csv", table: "products",
			columns:  []string{"product_id", "canonical_title", "brand", "category_id", "description", "attributes"},
			conflict: "product_id",
		},
	}

	for _, s := range specs {
		start := time.Now()

		rows, err := l.copyCSVUpsert(ctx, seedDir+"/"+s.file, s.table, s.columns, s.conflict)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", s.phase, err)
		}

		timings = append(timings, PhaseTiming{
			Phase:    s.phase,
			Rows:     rows,
			Duration: time.Since(start),
		})
	}

	return timings, nil
}

// LoadListings runs the full four-phase pipeline: stage, validate, rebuild
// partitions, swap. Serving reads the live table throughout and never
// observes an intermediate state.
func (l *PostgresLoader) LoadListings(ctx context.Context, seedDir string) ([]PhaseTiming, error) {
	var timings []PhaseTiming

	// Phase 1: bulk load into an unlogged staging table with no indexes.
	// Index maintenance during load dominates cost at volume, so it waits.
	start := time.Now()
	if _, err := l.pool.Exec(ctx, "DROP TABLE IF EXISTS listings_staging"); err != nil {
		return nil, fmt.Errorf("drop staging: %w", err)
	}
	if _, err := l.pool.Exec(ctx, createStagingListings); err != nil {
		return nil, fmt.Errorf("create staging: %w", err)
	}

	staged, err := l.copyCSVDirect(ctx, seedDir+"/listings.csv", "listings_staging",
		[]string{"listing_id", "product_id", "merchant_id", "merchant_sku", "listing_title",
			"price_cents", "currency", "in_stock", "commission_bps", "deep_link_url"})
	if err != nil {
		return nil, fmt.Errorf("copy staging: %w", err)
	}
	timings = append(timings, PhaseTiming{Phase: "copy_staging", Rows: staged, Duration: time.Since(start)})

	// Phase 2: validate before anything touches the live table. A feed that
	// arrives empty or with orphaned foreign keys must fail here rather than
	// silently emptying production.
	start = time.Now()
	if err := l.validateStaging(ctx, staged); err != nil {
		return nil, fmt.Errorf("validate staging: %w", err)
	}
	timings = append(timings, PhaseTiming{Phase: "validate", Rows: staged, Duration: time.Since(start)})

	// Phase 3: build replacement partitions with indexes, outside any lock on
	// the live table.
	start = time.Now()
	// The generation stamps index names so a rebuild never collides with the
	// names the previous run left attached to the live partitions. Nanosecond
	// resolution rather than seconds, because two rebuilds inside one second
	// would otherwise generate the same name and fail the second one.
	generation := strconv.FormatInt(time.Now().UnixNano(), 36)

	if err := l.buildReplacementPartitions(ctx, generation); err != nil {
		return nil, fmt.Errorf("build partitions: %w", err)
	}
	timings = append(timings, PhaseTiming{Phase: "build_partitions", Rows: staged, Duration: time.Since(start)})

	// Phase 4: detach old and attach new inside one transaction. This is the
	// only moment the live table takes a lock, and it lasts milliseconds
	// because the data is already in place.
	start = time.Now()
	if err := l.swapPartitions(ctx); err != nil {
		return nil, fmt.Errorf("swap partitions: %w", err)
	}
	timings = append(timings, PhaseTiming{Phase: "swap_partitions", Rows: staged, Duration: time.Since(start)})

	return timings, nil
}

// copyCSVDirect streams the file through COPY FROM STDIN. Row-at-a-time
// INSERT through an ORM runs one to two orders of magnitude slower, and that
// gap is the single largest lever in bulk ingest.
func (l *PostgresLoader) copyCSVDirect(ctx context.Context, path, table string, columns []string) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.ReuseRecord = true

	// Discard the header; COPY receives values positionally.
	if _, err := reader.Read(); err != nil {
		return 0, fmt.Errorf("read header: %w", err)
	}

	conn, err := l.pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	source := &csvCopySource{reader: reader, columnCount: len(columns)}

	return conn.Conn().CopyFrom(ctx, pgx.Identifier{table}, columns, source)
}

// copyCSVUpsert loads reference data that may already exist. COPY carries no
// ON CONFLICT clause, so a straight copy into a populated table fails on the
// primary key and makes a reload impossible. Staging through a temporary table
// keeps the COPY fast and lets one INSERT resolve the conflicts.
//
// Truncating the target instead would be simpler and wrong: listings,
// settlements, and the ledger all hold foreign keys into these tables.
func (l *PostgresLoader) copyCSVUpsert(
	ctx context.Context,
	path, table string,
	columns []string,
	conflictColumn string,
) (int64, error) {
	staging := table + "_upsert_staging"

	// A real table rather than a temporary one: pgxpool hands each statement
	// whichever connection is free, and a session-scoped temp table would be
	// invisible to the connection the COPY lands on.
	if _, err := l.pool.Exec(ctx, "DROP TABLE IF EXISTS "+staging); err != nil {
		return 0, fmt.Errorf("clear upsert staging: %w", err)
	}
	if _, err := l.pool.Exec(ctx,
		fmt.Sprintf("CREATE UNLOGGED TABLE %s (LIKE %s INCLUDING DEFAULTS)", staging, table)); err != nil {
		return 0, fmt.Errorf("create upsert staging: %w", err)
	}
	defer func() {
		_, _ = l.pool.Exec(ctx, "DROP TABLE IF EXISTS "+staging)
	}()

	rows, err := l.copyCSVDirect(ctx, path, staging, columns)
	if err != nil {
		return 0, err
	}

	assignments := make([]string, 0, len(columns))
	for _, column := range columns {
		if column == conflictColumn {
			continue
		}
		assignments = append(assignments, fmt.Sprintf("%s = EXCLUDED.%s", column, column))
	}

	upsert := fmt.Sprintf(
		"INSERT INTO %s (%s) SELECT %s FROM %s ON CONFLICT (%s) DO UPDATE SET %s",
		table, strings.Join(columns, ", "), strings.Join(columns, ", "),
		staging, conflictColumn, strings.Join(assignments, ", "))

	if _, err := l.pool.Exec(ctx, upsert); err != nil {
		return 0, fmt.Errorf("upsert %s: %w", table, err)
	}

	return rows, nil
}

// csvCopySource adapts a CSV reader to pgx.CopyFromSource so rows stream
// without materializing the file in memory. At a million rows the difference
// between streaming and buffering is roughly 200MB of resident memory.
type csvCopySource struct {
	reader      *csv.Reader
	columnCount int
	current     []any
	err         error
}

func (s *csvCopySource) Next() bool {
	record, err := s.reader.Read()
	if err == io.EOF {
		return false
	}
	if err != nil {
		s.err = err
		return false
	}
	if len(record) != s.columnCount {
		s.err = fmt.Errorf("expected %d columns, got %d", s.columnCount, len(record))
		return false
	}

	values := make([]any, s.columnCount)
	for i, raw := range record {
		values[i] = coerce(raw)
	}
	s.current = values

	return true
}

func (s *csvCopySource) Values() ([]any, error) { return s.current, s.err }
func (s *csvCopySource) Err() error             { return s.err }

// coerce converts CSV text into the types pgx binds most efficiently.
// Passing everything as string forces Postgres to cast per row, which shows
// up as measurable CPU at volume.
func coerce(raw string) any {
	switch raw {
	case "t":
		return true
	case "f":
		return false
	}

	if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return n
	}

	return raw
}

func (l *PostgresLoader) validateStaging(ctx context.Context, expected int64) error {
	var staged int64
	if err := l.pool.QueryRow(ctx, "SELECT count(*) FROM listings_staging").Scan(&staged); err != nil {
		return fmt.Errorf("count staging: %w", err)
	}

	if staged == 0 {
		return fmt.Errorf("staging table empty; refusing to replace live data")
	}
	if staged != expected {
		return fmt.Errorf("staging holds %d rows, COPY reported %d", staged, expected)
	}

	var orphaned int64
	if err := l.pool.QueryRow(ctx, `
		SELECT count(*) FROM listings_staging s
		WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.product_id = s.product_id)
		   OR NOT EXISTS (SELECT 1 FROM merchants m WHERE m.merchant_id = s.merchant_id)
	`).Scan(&orphaned); err != nil {
		return fmt.Errorf("check orphans: %w", err)
	}

	if orphaned > 0 {
		return fmt.Errorf("%d staged rows reference unknown products or merchants", orphaned)
	}

	return nil
}

// buildReplacementPartitions creates a standalone table per hash bucket,
// populates it from staging, and indexes it. Nothing here touches the live
// partitioned table, so serving continues unaffected.
// buildReplacementPartitions stages a full replacement for every partition.
//
// Index names carry a per-run generation suffix because ALTER TABLE RENAME
// moves a table without renaming its indexes. A second ingest would otherwise
// try to create an index name the first run left attached to the live
// partition, and the rebuild the architecture calls routine would fail on
// every run after the first.
func (l *PostgresLoader) buildReplacementPartitions(ctx context.Context, generation string) error {
	for i := 0; i < ListingPartitions; i++ {
		next := fmt.Sprintf("listings_p%d_next", i)
		prefix := fmt.Sprintf("listings_p%d_%s", i, generation)

		stmts := []string{
			fmt.Sprintf("DROP TABLE IF EXISTS %s", next),
			fmt.Sprintf(`CREATE TABLE %s (LIKE listings INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`, next),
			fmt.Sprintf(`
				INSERT INTO %s (listing_id, product_id, merchant_id, merchant_sku, listing_title,
				                price_cents, currency, in_stock, commission_bps, deep_link_url)
				SELECT listing_id, product_id, merchant_id, merchant_sku, listing_title,
				       price_cents, currency, in_stock, commission_bps, deep_link_url
				FROM listings_staging
				WHERE satisfies_hash_partition('listings'::regclass, %d, %d, merchant_id)
			`, next, ListingPartitions, i),
			fmt.Sprintf(`ALTER TABLE %s ADD CONSTRAINT %s_pkey PRIMARY KEY (listing_id, merchant_id)`, next, prefix),
			fmt.Sprintf(`CREATE UNIQUE INDEX %s_sku_key ON %s (merchant_id, merchant_sku)`, prefix, next),
			fmt.Sprintf(`CREATE INDEX %s_product_idx ON %s (product_id)`, prefix, next),
			fmt.Sprintf(`CREATE INDEX %s_updated_idx ON %s (merchant_id, updated_at DESC)`, prefix, next),
		}

		for _, stmt := range stmts {
			if _, err := l.pool.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("partition %d: %w", i, err)
			}
		}
	}

	return nil
}

// swapPartitions detaches every old partition and attaches its replacement
// inside a single transaction. Readers either see the entire old dataset or
// the entire new one, never a mixture.
func (l *PostgresLoader) swapPartitions(ctx context.Context) error {
	tx, err := l.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for i := 0; i < ListingPartitions; i++ {
		live := fmt.Sprintf("listings_p%d", i)
		next := fmt.Sprintf("listings_p%d_next", i)
		retired := fmt.Sprintf("listings_p%d_prev", i)

		stmts := []string{
			fmt.Sprintf("DROP TABLE IF EXISTS %s", retired),
			fmt.Sprintf("ALTER TABLE listings DETACH PARTITION %s", live),
			fmt.Sprintf("ALTER TABLE %s RENAME TO %s", live, retired),
			fmt.Sprintf("ALTER TABLE %s RENAME TO %s", next, live),
			fmt.Sprintf("ALTER TABLE listings ATTACH PARTITION %s FOR VALUES WITH (MODULUS %d, REMAINDER %d)",
				live, ListingPartitions, i),
		}

		for _, stmt := range stmts {
			if _, err := tx.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("swap partition %d: %w", i, err)
			}
		}
	}

	return tx.Commit(ctx)
}

// DropRetiredPartitions removes the previous generation. Called only after a
// rebuild has served traffic successfully, so rollback stays available in
// between.
func (l *PostgresLoader) DropRetiredPartitions(ctx context.Context) error {
	for i := 0; i < ListingPartitions; i++ {
		stmt := fmt.Sprintf("DROP TABLE IF EXISTS listings_p%d_prev", i)
		if _, err := l.pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("drop retired partition %d: %w", i, err)
		}
	}

	return nil
}
