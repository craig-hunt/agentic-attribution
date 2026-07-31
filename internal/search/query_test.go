package search

import (
	"encoding/json"
	"strings"
	"testing"
)

const testModelID = "model_abc123"

func build(t *testing.T, r Request) map[string]any {
	t.Helper()

	raw, err := BuildQuery(r, testModelID)
	if err != nil {
		t.Fatalf("BuildQuery: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("the query is not valid JSON: %v", err)
	}

	return decoded
}

// subqueries returns the two branches the hybrid query blends, in the order
// BuildQuery emits them: keyword first, semantic second. The search pipeline's
// weights are positional, so that order carries meaning.
func subqueries(t *testing.T, body map[string]any) []any {
	t.Helper()

	query, ok := body["query"].(map[string]any)
	if !ok {
		t.Fatalf("no query object: %v", body)
	}

	hybrid, ok := query["hybrid"].(map[string]any)
	if !ok {
		t.Fatalf("the query is not a hybrid query: %v", query)
	}

	branches, ok := hybrid["queries"].([]any)
	if !ok {
		t.Fatalf("hybrid.queries is not a list: %v", hybrid)
	}

	if len(branches) != 2 {
		t.Fatalf("hybrid carries %d subqueries, want exactly 2", len(branches))
	}

	return branches
}

func TestSizeResolution(t *testing.T) {
	cases := []struct {
		name string
		size int
		want float64
	}{
		{"unset falls back to the default", 0, DefaultSize},
		{"negative falls back to the default", -5, DefaultSize},
		{"in range passes through", 37, 37},
		{"at the ceiling passes through", MaxSize, MaxSize},
		{"above the ceiling clamps", MaxSize + 1, MaxSize},
		{"absurd clamps", 1_000_000, MaxSize},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := build(t, Request{Query: "shoes", Size: tc.size})

			if body["size"] != tc.want {
				t.Fatalf("size = %v, want %v", body["size"], tc.want)
			}
		})
	}
}

// k oversamples relative to the requested size so the normalization processor
// blends against a wider candidate pool. k equal to size would hand the
// pipeline only the vector search's own top results to work with.
func TestKnnOversamplesRelativeToRequestedSize(t *testing.T) {
	body := build(t, Request{Query: "shoes", Size: 10})
	branches := subqueries(t, body)

	neural := branches[1].(map[string]any)["neural"].(map[string]any)
	embedding := neural["embedding"].(map[string]any)

	if embedding["k"] != float64(10*KnnOversampleFactor) {
		t.Fatalf("k = %v, want %d", embedding["k"], 10*KnnOversampleFactor)
	}
	if embedding["model_id"] != testModelID {
		t.Fatalf("model_id = %v, want %s", embedding["model_id"], testModelID)
	}
	if embedding["query_text"] != "shoes" {
		t.Fatalf("query_text = %v", embedding["query_text"])
	}
}

// Title matches signal intent more strongly than description matches. Losing
// these boosts would degrade ranking silently rather than break anything.
func TestKeywordBranchCarriesFieldBoosts(t *testing.T) {
	body := build(t, Request{Query: "trail shoes"})
	branches := subqueries(t, body)

	match := branches[0].(map[string]any)["multi_match"].(map[string]any)

	fields := make([]string, 0, 3)
	for _, f := range match["fields"].([]any) {
		fields = append(fields, f.(string))
	}

	want := []string{"canonical_title^3", "brand^2", "description"}
	if strings.Join(fields, ",") != strings.Join(want, ",") {
		t.Fatalf("fields = %v, want %v", fields, want)
	}

	if match["query"] != "trail shoes" {
		t.Fatalf("query = %v", match["query"])
	}
	if match["type"] != "best_fields" {
		t.Fatalf("type = %v, want best_fields", match["type"])
	}
}

func TestFieldWithBoostRendersOnlyRecognisedBoosts(t *testing.T) {
	cases := []struct {
		boost float64
		want  string
	}{
		{1.0, "brand"},
		{2.0, "brand^2"},
		{3.0, "brand^3"},
		{2.5, "brand"},
		{0, "brand"},
	}

	for _, tc := range cases {
		if got := fieldWithBoost("brand", tc.boost); got != tc.want {
			t.Errorf("fieldWithBoost(brand, %v) = %q, want %q", tc.boost, got, tc.want)
		}
	}
}

// The single most important property of this builder. Filtering one branch and
// not the other lets the unfiltered branch surface documents the caller
// explicitly excluded, and the hybrid blend hides which branch produced them.
func TestFiltersApplyToBothSubqueriesOrToNeither(t *testing.T) {
	cases := []struct {
		name    string
		request Request
	}{
		{"category", Request{Query: "x", CategoryID: "cat_1"}},
		{"brands", Request{Query: "x", Brands: []string{"Acme"}}},
		{"merchant", Request{Query: "x", MerchantID: "mer_1"}},
		{"in stock", Request{Query: "x", InStock: true}},
		{"max price", Request{Query: "x", MaxPrice: 5_000}},
		{"every filter at once", Request{
			Query:      "x",
			CategoryID: "cat_1",
			Brands:     []string{"Acme", "Globex"},
			MerchantID: "mer_1",
			InStock:    true,
			MaxPrice:   5_000,
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			branches := subqueries(t, build(t, tc.request))

			for i, branch := range branches {
				wrapper, ok := branch.(map[string]any)["bool"].(map[string]any)
				if !ok {
					t.Fatalf("subquery %d carries no bool wrapper, so it went unfiltered", i)
				}

				filters, ok := wrapper["filter"].([]any)
				if !ok || len(filters) == 0 {
					t.Fatalf("subquery %d carries no filters", i)
				}

				if must, ok := wrapper["must"].([]any); !ok || len(must) != 1 {
					t.Fatalf("subquery %d puts %v in must, want exactly one scoring query", i, wrapper["must"])
				}
			}

			first := branches[0].(map[string]any)["bool"].(map[string]any)["filter"]
			second := branches[1].(map[string]any)["bool"].(map[string]any)["filter"]

			a, _ := json.Marshal(first)
			b, _ := json.Marshal(second)
			if string(a) != string(b) {
				t.Fatalf("the two branches carry different filters:\n%s\n%s", a, b)
			}
		})
	}
}

