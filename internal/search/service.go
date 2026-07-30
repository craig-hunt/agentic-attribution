package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	ProductsAlias  = "products"
	SearchPipeline = "hybrid-search"

	requestTimeout = 10 * time.Second
)

type Product struct {
	ProductID        string            `json:"product_id"`
	CanonicalTitle   string            `json:"canonical_title"`
	Description      string            `json:"description"`
	Brand            string            `json:"brand"`
	CategoryID       string            `json:"category_id"`
	Attributes       map[string]string `json:"attributes"`
	OfferCount       int               `json:"offer_count"`
	MinPriceCents    int64             `json:"min_price_cents"`
	MaxPriceCents    int64             `json:"max_price_cents"`
	MaxCommissionBps int               `json:"max_commission_bps"`
	InStockAnywhere  bool              `json:"in_stock_anywhere"`
	Offers           []Offer           `json:"offers"`
	Score            float64           `json:"score"`
}

type Offer struct {
	ListingID     string `json:"listing_id"`
	MerchantID    string `json:"merchant_id"`
	ListingTitle  string `json:"listing_title"`
	PriceCents    int64  `json:"price_cents"`
	InStock       bool   `json:"in_stock"`
	CommissionBps int    `json:"commission_bps"`
	DeepLinkURL   string `json:"deep_link_url"`
}

type Results struct {
	Query      string    `json:"query"`
	TotalHits  int64     `json:"total_hits"`
	TookMillis int       `json:"took_ms"`
	Products   []Product `json:"products"`
}

type Service struct {
	baseURL string
	http    *http.Client

	// The embedding model id is resolved once at startup and cached. Looking
	// it up per request would add a round trip to every search.
	modelOnce sync.Once
	modelID   string
	modelErr  error
}

func NewService(baseURL string) *Service {
	return &Service{
		baseURL: strings.TrimRight(baseURL, "/"),
		http: &http.Client{
			Timeout: requestTimeout,
			Transport: &http.Transport{
				// Connection reuse matters on a sub-100ms budget. A fresh TCP
				// handshake per request adds single-digit milliseconds that
				// come straight out of the p99 allowance.
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 100,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// Search executes the hybrid query and shapes the response for callers.
func (s *Service) Search(ctx context.Context, req Request) (Results, error) {
	modelID, err := s.embeddingModelID(ctx)
	if err != nil {
		return Results{}, fmt.Errorf("resolve embedding model: %w", err)
	}

	body, err := BuildQuery(req, modelID)
	if err != nil {
		return Results{}, fmt.Errorf("build query: %w", err)
	}

	path := fmt.Sprintf("/%s/_search?search_pipeline=%s", ProductsAlias, SearchPipeline)

	raw, err := s.post(ctx, path, body)
	if err != nil {
		return Results{}, err
	}

	var parsed Response
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return Results{}, fmt.Errorf("decode search response: %w", err)
	}

	results := Results{
		Query:      req.Query,
		TotalHits:  parsed.Hits.Total.Value,
		TookMillis: parsed.Took,
		Products:   make([]Product, 0, len(parsed.Hits.Hits)),
	}

	for _, hit := range parsed.Hits.Hits {
		var p Product
		if err := json.Unmarshal(hit.Source, &p); err != nil {
			return Results{}, fmt.Errorf("decode hit %s: %w", hit.ID, err)
		}
		p.Score = hit.Score

		// Cheapest in-stock offer first. Agents overwhelmingly want the best
		// available price, and sorting here saves every caller doing it.
		sort.SliceStable(p.Offers, func(i, j int) bool {
			if p.Offers[i].InStock != p.Offers[j].InStock {
				return p.Offers[i].InStock
			}
			return p.Offers[i].PriceCents < p.Offers[j].PriceCents
		})

		results.Products = append(results.Products, p)
	}

	return results, nil
}

// embeddingModelID finds the deployed model once. The neural query needs it and
// ingest registered it, so search discovers rather than configures it.
func (s *Service) embeddingModelID(ctx context.Context) (string, error) {
	s.modelOnce.Do(func() {
		body := map[string]any{
			"query": map[string]any{
				"term": map[string]any{"model_state": "DEPLOYED"},
			},
			"size": 1,
		}

		encoded, err := json.Marshal(body)
		if err != nil {
			s.modelErr = err
			return
		}

		raw, err := s.post(ctx, "/_plugins/_ml/models/_search", encoded)
		if err != nil {
			s.modelErr = err
			return
		}

		var found struct {
			Hits struct {
				Hits []struct {
					ID string `json:"_id"`
				} `json:"hits"`
			} `json:"hits"`
		}
		if err := json.Unmarshal(raw, &found); err != nil {
			s.modelErr = err
			return
		}

		if len(found.Hits.Hits) == 0 {
			s.modelErr = fmt.Errorf("no deployed embedding model; run the ingest service first")
			return
		}

		s.modelID = found.Hits.Hits[0].ID
	})

	return s.modelID, s.modelErr
}

func (s *Service) post(ctx context.Context, path string, body []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		limit := len(payload)
		if limit > 512 {
			limit = 512
		}
		return nil, fmt.Errorf("opensearch returned %d: %s", resp.StatusCode, payload[:limit])
	}

	return payload, nil
}
