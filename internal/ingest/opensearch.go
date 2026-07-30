package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// all-MiniLM-L6-v2 emits 384 dimensions, matching the knn_vector mapping
	// in products-index.json. Changing the model requires changing both.
	EmbeddingModel      = "huggingface/sentence-transformers/all-MiniLM-L6-v2"
	EmbeddingModelVer   = "1.0.1"
	EmbeddingDimensions = 384

	ProductsAlias    = "products"
	EmbeddingPipeline = "product-embedding"
	SearchPipeline    = "hybrid-search"

	// Batch size trades round trips against request size and heap pressure.
	// 500 documents with embeddings lands near 5-10MB per request, inside the
	// range OpenSearch handles without GC spikes.
	BulkBatchSize = 500

	// Target replica count restored after load completes. Zero during load
	// because replicas duplicate every indexing operation.
	TargetReplicas = 1
)

type OpenSearchClient struct {
	baseURL string
	http    *http.Client
}

func NewOpenSearchClient(baseURL string) *OpenSearchClient {
	return &OpenSearchClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: 5 * time.Minute},
	}
}

func (c *OpenSearchClient) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader

	if body != nil {
		switch v := body.(type) {
		case []byte:
			reader = bytes.NewReader(v)
		case string:
			reader = strings.NewReader(v)
		default:
			encoded, err := json.Marshal(v)
			if err != nil {
				return nil, fmt.Errorf("marshal body: %w", err)
			}
			reader = bytes.NewReader(encoded)
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s %s returned %d: %s", method, path, resp.StatusCode, truncate(payload, 512))
	}

	return payload, nil
}

func truncate(b []byte, max int) string {
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "..."
}

// EnableLocalModels relaxes the cluster settings ML Commons requires to run a
// model on a node without dedicated ML hardware. Acceptable for a local demo;
// production would run dedicated ML nodes instead.
func (c *OpenSearchClient) EnableLocalModels(ctx context.Context) error {
	settings := map[string]any{
		"persistent": map[string]any{
			"plugins.ml_commons.only_run_on_ml_node":           false,
			"plugins.ml_commons.model_access_control_enabled":  false,
			"plugins.ml_commons.native_memory_threshold":       99,
			"plugins.ml_commons.allow_registering_model_via_url": true,
		},
	}

	_, err := c.do(ctx, http.MethodPut, "/_cluster/settings", settings)
	return err
}

type taskResponse struct {
	TaskID  string `json:"task_id"`
	ModelID string `json:"model_id"`
	State   string `json:"state"`
	Error   string `json:"error"`
}

// RegisterEmbeddingModel pulls the pretrained ONNX model into the cluster and
// deploys it. Returns the model_id the ingest pipeline references.
func (c *OpenSearchClient) RegisterEmbeddingModel(ctx context.Context) (string, error) {
	register := map[string]any{
		"name":     EmbeddingModel,
		"version":  EmbeddingModelVer,
		"model_format": "TORCH_SCRIPT",
	}

	raw, err := c.do(ctx, http.MethodPost, "/_plugins/_ml/models/_register", register)
	if err != nil {
		return "", fmt.Errorf("register model: %w", err)
	}

	var task taskResponse
	if err := json.Unmarshal(raw, &task); err != nil {
		return "", fmt.Errorf("decode register response: %w", err)
	}

	modelID, err := c.awaitTask(ctx, task.TaskID)
	if err != nil {
		return "", fmt.Errorf("await registration: %w", err)
	}

	if _, err := c.do(ctx, http.MethodPost, "/_plugins/_ml/models/"+modelID+"/_deploy", nil); err != nil {
		return "", fmt.Errorf("deploy model: %w", err)
	}

	return modelID, nil
}

