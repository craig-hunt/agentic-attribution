package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
	"github.com/craig-hunt/agentic-attribution/internal/search"
)

const (
	defaultPostgresDSN = "postgres://agentic:agentic@localhost:5432/agentic?sslmode=disable"
	defaultOpenSearch  = "http://localhost:9200"
	defaultAddr        = ":8081"

	// The serving pool is sized independently of ingest. Separate pools mean a
	// bulk load cannot exhaust connections the search path needs, which is the
	// resource isolation the architecture depends on.
	servingPoolSize = 20

	shutdownGrace = 10 * time.Second
)

func main() {
	var (
		addr          = flag.String("addr", envOr("SEARCH_ADDR", defaultAddr), "listen address")
		postgresDSN   = flag.String("postgres", envOr("POSTGRES_DSN", defaultPostgresDSN), "Postgres connection string")
		openSearchURL = flag.String("opensearch", envOr("OPENSEARCH_URL", defaultOpenSearch), "OpenSearch base URL")
	)
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	privateKey, err := attribution.LoadPrivateKey()
	if err != nil {
		log.Fatalf("load signing key: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := pgxpool.ParseConfig(*postgresDSN)
	if err != nil {
		log.Fatalf("parse postgres dsn: %v", err)
	}
	cfg.MaxConns = servingPoolSize

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer pool.Close()

	handler := search.NewHandler(
		search.NewService(*openSearchURL),
		pool,
		attribution.NewSigner(privateKey),
		logger,
	)

	server := &http.Server{
		Addr:              *addr,
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("search service listening", "addr", *addr, "opensearch", *openSearchURL)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
