package search

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const deployedModelID = "model_deployed_1"

type stubOpenSearch struct {
	server       *httptest.Server
	modelCalls   int
	searchCalls  int
	lastSearch   map[string]any
	searchStatus int
	searchBody   string
	modelHits    int
	decodeErr    error
}

// newStubOpenSearch answers the two calls Search makes: the model lookup and
// the search itself. Counting them separately is what proves the model
// resolves once per service rather than once per request.
func newStubOpenSearch(t *testing.T) *stubOpenSearch {
	t.Helper()

	s := &stubOpenSearch{searchStatus: http.StatusOK, modelHits: 1}

	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/_plugins/_ml/models/_search") {
			s.modelCalls++

			if s.modelHits == 0 {
				_, _ = w.Write([]byte(`{"hits":{"hits":[]}}`))
				return
			}

			_, _ = w.Write([]byte(`{"hits":{"hits":[{"_id":"` + deployedModelID + `"}]}}`))
			return
		}

		s.searchCalls++

		// A discarded decode error leaves lastSearch nil, and the type
		// assertions that read it panic somewhere with no bearing on the cause.
		if decodeErr := json.NewDecoder(r.Body).Decode(&s.lastSearch); decodeErr != nil {
			s.decodeErr = decodeErr
		}

		w.WriteHeader(s.searchStatus)
		_, _ = w.Write([]byte(s.searchBody))
	}))

	t.Cleanup(s.server.Close)

	return s
}

const twoProductsWithOffers = `{
  "took": 12,
  "hits": {
    "total": {"value": 2},
    "hits": [
      {"_id":"prd_1","_score":0.9,"_source":{
        "product_id":"prd_1","canonical_title":"Trail Runner","brand":"Acme",
        "offers":[
          {"listing_id":"l1","merchant_id":"m1","price_cents":9999,"in_stock":true,"commission_bps":400},
          {"listing_id":"l2","merchant_id":"m2","price_cents":7500,"in_stock":false,"commission_bps":900},
          {"listing_id":"l3","merchant_id":"m3","price_cents":8500,"in_stock":true,"commission_bps":300}
        ]}},
      {"_id":"prd_2","_score":0.4,"_source":{
        "product_id":"prd_2","canonical_title":"Road Runner","brand":"Globex","offers":[]}}
    ]
  }
}`

