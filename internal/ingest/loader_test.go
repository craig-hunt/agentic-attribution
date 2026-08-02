package ingest

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/craig-hunt/agentic-attribution/internal/generator"
	"github.com/craig-hunt/agentic-attribution/internal/testsupport"
)

func seedDirFor(t *testing.T, cfg generator.Config) string {
	t.Helper()

	dir := t.TempDir()
	if _, err := generator.WriteCSV(generator.Generate(cfg), dir); err != nil {
		t.Fatalf("write seed: %v", err)
	}

	return dir
}

func loadAll(t *testing.T, pool *pgxpool.Pool, dir string) *PostgresLoader {
	t.Helper()

	loader := NewPostgresLoader(pool)
	ctx := context.Background()

	if _, err := loader.LoadReference(ctx, dir); err != nil {
		t.Fatalf("LoadReference: %v", err)
	}
	if _, err := loader.LoadListings(ctx, dir); err != nil {
		t.Fatalf("LoadListings: %v", err)
	}

	return loader
}

func count(t *testing.T, pool *pgxpool.Pool, table string) int64 {
	t.Helper()

	var n int64
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}

	return n
}

func TestLoadReferenceAndListingsLandEveryRow(t *testing.T) {
	pool := testsupport.Postgres(t)

	cfg := generator.Config{Seed: 42, CanonicalProducts: 120, MerchantCount: 8, PublisherCount: 4}
	catalog := generator.Generate(cfg)
	dir := seedDirFor(t, cfg)

	loadAll(t, pool, dir)

	if got := count(t, pool, "merchants"); got != int64(len(catalog.Merchants)) {
		t.Errorf("merchants = %d, want %d", got, len(catalog.Merchants))
	}
	if got := count(t, pool, "publishers"); got != int64(len(catalog.Publishers)) {
		t.Errorf("publishers = %d, want %d", got, len(catalog.Publishers))
	}
	if got := count(t, pool, "products"); got != int64(len(catalog.Products)) {
		t.Errorf("products = %d, want %d", got, len(catalog.Products))
	}
	if got := count(t, pool, "listings"); got != int64(len(catalog.Listings)) {
		t.Errorf("listings = %d, want %d", got, len(catalog.Listings))
	}
}

