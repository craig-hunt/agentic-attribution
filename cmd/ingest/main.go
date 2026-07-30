package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/craig-hunt/agentic-attribution/internal/ingest"
)

const (
	defaultPostgresDSN = "postgres://agentic:agentic@localhost:5432/agentic?sslmode=disable"
	defaultOpenSearch  = "http://localhost:9200"

	// Ingest opens its own small pool. Serving traffic uses a separate pool so
	// a heavy load cannot starve the search path of connections, which is the
	// resource-isolation principle the architecture rests on.
	ingestPoolSize = 4
)

func main() {
	var (
		postgresDSN  = flag.String("postgres", envOr("POSTGRES_DSN", defaultPostgresDSN), "Postgres connection string")
		openSearchURL = flag.String("opensearch", envOr("OPENSEARCH_URL", defaultOpenSearch), "OpenSearch base URL")
		seedDir      = flag.String("seed", "db/seed", "directory holding the generated CSV files")
		mapping      = flag.String("mapping", "opensearch/products-index.json", "index mapping and settings")
		embedPipe    = flag.String("embed-pipeline", "opensearch/embedding-pipeline.json", "ingest pipeline template")
		searchPipe   = flag.String("search-pipeline", "opensearch/hybrid-search-pipeline.json", "hybrid search pipeline")
		version      = flag.String("version", time.Now().UTC().Format("20060102150405"), "index version suffix")
		skipModel    = flag.Bool("skip-model", false, "reuse an already-registered embedding model")
		dropRetired  = flag.Bool("drop-retired", false, "delete the previous index and partitions after a successful swap")
	)
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := pgxpool.ParseConfig(*postgresDSN)
	if err != nil {
		log.Fatalf("parse postgres dsn: %v", err)
	}
	cfg.MaxConns = ingestPoolSize

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping postgres: %v", err)
	}

	pipeline := ingest.NewPipeline(pool, ingest.NewOpenSearchClient(*openSearchURL), os.Stdout)

	result, err := pipeline.Run(ctx, ingest.Options{
		SeedDir:            *seedDir,
		MappingPath:        *mapping,
		EmbeddingPipeline:  *embedPipe,
		SearchPipelinePath: *searchPipe,
		IndexVersion:       *version,
		SkipModel:          *skipModel,
		DropRetired:        *dropRetired,
	})
	if err != nil {
		log.Fatalf("\ningest failed: %v", err)
	}

	printSummary(result)
}

func printSummary(r ingest.Result) {
	fmt.Printf("\n%s\ningest complete in %s\n%s\n\n",
		divider(), r.Total.Round(time.Millisecond), divider())

	fmt.Printf("%-20s %12s %16s\n", "PHASE", "DURATION", "THROUGHPUT")
	fmt.Println(divider())

	for _, t := range r.Timings {
		throughput := ""
		if t.Rows > 1 {
			throughput = fmt.Sprintf("%.0f rows/sec", t.RowsPerSecond())
		}
		fmt.Printf("%-20s %12s %16s\n", t.Phase, t.Duration.Round(time.Millisecond), throughput)
	}

	fmt.Println(divider())
	fmt.Printf("\nserving index   %s\ndocuments       %d\n", r.IndexName, r.DocumentCount)

	if len(r.RetiredIndex) > 0 {
		fmt.Printf("retained        %v\n", r.RetiredIndex)
	}
}

func divider() string {
	return "------------------------------------------------------"
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