func TestSearchDecodesResultsAndCarriesMetadata(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchBody = twoProductsWithOffers

	results, err := NewService(stub.server.URL).Search(context.Background(), Request{Query: "runner"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	if results.Query != "runner" {
		t.Errorf("query = %q", results.Query)
	}
	if results.TotalHits != 2 {
		t.Errorf("total hits = %d, want 2", results.TotalHits)
	}
	if results.TookMillis != 12 {
		t.Errorf("took = %d, want 12", results.TookMillis)
	}
	if len(results.Products) != 2 {
		t.Fatalf("decoded %d products, want 2", len(results.Products))
	}
	if results.Products[0].Score != 0.9 {
		t.Errorf("the hit score did not reach the product: %v", results.Products[0].Score)
	}
}

// Agents overwhelmingly want the best available price, so the service sorts
// once rather than leaving every caller to do it. Availability outranks price:
// a cheaper out-of-stock offer helps nobody.
func TestOffersSortCheapestInStockFirst(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchBody = twoProductsWithOffers

	results, err := NewService(stub.server.URL).Search(context.Background(), Request{Query: "runner"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	offers := results.Products[0].Offers
	if len(offers) != 3 {
		t.Fatalf("decoded %d offers, want 3", len(offers))
	}

	if offers[0].ListingID != "l3" {
		t.Errorf("first offer = %s at %d cents, want l3 at 8500", offers[0].ListingID, offers[0].PriceCents)
	}
	if offers[1].ListingID != "l1" {
		t.Errorf("second offer = %s, want l1", offers[1].ListingID)
	}
	if offers[2].ListingID != "l2" || offers[2].InStock {
		t.Errorf("the out-of-stock offer should sort last, got %+v", offers[2])
	}
}

func TestAProductWithNoOffersDecodesCleanly(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchBody = twoProductsWithOffers

	results, err := NewService(stub.server.URL).Search(context.Background(), Request{Query: "runner"})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	if len(results.Products[1].Offers) != 0 {
		t.Fatalf("expected no offers, got %v", results.Products[1].Offers)
	}
}

// The model lookup costs a round trip and the answer never changes for the
// lifetime of the process. Resolving per request would put it on the latency
// path this service exists to keep short.
func TestTheEmbeddingModelResolvesOncePerService(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchBody = twoProductsWithOffers

	svc := NewService(stub.server.URL)

	for i := 0; i < 5; i++ {
		if _, err := svc.Search(context.Background(), Request{Query: "runner"}); err != nil {
			t.Fatalf("search %d: %v", i, err)
		}
	}

	if stub.modelCalls != 1 {
		t.Errorf("model resolved %d times across 5 searches, want 1", stub.modelCalls)
	}
	if stub.searchCalls != 5 {
		t.Errorf("issued %d searches, want 5", stub.searchCalls)
	}
}

func TestTheResolvedModelReachesTheQuery(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchBody = twoProductsWithOffers

	if _, err := NewService(stub.server.URL).Search(context.Background(), Request{Query: "runner"}); err != nil {
		t.Fatalf("Search: %v", err)
	}

	if stub.decodeErr != nil {
		t.Fatalf("the stub could not decode the query the service sent: %v", stub.decodeErr)
	}

	branches := stub.lastSearch["query"].(map[string]any)["hybrid"].(map[string]any)["queries"].([]any)
	neural := branches[1].(map[string]any)["neural"].(map[string]any)["embedding"].(map[string]any)

	if neural["model_id"] != deployedModelID {
		t.Fatalf("model_id = %v, want %s", neural["model_id"], deployedModelID)
	}
}

// Ingest registers the model, so a search before the first ingest has nothing
// to query against. Saying so beats a neural query failing on an empty model id.
func TestSearchExplainsAMissingEmbeddingModel(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.modelHits = 0

	_, err := NewService(stub.server.URL).Search(context.Background(), Request{Query: "runner"})

	if err == nil {
		t.Fatal("Search succeeded with no deployed model")
	}
	if !strings.Contains(err.Error(), "ingest") {
		t.Fatalf("error does not point at the fix: %v", err)
	}
}

func TestSearchSurfacesAnOpenSearchError(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchStatus = http.StatusInternalServerError
	stub.searchBody = `{"error":{"reason":"index missing"}}`

	_, err := NewService(stub.server.URL).Search(context.Background(), Request{Query: "runner"})

	if err == nil {
		t.Fatal("Search succeeded against a 500")
	}
}

func TestSearchSurfacesAnUndecodableBody(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchBody = `not json at all`

	_, err := NewService(stub.server.URL).Search(context.Background(), Request{Query: "runner"})

	if err == nil {
		t.Fatal("Search succeeded against a malformed body")
	}
}

func TestSearchReportsAnUnreachableCluster(t *testing.T) {
	// A port nothing listens on, so the transport fails rather than the
	// protocol. The service must report that rather than return empty results,
	// because empty results read as "no products matched".
	_, err := NewService("http://127.0.0.1:1").Search(context.Background(), Request{Query: "runner"})

	if err == nil {
		t.Fatal("Search succeeded against an unreachable cluster")
	}
}

func TestSearchHonoursACancelledContext(t *testing.T) {
	stub := newStubOpenSearch(t)
	stub.searchBody = twoProductsWithOffers

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := NewService(stub.server.URL).Search(ctx, Request{Query: "runner"}); err == nil {
		t.Fatal("Search ignored a cancelled context")
	}
}

func TestSearchTargetsTheAliasAndTheHybridPipeline(t *testing.T) {
	var path string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "_plugins") {
			_, _ = w.Write([]byte(`{"hits":{"hits":[{"_id":"m1"}]}}`))
			return
		}
		path = r.URL.String()
		_, _ = w.Write([]byte(`{"took":1,"hits":{"total":{"value":0},"hits":[]}}`))
	}))
	defer server.Close()

	if _, err := NewService(server.URL).Search(context.Background(), Request{Query: "x"}); err != nil {
		t.Fatalf("Search: %v", err)
	}

	// Querying the alias rather than a versioned index is what makes the
	// zero-downtime rebuild work, and the pipeline is what normalizes the two
	// score scales before blending them.
	if !strings.Contains(path, ProductsAlias) {
		t.Errorf("search path %q does not target the %s alias", path, ProductsAlias)
	}
	if !strings.Contains(path, "search_pipeline="+SearchPipeline) {
		t.Errorf("search path %q does not request the %s pipeline", path, SearchPipeline)
	}
}