// Listings are hash-partitioned by merchant. A load that dropped every row
// into one partition would still count correctly while destroying the
// pruning the partitioning exists to provide.
func TestListingsDistributeAcrossPartitions(t *testing.T) {
	pool := testsupport.Postgres(t)
	cfg := generator.Config{Seed: 42, CanonicalProducts: 200, MerchantCount: 12, PublisherCount: 3}

	loadAll(t, pool, seedDirFor(t, cfg))

	rows, err := pool.Query(context.Background(), `
		SELECT tableoid::regclass::text, count(*)
		FROM listings GROUP BY 1 ORDER BY 1`)
	if err != nil {
		t.Fatalf("query partitions: %v", err)
	}
	defer rows.Close()

	populated := 0
	for rows.Next() {
		var partition string
		var n int64
		if err := rows.Scan(&partition, &n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if n > 0 {
			populated++
		}
	}

	if populated < 4 {
		t.Fatalf("only %d partitions carry rows; the hash is not distributing", populated)
	}
}

// The whole point of the staging-and-swap design: a reload replaces the live
// data atomically rather than deleting and reinserting, and the row count after
// a second load matches the first rather than doubling.
func TestReloadingReplacesRatherThanAppends(t *testing.T) {
	pool := testsupport.Postgres(t)
	cfg := generator.Config{Seed: 42, CanonicalProducts: 100, MerchantCount: 6, PublisherCount: 3}
	dir := seedDirFor(t, cfg)

	loadAll(t, pool, dir)
	first := count(t, pool, "listings")

	loadAll(t, pool, dir)
	second := count(t, pool, "listings")

	if first != second {
		t.Fatalf("listings went from %d to %d across an identical reload", first, second)
	}
	if first == 0 {
		t.Fatal("the first load produced nothing")
	}
}

// Reference tables upsert rather than swap, so a changed catalog updates rows
// in place instead of accumulating duplicates against the primary key.
func TestReferenceDataUpsertsOnReload(t *testing.T) {
	pool := testsupport.Postgres(t)
	cfg := generator.Config{Seed: 42, CanonicalProducts: 50, MerchantCount: 5, PublisherCount: 2}
	dir := seedDirFor(t, cfg)

	loader := NewPostgresLoader(pool)
	ctx := context.Background()

	if _, err := loader.LoadReference(ctx, dir); err != nil {
		t.Fatalf("first LoadReference: %v", err)
	}
	before := count(t, pool, "products")

	if _, err := loader.LoadReference(ctx, dir); err != nil {
		t.Fatalf("second LoadReference: %v", err)
	}

	if after := count(t, pool, "products"); after != before {
		t.Fatalf("products went from %d to %d across a reload", before, after)
	}
}

func TestLoadReportsPhaseTimings(t *testing.T) {
	pool := testsupport.Postgres(t)
	cfg := generator.Config{Seed: 42, CanonicalProducts: 60, MerchantCount: 5, PublisherCount: 2}
	dir := seedDirFor(t, cfg)

	loader := NewPostgresLoader(pool)
	ctx := context.Background()

	reference, err := loader.LoadReference(ctx, dir)
	if err != nil {
		t.Fatalf("LoadReference: %v", err)
	}
	if len(reference) != 3 {
		t.Fatalf("reference reported %d phases, want merchants, publishers, and products", len(reference))
	}

	listings, err := loader.LoadListings(ctx, dir)
	if err != nil {
		t.Fatalf("LoadListings: %v", err)
	}
	if len(listings) == 0 {
		t.Fatal("the listings load reported no phases")
	}

	for _, timing := range append(reference, listings...) {
		if timing.Phase == "" {
			t.Errorf("a phase reported no name: %+v", timing)
		}
		if timing.Duration < 0 {
			t.Errorf("%s reported a negative duration", timing.Phase)
		}
	}
}

func TestRowsPerSecond(t *testing.T) {
	cases := []struct {
		name   string
		timing PhaseTiming
		want   float64
	}{
		{"ordinary rate", PhaseTiming{Rows: 1_000, Duration: time.Second}, 1_000},
		{"half a second", PhaseTiming{Rows: 500, Duration: 500 * time.Millisecond}, 1_000},
		// A zero duration would divide by zero and report +Inf, which then
		// formats into a benchmark table as garbage.
		{"zero duration", PhaseTiming{Rows: 1_000, Duration: 0}, 0},
		{"negative duration", PhaseTiming{Rows: 1_000, Duration: -time.Second}, 0},
		{"no rows", PhaseTiming{Rows: 0, Duration: time.Second}, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.timing.RowsPerSecond(); got != tc.want {
				t.Fatalf("RowsPerSecond = %v, want %v", got, tc.want)
			}
		})
	}
}

// Refusing to swap in an empty staging table is what stops a truncated or
// missing seed file from silently wiping the live catalog.
func TestLoadListingsRefusesAnEmptySeed(t *testing.T) {
	pool := testsupport.Postgres(t)

	empty := t.TempDir()
	if _, err := generator.WriteCSV(generator.Catalog{}, empty); err != nil {
		t.Fatalf("write empty seed: %v", err)
	}

	loader := NewPostgresLoader(pool)
	if _, err := loader.LoadListings(context.Background(), empty); err == nil {
		t.Fatal("LoadListings accepted an empty staging table and would have replaced live data")
	}
}

func TestLoadReportsAMissingSeedDirectory(t *testing.T) {
	pool := testsupport.Postgres(t)
	loader := NewPostgresLoader(pool)
	ctx := context.Background()

	if _, err := loader.LoadReference(ctx, "/nonexistent/seed/dir"); err == nil {
		t.Error("LoadReference succeeded against a missing directory")
	}
	if _, err := loader.LoadListings(ctx, "/nonexistent/seed/dir"); err == nil {
		t.Error("LoadListings succeeded against a missing directory")
	}
}

