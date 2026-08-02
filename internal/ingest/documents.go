package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MerchantOffer is one merchant's listing of a product, nested inside the
// product document. Nesting rather than indexing per-listing means a search
// returns one row per real product instead of eight near-identical rows, which
// removes the need for field collapsing at query time.
type MerchantOffer struct {
	ListingID     string `json:"listing_id"`
	MerchantID    string `json:"merchant_id"`
	ListingTitle  string `json:"listing_title"`
	PriceCents    int64  `json:"price_cents"`
	InStock       bool   `json:"in_stock"`
	CommissionBps int    `json:"commission_bps"`
	DeepLinkURL   string `json:"deep_link_url"`
}

// ProductDocument is what OpenSearch stores. EmbeddingSource feeds the model
// and never reaches the index, so it carries no JSON tag. Embedding holds the
// vector the ingest run generates before indexing.
type ProductDocument struct {
	ProductID        string            `json:"product_id"`
	CanonicalTitle   string            `json:"canonical_title"`
	Description      string            `json:"description"`
	Brand            string            `json:"brand"`
	CategoryID       string            `json:"category_id"`
	Attributes       map[string]string `json:"attributes"`
	EmbeddingSource  string            `json:"-"`
	Embedding        []float32         `json:"embedding,omitempty"`
	OfferCount       int               `json:"offer_count"`
	MinPriceCents    int64             `json:"min_price_cents"`
	MaxPriceCents    int64             `json:"max_price_cents"`
	MaxCommissionBps int               `json:"max_commission_bps"`
	InStockAnywhere  bool              `json:"in_stock_anywhere"`
	MerchantIDs      []string          `json:"merchant_ids"`
	Offers           []MerchantOffer   `json:"offers"`
	IndexedAt        string            `json:"indexed_at"`
}

// DocumentSource streams product documents assembled from Postgres. The query
// orders by product_id so all offers for one product arrive consecutively,
// which lets assembly run in constant memory rather than buffering the whole
// catalog to group by product.
type DocumentSource struct {
	pool *pgxpool.Pool
}

func NewDocumentSource(pool *pgxpool.Pool) *DocumentSource {
	return &DocumentSource{pool: pool}
}

const documentQuery = `
SELECT
    p.product_id,
    p.canonical_title,
    p.description,
    p.brand,
    p.category_id,
    p.attributes,
    l.listing_id,
    l.merchant_id,
    l.listing_title,
    l.price_cents,
    l.in_stock,
    l.commission_bps,
    l.deep_link_url
FROM products p
JOIN listings l ON l.product_id = p.product_id
ORDER BY p.product_id`

// Stream assembles documents and hands each completed batch to emit. Batching
// happens here rather than in the caller so the row cursor stays open exactly
// as long as needed.
func (s *DocumentSource) Stream(
	ctx context.Context,
	batchSize int,
	emit func([]ProductDocument) error,
) (int64, error) {
	rows, err := s.pool.Query(ctx, documentQuery)
	if err != nil {
		return 0, fmt.Errorf("query documents: %w", err)
	}
	defer rows.Close()

	indexedAt := time.Now().UTC().Format(time.RFC3339)

	var (
		batch   []ProductDocument
		current *ProductDocument
		emitted int64
	)

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := emit(batch); err != nil {
			return err
		}
		emitted += int64(len(batch))
		batch = batch[:0]
		return nil
	}

	closeCurrent := func() error {
		if current == nil {
			return nil
		}
		batch = append(batch, *current)
		current = nil

		if len(batch) >= batchSize {
			return flush()
		}
		return nil
	}

	for rows.Next() {
		var (
			productID, canonicalTitle, description, brand, categoryID string
			attributesRaw                                             []byte
			listingID, merchantID, listingTitle, deepLinkURL          string
			priceCents                                                int64
			inStock                                                   bool
			commissionBps                                             int
		)

		if err := rows.Scan(
			&productID, &canonicalTitle, &description, &brand, &categoryID, &attributesRaw,
			&listingID, &merchantID, &listingTitle, &priceCents, &inStock, &commissionBps, &deepLinkURL,
		); err != nil {
			return emitted, fmt.Errorf("scan row: %w", err)
		}

		if current == nil || current.ProductID != productID {
			if err := closeCurrent(); err != nil {
				return emitted, err
			}

			attributes := map[string]string{}
			if len(attributesRaw) > 0 {
				if err := json.Unmarshal(attributesRaw, &attributes); err != nil {
					return emitted, fmt.Errorf("parse attributes for %s: %w", productID, err)
				}
			}

			current = &ProductDocument{
				ProductID:      productID,
				CanonicalTitle: canonicalTitle,
				Description:    description,
				Brand:          brand,
				CategoryID:     categoryID,
				Attributes:     attributes,
				// The embedding covers title plus brand plus description
				// because a query like "waterproof hiking pack" matches
				// description text the title alone would miss.
				EmbeddingSource: canonicalTitle + ". " + brand + ". " + description,
				MinPriceCents:   priceCents,
				MaxPriceCents:   priceCents,
				IndexedAt:       indexedAt,
			}
		}

		current.Offers = append(current.Offers, MerchantOffer{
			ListingID:     listingID,
			MerchantID:    merchantID,
			ListingTitle:  listingTitle,
			PriceCents:    priceCents,
			InStock:       inStock,
			CommissionBps: commissionBps,
			DeepLinkURL:   deepLinkURL,
		})

		current.OfferCount++
		current.MerchantIDs = append(current.MerchantIDs, merchantID)

		if priceCents < current.MinPriceCents {
			current.MinPriceCents = priceCents
		}
		if priceCents > current.MaxPriceCents {
			current.MaxPriceCents = priceCents
		}
		if commissionBps > current.MaxCommissionBps {
			current.MaxCommissionBps = commissionBps
		}
		if inStock {
			current.InStockAnywhere = true
		}
	}

	if err := rows.Err(); err != nil {
		return emitted, fmt.Errorf("iterate rows: %w", err)
	}

	if err := closeCurrent(); err != nil {
		return emitted, err
	}

	return emitted, flush()
}

// CountProducts gives the expected document count so the post-load validation
// compares against a known number rather than trusting the bulk responses.
func (s *DocumentSource) CountProducts(ctx context.Context) (int64, error) {
	var count int64
	err := s.pool.QueryRow(ctx, `
		SELECT count(DISTINCT p.product_id)
		FROM products p
		JOIN listings l ON l.product_id = p.product_id
	`).Scan(&count)

	return count, err
}
