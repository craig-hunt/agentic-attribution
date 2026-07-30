// Package search builds and executes the hybrid product query. Reads go
// exclusively to OpenSearch; Postgres never appears on this path, which is why
// ingest write pressure cannot degrade search latency.
package search

import (
	"encoding/json"
)

const (
	DefaultSize = 20
	MaxSize     = 100

	// k for the k-NN subquery. Oversampling relative to the requested size
	// gives the normalization processor a wider candidate pool to blend
	// against BM25, which improves the final ranking.
	KnnOversampleFactor = 3

	// Field boosts. Title matches signal intent far more strongly than
	// description matches, and brand sits between them.
	TitleBoost       = 3.0
	BrandBoost       = 2.0
	DescriptionBoost = 1.0
)

type Request struct {
	Query      string   `json:"query"`
	Size       int      `json:"size"`
	CategoryID string   `json:"category_id,omitempty"`
	Brands     []string `json:"brands,omitempty"`
	MerchantID string   `json:"merchant_id,omitempty"`
	InStock    bool     `json:"in_stock_only,omitempty"`
	MaxPrice   int64    `json:"max_price_cents,omitempty"`
}

func (r Request) resolvedSize() int {
	switch {
	case r.Size <= 0:
		return DefaultSize
	case r.Size > MaxSize:
		return MaxSize
	default:
		return r.Size
	}
}

// BuildQuery produces the hybrid request body. The `hybrid` query wraps two
// subqueries whose scores the search pipeline normalizes and blends. Summing
// them raw would let BM25 dominate, because BM25 is unbounded and corpus
// dependent while cosine similarity runs 0 to 1.
func BuildQuery(r Request, modelID string) ([]byte, error) {
	size := r.resolvedSize()
	filters := buildFilters(r)

	keyword := map[string]any{
		"multi_match": map[string]any{
			"query": r.Query,
			"fields": []string{
				fieldWithBoost("canonical_title", TitleBoost),
				fieldWithBoost("brand", BrandBoost),
				fieldWithBoost("description", DescriptionBoost),
			},
			"type": "best_fields",
		},
	}

	semantic := map[string]any{
		"neural": map[string]any{
			"embedding": map[string]any{
				"query_text": r.Query,
				"model_id":   modelID,
				"k":          size * KnnOversampleFactor,
			},
		},
	}

	// Filters apply to both subqueries. Applying them only to one would let
	// the unfiltered branch surface documents the caller excluded.
	if len(filters) > 0 {
		keyword = wrapWithFilters(keyword, filters)
		semantic = wrapWithFilters(semantic, filters)
	}

	body := map[string]any{
		"size": size,
		"query": map[string]any{
			"hybrid": map[string]any{
				"queries": []any{keyword, semantic},
			},
		},
		"_source": map[string]any{
			// The embedding vector is large and useless to the caller.
			// Excluding it cuts response size by roughly 1.5KB per hit.
			"excludes": []string{"embedding", "embedding_source"},
		},
	}

	return json.Marshal(body)
}

func fieldWithBoost(field string, boost float64) string {
	switch boost {
	case 1.0:
		return field
	case 2.0:
		return field + "^2"
	case 3.0:
		return field + "^3"
	default:
		return field
	}
}

func buildFilters(r Request) []any {
	var filters []any

	if r.CategoryID != "" {
		filters = append(filters, term("category_id", r.CategoryID))
	}

	if len(r.Brands) > 0 {
		filters = append(filters, map[string]any{
			"terms": map[string]any{"brand": r.Brands},
		})
	}

	if r.MerchantID != "" {
		filters = append(filters, term("merchant_ids", r.MerchantID))
	}

	if r.InStock {
		filters = append(filters, term("in_stock_anywhere", true))
	}

	if r.MaxPrice > 0 {
		filters = append(filters, map[string]any{
			"range": map[string]any{
				"min_price_cents": map[string]any{"lte": r.MaxPrice},
			},
		})
	}

	return filters
}

func term(field string, value any) map[string]any {
	return map[string]any{
		"term": map[string]any{field: value},
	}
}

// wrapWithFilters puts the scoring query in `must` and the filters in `filter`.
// Filter context skips scoring entirely and uses the query cache, so filtering
// costs almost nothing compared to scoring.
func wrapWithFilters(scoring map[string]any, filters []any) map[string]any {
	return map[string]any{
		"bool": map[string]any{
			"must":   []any{scoring},
			"filter": filters,
		},
	}
}

// Response mirrors the subset of the OpenSearch reply the API returns.
type Response struct {
	Took int `json:"took"`
	Hits struct {
		Total struct {
			Value int64 `json:"value"`
		} `json:"total"`
		Hits []struct {
			ID     string          `json:"_id"`
			Score  float64         `json:"_score"`
			Source json.RawMessage `json:"_source"`
		} `json:"hits"`
	} `json:"hits"`
}