func TestDocumentSourceStreamsProductsWithTheirOffers(t *testing.T) {
	pool := testsupport.Postgres(t)
	cfg := generator.Config{Seed: 42, CanonicalProducts: 40, MerchantCount: 6, PublisherCount: 2}

	loadAll(t, pool, seedDirFor(t, cfg))

	source := NewDocumentSource(pool)
	ctx := context.Background()

	total, err := source.CountProducts(ctx)
	if err != nil {
		t.Fatalf("CountProducts: %v", err)
	}
	if total != 40 {
		t.Fatalf("CountProducts = %d, want 40", total)
	}

	var seen int
	ids := make(map[string]bool)

	// A small batch size on purpose: grouping runs in constant memory by
	// relying on the query's ordering, so a product whose offers straddle a
	// batch boundary is exactly the failure worth forcing.
	streamed, err := source.Stream(ctx, 7, func(docs []ProductDocument) error {
		for _, doc := range docs {
			seen++

			// Grouping runs in constant memory by relying on the query's
			// ordering, so a product appearing twice means a group split across
			// batch boundaries and an index missing offers. Returning early
			// here would end the batch quietly and let the run pass.
			if ids[doc.ProductID] {
				t.Errorf("%s streamed twice, so its offers split across batches", doc.ProductID)
			}
			ids[doc.ProductID] = true

			if len(doc.Offers) == 0 {
				t.Errorf("%s carries no offers", doc.ProductID)
			}
			if doc.CanonicalTitle == "" {
				t.Errorf("%s carries no title", doc.ProductID)
			}
		}

		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	if streamed != 40 {
		t.Fatalf("Stream reported %d documents, want 40", streamed)
	}
	if seen != 40 {
		t.Fatalf("the callback saw %d documents, want 40", seen)
	}
	if len(ids) != 40 {
		t.Fatalf("streamed %d distinct products across %d documents; a group split across batches",
			len(ids), seen)
	}
}

func TestDocumentSourceRollsUpOfferAggregates(t *testing.T) {
	pool := testsupport.Postgres(t)
	cfg := generator.Config{Seed: 42, CanonicalProducts: 30, MerchantCount: 6, PublisherCount: 2}

	loadAll(t, pool, seedDirFor(t, cfg))

	_, err := NewDocumentSource(pool).Stream(context.Background(), 100, func(docs []ProductDocument) error {
		for _, doc := range docs {
			cheapest := doc.Offers[0].PriceCents
			best := doc.Offers[0].CommissionBps
			anyInStock := false

			for _, offer := range doc.Offers {
				if offer.PriceCents < cheapest {
					cheapest = offer.PriceCents
				}
				if offer.CommissionBps > best {
					best = offer.CommissionBps
				}
				if offer.InStock {
					anyInStock = true
				}
			}

			if doc.MinPriceCents != cheapest {
				t.Errorf("%s min price = %d, want %d", doc.ProductID, doc.MinPriceCents, cheapest)
			}
			if doc.MaxCommissionBps != best {
				t.Errorf("%s max commission = %d, want %d", doc.ProductID, doc.MaxCommissionBps, best)
			}
			if doc.InStockAnywhere != anyInStock {
				t.Errorf("%s in-stock rollup = %v, want %v", doc.ProductID, doc.InStockAnywhere, anyInStock)
			}
		}

		return nil
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
}

// The remaining OpenSearch surfaces, which need no database.

func TestEnableLocalModelsSetsTheClusterFlags(t *testing.T) {
	cluster := newFakeCluster(t)

	if err := cluster.client().EnableLocalModels(context.Background()); err != nil {
		t.Fatalf("EnableLocalModels: %v", err)
	}

	if !strings.Contains(cluster.calls[0].path, "_cluster/settings") {
		t.Fatalf("path = %s", cluster.calls[0].path)
	}
	// Registering a model from outside the default allow list requires this,
	// and the demo deliberately runs a local ONNX model rather than a hosted
	// embedding API.
	if !strings.Contains(cluster.calls[0].body, "allow_registering_model_via_url") &&
		!strings.Contains(cluster.calls[0].body, "only_run_on_ml_node") {
		t.Fatalf("settings body carries neither ML flag: %s", cluster.calls[0].body)
	}
}

// Model registration is asynchronous. Returning the task id rather than polling
// to completion would hand the pipeline a model that does not exist yet.
func TestRegisterEmbeddingModelWaitsForTheTaskToComplete(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_plugins/_ml/models/_register", http.StatusOK, `{"task_id":"task_1"}`)

	polls := 0
	cluster.handlers["/_plugins/_ml/tasks/"] = func(w http.ResponseWriter, _ *http.Request) {
		polls++
		if polls < 2 {
			_, _ = w.Write([]byte(`{"state":"RUNNING"}`))
			return
		}
		_, _ = w.Write([]byte(`{"state":"COMPLETED","model_id":"model_final"}`))
	}

	modelID, err := cluster.client().RegisterEmbeddingModel(context.Background())
	if err != nil {
		t.Fatalf("RegisterEmbeddingModel: %v", err)
	}
	if modelID != "model_final" {
		t.Fatalf("model id = %q, want model_final", modelID)
	}
	if polls < 2 {
		t.Fatalf("polled %d times; the client did not wait through RUNNING", polls)
	}

	var registered map[string]any
	if err := json.Unmarshal([]byte(cluster.calls[0].body), &registered); err != nil {
		t.Fatalf("decode register body: %v", err)
	}
	// The model emits 384 dimensions, matching the knn_vector mapping.
	// Registering a different model would produce vectors the index rejects.
	if registered["name"] != EmbeddingModel {
		t.Errorf("registered %v, want %s", registered["name"], EmbeddingModel)
	}
}

// Deployment is asynchronous too, and loading the model into node memory
// outlasts the HTTP call that starts it. Returning once _deploy responds hands
// the pipeline a registered-but-undeployed model, and the neural ingest
// pipeline then rejects every document with "Model not ready yet".
func TestRegisterEmbeddingModelWaitsForDeploymentToFinish(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_plugins/_ml/models/_register", http.StatusOK, `{"task_id":"register_task"}`)
	cluster.on("/_plugins/_ml/models/model_final/_deploy", http.StatusOK, `{"task_id":"deploy_task"}`)

	deployPolls := 0
	cluster.handlers["/_plugins/_ml/tasks/"] = func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "deploy_task") {
			_, _ = w.Write([]byte(`{"state":"COMPLETED","model_id":"model_final"}`))
			return
		}

		deployPolls++
		if deployPolls < 2 {
			_, _ = w.Write([]byte(`{"state":"RUNNING"}`))
			return
		}
		_, _ = w.Write([]byte(`{"state":"COMPLETED","model_id":"model_final"}`))
	}

	if _, err := cluster.client().RegisterEmbeddingModel(context.Background()); err != nil {
		t.Fatalf("RegisterEmbeddingModel: %v", err)
	}
	if deployPolls < 2 {
		t.Fatalf("polled the deploy task %d times; the client did not wait through RUNNING", deployPolls)
	}
}

func TestRegisterEmbeddingModelSurfacesAFailedDeployment(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_plugins/_ml/models/_register", http.StatusOK, `{"task_id":"register_task"}`)
	cluster.on("/_plugins/_ml/models/model_final/_deploy", http.StatusOK, `{"task_id":"deploy_task"}`)

	cluster.handlers["/_plugins/_ml/tasks/"] = func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "deploy_task") {
			_, _ = w.Write([]byte(`{"state":"FAILED","error":"insufficient memory on ml node"}`))
			return
		}
		_, _ = w.Write([]byte(`{"state":"COMPLETED","model_id":"model_final"}`))
	}

	_, err := cluster.client().RegisterEmbeddingModel(context.Background())
	if err == nil {
		t.Fatal("RegisterEmbeddingModel succeeded against a FAILED deployment")
	}
	if !strings.Contains(err.Error(), "insufficient memory") {
		t.Fatalf("error lost the cluster's reason: %v", err)
	}
}

