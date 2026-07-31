package search

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPercentileIndexing(t *testing.T) {
	sorted := make([]time.Duration, 100)
	for i := range sorted {
		sorted[i] = time.Duration(i+1) * time.Millisecond
	}

	cases := []struct {
		p    float64
		want time.Duration
	}{
		{0.50, 50 * time.Millisecond},
		{0.95, 95 * time.Millisecond},
		{0.99, 99 * time.Millisecond},
		{0, 1 * time.Millisecond},
		{1.0, 100 * time.Millisecond},
	}

	for _, tc := range cases {
		if got := percentile(sorted, tc.p); got != tc.want {
			t.Errorf("percentile(%.2f) = %v, want %v", tc.p, got, tc.want)
		}
	}
}

// An empty window must report zero rather than panic on an index into nothing.
// The metrics endpoint gets scraped before the first search lands.
func TestPercentileOfAnEmptyWindow(t *testing.T) {
	if got := percentile(nil, 0.5); got != 0 {
		t.Fatalf("percentile of nothing = %v, want 0", got)
	}
	if got := percentile([]time.Duration{}, 0.99); got != 0 {
		t.Fatalf("percentile of an empty slice = %v, want 0", got)
	}
}

func TestPercentileOfASingleSample(t *testing.T) {
	one := []time.Duration{7 * time.Millisecond}

	for _, p := range []float64{0, 0.5, 0.95, 1.0} {
		if got := percentile(one, p); got != 7*time.Millisecond {
			t.Errorf("percentile(%.2f) of one sample = %v, want 7ms", p, got)
		}
	}
}

func TestSnapshotOfAnUnusedRecorder(t *testing.T) {
	snap := newLatencyRecorder().snapshot()

	if snap != (LatencySnapshot{}) {
		t.Fatalf("an unused recorder reported %+v, want zeroes", snap)
	}
}

func TestSnapshotReportsPercentilesAndTotalCount(t *testing.T) {
	rec := newLatencyRecorder()

	for i := 1; i <= 100; i++ {
		rec.observe(time.Duration(i) * time.Millisecond)
	}

	snap := rec.snapshot()

	if snap.Count != 100 {
		t.Errorf("count = %d, want 100", snap.Count)
	}
	if snap.P50Ms != 50 {
		t.Errorf("p50 = %d, want 50", snap.P50Ms)
	}
	if snap.P99Ms != 99 {
		t.Errorf("p99 = %d, want 99", snap.P99Ms)
	}
	if snap.MaxMs != 100 {
		t.Errorf("max = %d, want 100", snap.MaxMs)
	}
}

// Observations arrive out of order in production. Percentiles have to reflect
// the distribution rather than the arrival sequence.
func TestSnapshotSortsBeforeComputingPercentiles(t *testing.T) {
	rec := newLatencyRecorder()

	for _, ms := range []int{90, 10, 50, 30, 70} {
		rec.observe(time.Duration(ms) * time.Millisecond)
	}

	snap := rec.snapshot()

	if snap.P50Ms != 50 {
		t.Errorf("p50 = %d, want 50 from an unsorted arrival order", snap.P50Ms)
	}
	if snap.MaxMs != 90 {
		t.Errorf("max = %d, want 90", snap.MaxMs)
	}
}

// The window is bounded so a long-running process does not grow without limit,
// and it rotates so the numbers track recent behaviour rather than freezing on
// whatever the first ten thousand requests happened to cost.
func TestTheWindowStaysBoundedWhileTheCountKeepsRising(t *testing.T) {
	rec := newLatencyRecorder()
	capacity := rec.capacity

	for i := 0; i < capacity+500; i++ {
		rec.observe(time.Millisecond)
	}

	if len(rec.samples) != capacity {
		t.Fatalf("window holds %d samples, want it capped at %d", len(rec.samples), capacity)
	}

	snap := rec.snapshot()
	if snap.Count != int64(capacity+500) {
		t.Fatalf("count = %d, want every observation counted (%d)", snap.Count, capacity+500)
	}
}

func TestConcurrentObservationsDoNotRace(t *testing.T) {
	rec := newLatencyRecorder()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				rec.observe(time.Duration(n+j) * time.Microsecond)
			}
			rec.snapshot()
		}(i)
	}
	wg.Wait()

	if snap := rec.snapshot(); snap.Count != 5_000 {
		t.Fatalf("count = %d, want 5000", snap.Count)
	}
}

func newTestHandler(t *testing.T, opensearchURL string) *Handler {
	t.Helper()

	// A nil pool and a nil signer suffice for the paths these tests exercise,
	// since a request rejected during decoding never reaches either.
	return NewHandler(NewService(opensearchURL), nil, nil, discardLogger())
}

func TestRoutesAnswerHealthAndMetrics(t *testing.T) {
	handler := newTestHandler(t, "http://unused")

	for _, path := range []string{"/healthz", "/metrics"} {
		rec := httptest.NewRecorder()
		handler.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
			t.Errorf("GET %s content type = %q", path, ct)
		}
	}
}

func TestMetricsReportsTheLatencySnapshot(t *testing.T) {
	handler := newTestHandler(t, "http://unused")
	handler.latency.observe(25 * time.Millisecond)
	handler.latency.observe(75 * time.Millisecond)

	rec := httptest.NewRecorder()
	handler.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	var snap LatencySnapshot
	if err := json.NewDecoder(rec.Body).Decode(&snap); err != nil {
		t.Fatalf("decode metrics: %v", err)
	}

	if snap.Count != 2 {
		t.Fatalf("count = %d, want 2", snap.Count)
	}
	if snap.MaxMs != 75 {
		t.Fatalf("max = %d, want 75", snap.MaxMs)
	}
}

func TestAMalformedBodyIsRejectedBeforeAnythingElseRuns(t *testing.T) {
	handler := newTestHandler(t, "http://127.0.0.1:1")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/search", strings.NewReader("{not json"))
	handler.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestUnknownPathsAndMethodsDoNotReachTheSearchPath(t *testing.T) {
	handler := newTestHandler(t, "http://127.0.0.1:1")

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/search"},
		{http.MethodPost, "/healthz"},
		{http.MethodPost, "/nope"},
	}

	for _, tc := range cases {
		rec := httptest.NewRecorder()
		handler.Routes().ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}")))

		if rec.Code == http.StatusOK {
			t.Errorf("%s %s returned 200, want a rejection", tc.method, tc.path)
		}
	}
}

// A logger that writes nowhere. Test output stays readable and the handler
// still exercises every log call rather than skipping them behind a nil check.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