// awaitTask polls until the ML task reaches a terminal state. Model download
// and registration commonly take two to five minutes on first run because the
// artifact downloads from Hugging Face.
func (c *OpenSearchClient) awaitTask(ctx context.Context, taskID string) (string, error) {
	const (
		pollInterval = 3 * time.Second
		maxWait      = 15 * time.Minute
	)

	deadline := time.Now().Add(maxWait)

	for time.Now().Before(deadline) {
		raw, err := c.do(ctx, http.MethodGet, "/_plugins/_ml/tasks/"+taskID, nil)
		if err != nil {
			return "", err
		}

		var task taskResponse
		if err := json.Unmarshal(raw, &task); err != nil {
			return "", err
		}

		switch task.State {
		case "COMPLETED":
			return task.ModelID, nil
		case "FAILED":
			return "", fmt.Errorf("task failed: %s", task.Error)
		}

		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(pollInterval):
		}
	}

	return "", fmt.Errorf("task %s did not complete within %s", taskID, maxWait)
}

// CreateEmbeddingPipeline installs the ingest pipeline that generates vectors
// inline during bulk indexing.
func (c *OpenSearchClient) CreateEmbeddingPipeline(ctx context.Context, modelID, template string) error {
	body := strings.ReplaceAll(template, "__MODEL_ID__", modelID)

	_, err := c.do(ctx, http.MethodPut, "/_ingest/pipeline/"+EmbeddingPipeline, body)
	return err
}

// CreateSearchPipeline installs the normalization processor that blends BM25
// and k-NN scores at query time.
func (c *OpenSearchClient) CreateSearchPipeline(ctx context.Context, definition string) error {
	_, err := c.do(ctx, http.MethodPut, "/_search/pipeline/"+SearchPipeline, definition)
	return err
}

// CreateVersionedIndex builds a fresh index with the bulk-load settings
// already applied and the embedding pipeline as its default.
func (c *OpenSearchClient) CreateVersionedIndex(ctx context.Context, name, mapping string) error {
	var body map[string]any
	if err := json.Unmarshal([]byte(mapping), &body); err != nil {
		return fmt.Errorf("parse mapping: %w", err)
	}

	settings, ok := body["settings"].(map[string]any)
	if !ok {
		return fmt.Errorf("mapping lacks a settings object")
	}
	index, ok := settings["index"].(map[string]any)
	if !ok {
		return fmt.Errorf("settings lacks an index object")
	}

	index["default_pipeline"] = EmbeddingPipeline

	if _, err := c.do(ctx, http.MethodDelete, "/"+name, nil); err != nil {
		// A missing index is the expected case on a first run.
		if !strings.Contains(err.Error(), "index_not_found_exception") {
			return fmt.Errorf("drop existing %s: %w", name, err)
		}
	}

	_, err := c.do(ctx, http.MethodPut, "/"+name, body)
	return err
}

type bulkResponse struct {
	Errors bool `json:"errors"`
	Items  []struct {
		Index struct {
			Status int             `json:"status"`
			Error  json.RawMessage `json:"error"`
		} `json:"index"`
	} `json:"items"`
}

// BulkIndex sends one batch using the _bulk endpoint. Errors surface per item,
// so a partial failure is detected rather than silently dropped, which is the
// most common bulk-indexing mistake.
func (c *OpenSearchClient) BulkIndex(ctx context.Context, index string, docs []ProductDocument) error {
	if len(docs) == 0 {
		return nil
	}

	var buf bytes.Buffer

	for _, doc := range docs {
		meta := fmt.Sprintf(`{"index":{"_index":%q,"_id":%q}}`, index, doc.ProductID)
		buf.WriteString(meta)
		buf.WriteByte('\n')

		encoded, err := json.Marshal(doc)
		if err != nil {
			return fmt.Errorf("marshal %s: %w", doc.ProductID, err)
		}
		buf.Write(encoded)
		buf.WriteByte('\n')
	}

	raw, err := c.do(ctx, http.MethodPost, "/_bulk", buf.Bytes())
	if err != nil {
		return err
	}

	var result bulkResponse
	if err := json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("decode bulk response: %w", err)
	}

	if !result.Errors {
		return nil
	}

	for i, item := range result.Items {
		if item.Index.Status >= 300 {
			return fmt.Errorf("bulk item %d failed with %d: %s",
				i, item.Index.Status, truncate(item.Index.Error, 256))
		}
	}

	return fmt.Errorf("bulk reported errors but no item carried a failure status")
}