func TestAnUnfilteredRequestWrapsNeitherBranch(t *testing.T) {
	branches := subqueries(t, build(t, Request{Query: "shoes"}))

	for i, branch := range branches {
		if _, wrapped := branch.(map[string]any)["bool"]; wrapped {
			t.Fatalf("subquery %d carries a bool wrapper despite no filters", i)
		}
	}
}

func TestBuildFiltersEmitsTheExpectedClauses(t *testing.T) {
	cases := []struct {
		name    string
		request Request
		want    string
	}{
		{"category becomes a term", Request{CategoryID: "cat_1"}, `{"term":{"category_id":"cat_1"}}`},
		{"merchant filters the offer array", Request{MerchantID: "mer_1"}, `{"term":{"merchant_ids":"mer_1"}}`},
		{"stock filters the rollup flag", Request{InStock: true}, `{"term":{"in_stock_anywhere":true}}`},
		{"brands become a terms clause", Request{Brands: []string{"Acme"}}, `{"terms":{"brand":["Acme"]}}`},
		{"price becomes a range", Request{MaxPrice: 500}, `{"range":{"min_price_cents":{"lte":500}}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			filters := buildFilters(tc.request)

			if len(filters) != 1 {
				t.Fatalf("built %d filters, want 1", len(filters))
			}

			got, err := json.Marshal(filters[0])
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != tc.want {
				t.Fatalf("filter = %s, want %s", got, tc.want)
			}
		})
	}
}

// Absent optional fields must not become filters. A zero MaxPrice filtering to
// "at most zero cents" would return nothing and read as a broken index.
func TestZeroValuesProduceNoFilters(t *testing.T) {
	if filters := buildFilters(Request{Query: "shoes"}); len(filters) != 0 {
		t.Fatalf("an empty request produced %d filters: %v", len(filters), filters)
	}

	if filters := buildFilters(Request{MaxPrice: 0, InStock: false, Brands: []string{}}); len(filters) != 0 {
		t.Fatalf("zero values produced %d filters: %v", len(filters), filters)
	}
}

// The embedding vector runs 384 floats per hit and the caller never uses it.
// Excluding it cuts roughly 1.5KB from every result.
func TestSourceExcludesTheEmbeddingVectors(t *testing.T) {
	body := build(t, Request{Query: "shoes"})

	source, ok := body["_source"].(map[string]any)
	if !ok {
		t.Fatalf("no _source directive: %v", body)
	}

	excluded := make(map[string]bool)
	for _, f := range source["excludes"].([]any) {
		excluded[f.(string)] = true
	}

	for _, field := range []string{"embedding", "embedding_source"} {
		if !excluded[field] {
			t.Errorf("_source does not exclude %s, so every hit carries it", field)
		}
	}
}

func TestResponseDecodesAnOpenSearchReply(t *testing.T) {
	raw := `{
		"took": 17,
		"hits": {
			"total": {"value": 1234},
			"hits": [
				{"_id": "prd_1", "_score": 0.87, "_source": {"canonical_title": "Trail Runner"}},
				{"_id": "prd_2", "_score": 0.51, "_source": {"canonical_title": "Road Runner"}}
			]
		}
	}`

	var decoded Response
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if decoded.Took != 17 {
		t.Errorf("took = %d, want 17", decoded.Took)
	}
	if decoded.Hits.Total.Value != 1234 {
		t.Errorf("total = %d, want 1234", decoded.Hits.Total.Value)
	}
	if len(decoded.Hits.Hits) != 2 {
		t.Fatalf("decoded %d hits, want 2", len(decoded.Hits.Hits))
	}
	if decoded.Hits.Hits[0].ID != "prd_1" || decoded.Hits.Hits[0].Score != 0.87 {
		t.Errorf("first hit = %+v", decoded.Hits.Hits[0])
	}
	if !strings.Contains(string(decoded.Hits.Hits[1].Source), "Road Runner") {
		t.Errorf("source did not survive as raw JSON: %s", decoded.Hits.Hits[1].Source)
	}
}

// An empty query string still has to produce a well-formed request. OpenSearch
// answers it with no hits, which beats the service returning a malformed body
// and a 400 the caller cannot act on.
func TestAnEmptyQueryStillBuildsValidJSON(t *testing.T) {
	body := build(t, Request{})

	if body["size"] != float64(DefaultSize) {
		t.Fatalf("size = %v", body["size"])
	}
	subqueries(t, body)
}
