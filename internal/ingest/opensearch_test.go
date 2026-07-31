package ingest

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type recordedCall struct {
	method string
	path   string
	body   string
}

// fakeCluster answers whatever each path needs and records what arrived. The
// ingest client's correctness is almost entirely about which requests it makes
// and in what order, so the recording is the assertion surface.
type fakeCluster struct {
	t        *testing.T
	server   *httptest.Server
	calls    []recordedCall
	handlers map[string]http.HandlerFunc
}

func newFakeCluster(t *testing.T) *fakeCluster {
	t.Helper()

	c := &fakeCluster{t: t, handlers: map[string]http.HandlerFunc{}}

	c.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c.calls = append(c.calls, recordedCall{r.Method, r.URL.String(), string(body)})

		for prefix, handler := range c.handlers {
			if strings.HasPrefix(r.URL.Path, prefix) {
				handler(w, r)
				return
			}
		}

		_, _ = w.Write([]byte(`{"acknowledged":true}`))
	}))
	t.Cleanup(c.server.Close)

	return c
}

func (c *fakeCluster) on(prefix string, status int, body string) {
	c.handlers[prefix] = func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func (c *fakeCluster) client() *OpenSearchClient { return NewOpenSearchClient(c.server.URL) }

func (c *fakeCluster) paths() []string {
	out := make([]string, 0, len(c.calls))
	for _, call := range c.calls {
		out = append(out, call.method+" "+call.path)
	}

	return out
}

func TestNewClientTrimsTrailingSlashes(t *testing.T) {
	cluster := newFakeCluster(t)

	client := NewOpenSearchClient(cluster.server.URL + "///")
	if _, err := client.CountDocuments(context.Background(), "products_v1"); err != nil {
		t.Fatalf("CountDocuments: %v", err)
	}

	// A doubled slash would produce //products_v1/_count, which OpenSearch
	// answers with a 400 rather than a count.
	if got := cluster.calls[0].path; strings.HasPrefix(got, "//") {
		t.Fatalf("path = %q, want no doubled slash", got)
	}
}

func TestCountDocuments(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/products_v1/_count", http.StatusOK, `{"count":150000}`)

	count, err := cluster.client().CountDocuments(context.Background(), "products_v1")
	if err != nil {
		t.Fatalf("CountDocuments: %v", err)
	}
	if count != 150_000 {
		t.Fatalf("count = %d, want 150000", count)
	}
}

func TestAnErrorStatusCarriesTheClusterResponse(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/products_v1/_count", http.StatusNotFound,
		`{"error":{"type":"index_not_found_exception","reason":"no such index"}}`)

	_, err := cluster.client().CountDocuments(context.Background(), "products_v1")
	if err == nil {
		t.Fatal("CountDocuments succeeded against a 404")
	}
	if !strings.Contains(err.Error(), "index_not_found_exception") {
		t.Fatalf("error discards the cluster's explanation: %v", err)
	}
}

func TestBulkIndexSendsNewlineDelimitedPairs(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_bulk", http.StatusOK, `{"errors":false,"items":[]}`)

	docs := []ProductDocument{
		{ProductID: "prd_1", CanonicalTitle: "Trail Runner"},
		{ProductID: "prd_2", CanonicalTitle: "Road Runner"},
	}

	if err := cluster.client().BulkIndex(context.Background(), "products_v1", docs); err != nil {
		t.Fatalf("BulkIndex: %v", err)
	}

	body := cluster.calls[0].body
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")

	// The bulk format alternates action metadata and document, so two
	// documents must produce exactly four lines.
	if len(lines) != 4 {
		t.Fatalf("sent %d lines for 2 documents, want 4:\n%s", len(lines), body)
	}
	if !strings.Contains(lines[0], `"_index":"products_v1"`) || !strings.Contains(lines[0], `"_id":"prd_1"`) {
		t.Errorf("first action line = %s", lines[0])
	}
	if !strings.Contains(lines[1], "Trail Runner") {
		t.Errorf("first document line = %s", lines[1])
	}

	// Every line has to be independently valid JSON, because OpenSearch parses
	// them one at a time rather than as a document.
	for i, line := range lines {
		var probe map[string]any
		if err := json.Unmarshal([]byte(line), &probe); err != nil {
			t.Errorf("line %d is not valid JSON: %v", i, err)
		}
	}
}

