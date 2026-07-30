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
	"github.com/craig-hunt/agentic-attribution/internal/settlement"
)

const (
	defaultPostgresDSN = "postgres://agentic:agentic@localhost:5432/agentic?sslmode=disable"
	defaultFacilitator = "https://x402.org/facilitator"
	defaultAddr        = ":8082"

	// Smaller than the search pool. Settlement volume is a fraction of query
	// volume, and a settlement holds its connection across a facilitator round
	// trip, so a large pool would tie up connections waiting on the network.
	settlementPoolSize = 8

	shutdownGrace = 30 * time.Second
)

func main() {
	var (
		addr        = flag.String("addr", envOr("SETTLEMENT_ADDR", defaultAddr), "listen address")
		postgresDSN = flag.String("postgres", envOr("POSTGRES_DSN", defaultPostgresDSN), "Postgres connection string")
		facilitator = flag.String("facilitator", envOr("X402_FACILITATOR_URL", defaultFacilitator), "x402 facilitator base URL")
	)
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	publicKey, err := attribution.LoadPublicKey()
	if err != nil {
		log.Fatalf("load verification key: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := pgxpool.ParseConfig(*postgresDSN)
	if err != nil {
		log.Fatalf("parse postgres dsn: %v", err)
	}
	cfg.MaxConns = settlementPoolSize

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Fatalf("connect postgres: %v", err)
	}
	defer pool.Close()

	handler := settlement.NewHandler(
		settlement.NewService(
			settlement.NewStore(pool),
			attribution.NewVerifier(publicKey),
			settlement.NewHTTPFacilitator(*facilitator),
		),
		logger,
	)

	server := &http.Server{
		Addr:              *addr,
		Handler:           handler.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		logger.Info("settlement service listening", "addr", *addr, "facilitator", *facilitator)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	// The grace period exceeds the facilitator timeout so a settlement already
	// in flight finishes and records its outcome rather than leaving a pending
	// row whose on-chain state nobody wrote down.
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
