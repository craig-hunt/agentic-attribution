package search

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

// Assertions are minted in process rather than through a call to the
// attribution service. Minting sits directly on the sub-100ms path, so an
// extra network hop would consume budget for no benefit. Verification runs in
// the separate attribution service because merchants call it and it carries no
// latency budget.
type Handler struct {
	svc     *Service
	pool    *pgxpool.Pool
	signer  *attribution.Signer
	latency *latencyRecorder
	log     *slog.Logger
}

func NewHandler(svc *Service, pool *pgxpool.Pool, signer *attribution.Signer, log *slog.Logger) *Handler {
	return &Handler{
		svc:     svc,
		pool:    pool,
		signer:  signer,
		latency: newLatencyRecorder(),
		log:     log,
	}
}

type searchPayload struct {
	Request
	PublisherID string `json:"publisher_id"`
}

type searchResult struct {
	SearchRequestID string                  `json:"search_request_id"`
	Query           string                  `json:"query"`
	LatencyMillis   int64                   `json:"latency_ms"`
	SearchTookMs    int                     `json:"opensearch_took_ms"`
	TotalHits       int64                   `json:"total_hits"`
	Products        []Product               `json:"products"`
	Assertions      []attribution.Assertion `json:"assertions"`
}

func (h *Handler) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /search", h.handleSearch)
	mux.HandleFunc("GET /healthz", h.handleHealth)
	mux.HandleFunc("GET /metrics", h.handleMetrics)

	return mux
}

func (h *Handler) handleSearch(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	var payload searchPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}

	if payload.Query == "" {
		writeError(w, http.StatusBadRequest, "query is required")
		return
	}
	if payload.PublisherID == "" {
		writeError(w, http.StatusBadRequest, "publisher_id is required")
		return
	}

	results, err := h.svc.Search(r.Context(), payload.Request)
	if err != nil {
		h.log.Error("search failed", "query", payload.Query, "error", err)
		writeError(w, http.StatusBadGateway, "search unavailable")
		return
	}

	searchRequestID := "req_" + uuid.NewString()

	assertions, err := h.mintAssertions(searchRequestID, payload.PublisherID, results.Products)
	if err != nil {
		h.log.Error("mint assertions failed", "error", err)
		writeError(w, http.StatusInternalServerError, "could not mint attribution")
		return
	}

	elapsed := time.Since(start)
	h.latency.observe(elapsed)

	// The search record is written asynchronously. Blocking the response on a
	// Postgres insert would put the write path back onto the latency budget
	// the whole architecture exists to protect.
	go h.recordSearch(searchRequestID, payload.PublisherID, payload.Query, len(results.Products), elapsed)

	writeJSON(w, http.StatusOK, searchResult{
		SearchRequestID: searchRequestID,
		Query:           results.Query,
		LatencyMillis:   elapsed.Milliseconds(),
		SearchTookMs:    results.TookMillis,
		TotalHits:       results.TotalHits,
		Products:        results.Products,
		Assertions:      assertions,
	})
}

// mintAssertions issues one assertion per returned product. The agent may
// transact on any of them, and each carries the commission rate the best offer
// advertises so the merchant cannot reduce it after the fact.
func (h *Handler) mintAssertions(
	searchRequestID, publisherID string,
	products []Product,
) ([]attribution.Assertion, error) {
	issuedAt := time.Now().UTC()
	out := make([]attribution.Assertion, 0, len(products))

	for _, p := range products {
		a, err := h.signer.Mint(
			uuid.NewString(),
			publisherID,
			p.ProductID,
			searchRequestID,
			p.MaxCommissionBps,
			issuedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("mint for %s: %w", p.ProductID, err)
		}
		out = append(out, a)
	}

	return out, nil
}

func (h *Handler) recordSearch(id, publisherID, query string, resultCount int, elapsed time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := h.pool.Exec(ctx, `
		INSERT INTO search_requests (search_request_id, publisher_id, query_text, result_count, latency_ms)
		VALUES ($1, $2, $3, $4, $5)
	`, id, publisherID, query, resultCount, elapsed.Milliseconds())

	if err != nil {
		h.log.Warn("record search failed", "search_request_id", id, "error", err)
	}
}

func (h *Handler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleMetrics reports the percentile distribution rather than an average.
// An average hides the tail, and the tail is what a customer making a hundred
// calls per page actually experiences.
func (h *Handler) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, h.latency.snapshot())
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// latencyRecorder keeps a bounded reservoir of observations. A full histogram
// library would be the production answer; this stays dependency-free while
// still reporting real percentiles.
type latencyRecorder struct {
	mu       sync.Mutex
	samples  []time.Duration
	total    int64
	capacity int
}

func newLatencyRecorder() *latencyRecorder {
	const capacity = 10_000
	return &latencyRecorder{
		samples:  make([]time.Duration, 0, capacity),
		capacity: capacity,
	}
}

func (l *latencyRecorder) observe(d time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.total++

	if len(l.samples) < l.capacity {
		l.samples = append(l.samples, d)
		return
	}

	// Once full, overwrite in a rotating position so the window tracks recent
	// behavior rather than freezing on startup measurements.
	l.samples[int(l.total)%l.capacity] = d
}

type LatencySnapshot struct {
	Count int64 `json:"count"`
	P50Ms int64 `json:"p50_ms"`
	P95Ms int64 `json:"p95_ms"`
	P99Ms int64 `json:"p99_ms"`
	MaxMs int64 `json:"max_ms"`
}

func (l *latencyRecorder) snapshot() LatencySnapshot {
	l.mu.Lock()
	sorted := make([]time.Duration, len(l.samples))
	copy(sorted, l.samples)
	total := l.total
	l.mu.Unlock()

	if len(sorted) == 0 {
		return LatencySnapshot{}
	}

	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	return LatencySnapshot{
		Count: total,
		P50Ms: percentile(sorted, 0.50).Milliseconds(),
		P95Ms: percentile(sorted, 0.95).Milliseconds(),
		P99Ms: percentile(sorted, 0.99).Milliseconds(),
		MaxMs: sorted[len(sorted)-1].Milliseconds(),
	}
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}

	idx := int(float64(len(sorted)-1) * p)
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}

	return sorted[idx]
}