// A bulk request answers 200 while individual documents fail inside it.
// Treating the status alone as success would silently drop documents and
// produce an index quietly missing rows.
func TestBulkIndexDetectsPerItemFailures(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_bulk", http.StatusOK, `{
		"errors": true,
		"items": [
			{"index":{"status":201}},
			{"index":{"status":400,"error":{"type":"mapper_parsing_exception","reason":"bad vector"}}}
		]
	}`)

	err := cluster.client().BulkIndex(context.Background(), "products_v1",
		[]ProductDocument{{ProductID: "prd_1"}, {ProductID: "prd_2"}})

	if err == nil {
		t.Fatal("BulkIndex reported success despite a failed item inside a 200")
	}
	if !strings.Contains(err.Error(), "mapper_parsing_exception") {
		t.Fatalf("error discards the item's reason: %v", err)
	}
	if !strings.Contains(err.Error(), "1") {
		t.Fatalf("error does not identify which item failed: %v", err)
	}
}

// errors:true with every item reporting success means the response shape has
// changed under us. Reporting that beats returning nil and losing documents.
func TestBulkIndexReportsAnUnexplainedErrorFlag(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_bulk", http.StatusOK, `{"errors":true,"items":[{"index":{"status":201}}]}`)

	err := cluster.client().BulkIndex(context.Background(), "products_v1",
		[]ProductDocument{{ProductID: "prd_1"}})

	if err == nil {
		t.Fatal("BulkIndex accepted errors:true with no failing item")
	}
}

func TestBulkIndexSkipsAnEmptyBatch(t *testing.T) {
	cluster := newFakeCluster(t)

	if err := cluster.client().BulkIndex(context.Background(), "products_v1", nil); err != nil {
		t.Fatalf("BulkIndex on nothing: %v", err)
	}
	if len(cluster.calls) != 0 {
		t.Fatalf("an empty batch issued %d requests", len(cluster.calls))
	}
}

// Order carries the correctness argument. Refresh makes documents visible,
// then restoring replicas copies a complete index, then force merge runs
// against an index that has settled. Any other order wastes work or copies an
// incomplete index.
func TestFinalizeIndexRestoresSettingsThenRefreshesThenMerges(t *testing.T) {
	cluster := newFakeCluster(t)

	if err := cluster.client().FinalizeIndex(context.Background(), "products_v1"); err != nil {
		t.Fatalf("FinalizeIndex: %v", err)
	}

	paths := cluster.paths()
	if len(paths) != 3 {
		t.Fatalf("issued %d requests, want 3: %v", len(paths), paths)
	}

	if !strings.Contains(paths[0], "_settings") {
		t.Errorf("first call = %s, want the settings restore", paths[0])
	}
	if !strings.Contains(paths[1], "_refresh") {
		t.Errorf("second call = %s, want the refresh", paths[1])
	}
	if !strings.Contains(paths[2], "_forcemerge") {
		t.Errorf("third call = %s, want the force merge", paths[2])
	}
	if !strings.Contains(paths[2], "max_num_segments=1") {
		t.Errorf("force merge does not consolidate to one segment: %s", paths[2])
	}

	var restored struct {
		Index map[string]any `json:"index"`
	}
	if err := json.Unmarshal([]byte(cluster.calls[0].body), &restored); err != nil {
		t.Fatalf("decode settings: %v", err)
	}

	// Bulk load disables refresh and drops replicas to zero. Leaving either in
	// that state would serve a single-copy index that never becomes searchable.
	if restored.Index["refresh_interval"] != "1s" {
		t.Errorf("refresh_interval = %v, want it restored", restored.Index["refresh_interval"])
	}
	if restored.Index["number_of_replicas"] != float64(TargetReplicas) {
		t.Errorf("replicas = %v, want %d", restored.Index["number_of_replicas"], TargetReplicas)
	}
	if restored.Index["translog.durability"] != "request" {
		t.Errorf("translog durability = %v, want it restored", restored.Index["translog.durability"])
	}
}

func TestFinalizeIndexStopsAtTheFirstFailure(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/products_v1/_settings", http.StatusInternalServerError, `{"error":"nope"}`)

	if err := cluster.client().FinalizeIndex(context.Background(), "products_v1"); err == nil {
		t.Fatal("FinalizeIndex succeeded despite a failed settings restore")
	}

	// Refreshing and merging an index whose settings never restored would
	// leave it in the load configuration while reporting success.
	if len(cluster.calls) != 1 {
		t.Fatalf("issued %d requests after a failure, want 1: %v", len(cluster.calls), cluster.paths())
	}
}

// The swap is a single atomic action carrying both the add and the removes.
// Splitting it into two requests would leave a window where the alias resolves
// to nothing and every search returns an index_not_found.
func TestSwapAliasAddsAndRemovesInOneAction(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_alias/"+ProductsAlias, http.StatusOK, `{"products_v1":{"aliases":{"products":{}}}}`)

	retired, err := cluster.client().SwapAlias(context.Background(), "products_v2")
	if err != nil {
		t.Fatalf("SwapAlias: %v", err)
	}

	if len(retired) != 1 || retired[0] != "products_v1" {
		t.Fatalf("retired = %v, want [products_v1]", retired)
	}

	var body struct {
		Actions []map[string]map[string]string `json:"actions"`
	}
	if err := json.Unmarshal([]byte(cluster.calls[1].body), &body); err != nil {
		t.Fatalf("decode actions: %v", err)
	}

	if len(body.Actions) != 2 {
		t.Fatalf("sent %d actions, want an add and a remove together", len(body.Actions))
	}
	if body.Actions[0]["add"]["index"] != "products_v2" {
		t.Errorf("add action = %v", body.Actions[0])
	}
	if body.Actions[1]["remove"]["index"] != "products_v1" {
		t.Errorf("remove action = %v", body.Actions[1])
	}
}

// The first ingest has no alias to move. A 404 there is the expected state
// rather than a failure, so the swap proceeds with an add and no removes.
func TestSwapAliasHandlesAFirstRunWithNoExistingAlias(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_alias/"+ProductsAlias, http.StatusNotFound,
		`{"error":{"type":"alias_not_found_exception","reason":"missing"}}`)

	retired, err := cluster.client().SwapAlias(context.Background(), "products_v1")
	if err != nil {
		t.Fatalf("SwapAlias on a first run: %v", err)
	}
	if len(retired) != 0 {
		t.Fatalf("retired = %v, want nothing on a first run", retired)
	}

	var body struct {
		Actions []map[string]map[string]string `json:"actions"`
	}
	if err := json.Unmarshal([]byte(cluster.calls[1].body), &body); err != nil {
		t.Fatalf("decode actions: %v", err)
	}
	if len(body.Actions) != 1 || body.Actions[0]["add"] == nil {
		t.Fatalf("actions = %v, want a single add", body.Actions)
	}
}

// Re-pointing the alias at the index it already names must not emit a remove
// for that same index, which would delete the alias it just added.
func TestSwapAliasNeverRemovesTheIndexItIsAdding(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_alias/"+ProductsAlias, http.StatusOK, `{"products_v2":{"aliases":{"products":{}}}}`)

	retired, err := cluster.client().SwapAlias(context.Background(), "products_v2")
	if err != nil {
		t.Fatalf("SwapAlias: %v", err)
	}
	if len(retired) != 0 {
		t.Fatalf("retired = %v, want nothing when the alias already points there", retired)
	}

	if strings.Contains(cluster.calls[1].body, `"remove"`) {
		t.Fatalf("the swap would remove the alias it just added: %s", cluster.calls[1].body)
	}
}

func TestDeleteIndex(t *testing.T) {
	cluster := newFakeCluster(t)

	if err := cluster.client().DeleteIndex(context.Background(), "products_v0"); err != nil {
		t.Fatalf("DeleteIndex: %v", err)
	}

	if got := cluster.paths()[0]; got != "DELETE /products_v0" {
		t.Fatalf("issued %q", got)
	}
}

func TestCreatePipelinesPutTheirDefinitions(t *testing.T) {
	cluster := newFakeCluster(t)
	client := cluster.client()
	ctx := context.Background()

	if err := client.CreateEmbeddingPipeline(ctx, "model_1", `{"processors":[{"__MODEL_ID__":"x"}]}`); err != nil {
		t.Fatalf("CreateEmbeddingPipeline: %v", err)
	}
	if err := client.CreateSearchPipeline(ctx, `{"phase_results_processors":[]}`); err != nil {
		t.Fatalf("CreateSearchPipeline: %v", err)
	}

	paths := cluster.paths()
	if !strings.Contains(paths[0], EmbeddingPipeline) {
		t.Errorf("embedding pipeline path = %s", paths[0])
	}
	if !strings.Contains(paths[1], SearchPipeline) {
		t.Errorf("search pipeline path = %s", paths[1])
	}

	// The template carries a placeholder the client substitutes. Shipping it
	// unsubstituted produces a pipeline referencing a model that cannot exist.
	if strings.Contains(cluster.calls[0].body, "__MODEL_ID__") {
		t.Errorf("the model placeholder survived into the request: %s", cluster.calls[0].body)
	}
	if !strings.Contains(cluster.calls[0].body, "model_1") {
		t.Errorf("the resolved model id did not reach the pipeline: %s", cluster.calls[0].body)
	}
}

func TestWaitForClusterReturnsOnceTheClusterAnswers(t *testing.T) {
	cluster := newFakeCluster(t)

	if err := cluster.client().WaitForCluster(context.Background(), 5*time.Second); err != nil {
		t.Fatalf("WaitForCluster: %v", err)
	}
	if len(cluster.calls) == 0 {
		t.Fatal("WaitForCluster returned without contacting the cluster")
	}
}

func TestWaitForClusterGivesUpOnAnUnreachableCluster(t *testing.T) {
	client := NewOpenSearchClient("http://127.0.0.1:1")

	if err := client.WaitForCluster(context.Background(), 300*time.Millisecond); err == nil {
		t.Fatal("WaitForCluster succeeded against an unreachable cluster")
	}
}

func TestRequestsHonourACancelledContext(t *testing.T) {
	cluster := newFakeCluster(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := cluster.client().CountDocuments(ctx, "products_v1"); err == nil {
		t.Fatal("the request ignored a cancelled context")
	}
}