func TestRegisterEmbeddingModelSurfacesAFailedTask(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.on("/_plugins/_ml/models/_register", http.StatusOK, `{"task_id":"task_1"}`)
	cluster.on("/_plugins/_ml/tasks/", http.StatusOK, `{"state":"FAILED","error":"out of memory"}`)

	if _, err := cluster.client().RegisterEmbeddingModel(context.Background()); err == nil {
		t.Fatal("RegisterEmbeddingModel succeeded against a FAILED task")
	}
}

// A rebuild targets a fresh versioned index. Deleting first makes the run
// repeatable after a partial failure rather than colliding with leftovers.
func TestCreateVersionedIndexReplacesAnyLeftover(t *testing.T) {
	cluster := newFakeCluster(t)

	if err := cluster.client().CreateVersionedIndex(context.Background(), "products_v2", `{"settings":{"index":{"number_of_shards":1}},"mappings":{"properties":{}}}`); err != nil {
		t.Fatalf("CreateVersionedIndex: %v", err)
	}

	paths := cluster.paths()
	if len(paths) < 2 {
		t.Fatalf("issued %v, want a delete followed by a create", paths)
	}
	if !strings.HasPrefix(paths[0], "DELETE") {
		t.Errorf("first call = %s, want the leftover delete", paths[0])
	}
	if !strings.HasPrefix(paths[1], "PUT") {
		t.Errorf("second call = %s, want the create", paths[1])
	}
}