// FinalizeIndex reverses the bulk-load settings and consolidates segments.
// Order matters: refresh first so documents become visible, then replicas so
// the copy sees a complete index, then force merge on a settled index.
func (c *OpenSearchClient) FinalizeIndex(ctx context.Context, index string) error {
	restore := map[string]any{
		"index": map[string]any{
			"refresh_interval":     "1s",
			"number_of_replicas":   TargetReplicas,
			"translog.durability":  "request",
		},
	}

	if _, err := c.do(ctx, http.MethodPut, "/"+index+"/_settings", restore); err != nil {
		return fmt.Errorf("restore settings: %w", err)
	}

	if _, err := c.do(ctx, http.MethodPost, "/"+index+"/_refresh", nil); err != nil {
		return fmt.Errorf("refresh: %w", err)
	}

	// Force merge only ever runs against an index that has stopped receiving
	// writes. Against a live write target it degrades performance instead of
	// improving it.
	if _, err := c.do(ctx, http.MethodPost, "/"+index+"/_forcemerge?max_num_segments=1", nil); err != nil {
		return fmt.Errorf("force merge: %w", err)
	}

	return nil
}

func (c *OpenSearchClient) CountDocuments(ctx context.Context, index string) (int64, error) {
	raw, err := c.do(ctx, http.MethodGet, "/"+index+"/_count", nil)
	if err != nil {
		return 0, err
	}

	var result struct {
		Count int64 `json:"count"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return 0, err
	}

	return result.Count, nil
}

// SwapAlias repoints the serving alias in a single atomic action. Queries in
// flight complete against whichever index they started on; nothing observes an
// intermediate state where the alias resolves to nothing.
func (c *OpenSearchClient) SwapAlias(ctx context.Context, newIndex string) (retired []string, err error) {
	current, err := c.indicesForAlias(ctx, ProductsAlias)
	if err != nil {
		return nil, err
	}

	actions := []map[string]any{
		{"add": map[string]any{"index": newIndex, "alias": ProductsAlias}},
	}
	for _, old := range current {
		if old == newIndex {
			continue
		}
		actions = append(actions, map[string]any{
			"remove": map[string]any{"index": old, "alias": ProductsAlias},
		})
		retired = append(retired, old)
	}

	body := map[string]any{"actions": actions}
	if _, err := c.do(ctx, http.MethodPost, "/_aliases", body); err != nil {
		return nil, fmt.Errorf("swap alias: %w", err)
	}

	return retired, nil
}

func (c *OpenSearchClient) indicesForAlias(ctx context.Context, alias string) ([]string, error) {
	raw, err := c.do(ctx, http.MethodGet, "/_alias/"+alias, nil)
	if err != nil {
		// No alias yet on a first run.
		if strings.Contains(err.Error(), "alias_not_found") || strings.Contains(err.Error(), "404") {
			return nil, nil
		}
		return nil, err
	}

	var mapping map[string]any
	if err := json.Unmarshal(raw, &mapping); err != nil {
		return nil, err
	}

	indices := make([]string, 0, len(mapping))
	for name := range mapping {
		indices = append(indices, name)
	}

	return indices, nil
}

func (c *OpenSearchClient) DeleteIndex(ctx context.Context, index string) error {
	_, err := c.do(ctx, http.MethodDelete, "/"+index, nil)
	return err
}

// WaitForCluster blocks until OpenSearch answers, which matters in
// docker-compose where the service starts slower than its dependents.
func (c *OpenSearchClient) WaitForCluster(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		if _, err := c.do(ctx, http.MethodGet, "/_cluster/health?wait_for_status=yellow&timeout=5s", nil); err == nil {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}

	return fmt.Errorf("cluster did not become available within %s", timeout)
}
