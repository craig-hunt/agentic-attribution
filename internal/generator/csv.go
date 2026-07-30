package generator

import (
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// Column orders here must match the COPY statements in the ingest service.
// Postgres COPY is positional, so a reordered column silently loads the wrong
// data rather than failing, which makes this the most dangerous coupling in
// the pipeline.
var (
	merchantColumns  = []string{"merchant_id", "name", "default_commission_bps", "hold_period_days", "reversal_window_days"}
	publisherColumns = []string{"publisher_id", "name", "payout_currency"}
	productColumns   = []string{"product_id", "canonical_title", "brand", "category_id", "description", "attributes"}
	listingColumns   = []string{"listing_id", "product_id", "merchant_id", "merchant_sku", "listing_title", "price_cents", "currency", "in_stock", "commission_bps", "deep_link_url"}
)

type Files struct {
	Merchants  string
	Publishers string
	Products   string
	Listings   string
}

// WriteCSV emits four COPY-ready files. Written with HEADER so the ingest
// service's COPY statements name their columns explicitly rather than relying
// on positional alignment alone.
func WriteCSV(c Catalog, outDir string) (Files, error) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return Files{}, fmt.Errorf("create output dir: %w", err)
	}

	files := Files{
		Merchants:  filepath.Join(outDir, "merchants.csv"),
		Publishers: filepath.Join(outDir, "publishers.csv"),
		Products:   filepath.Join(outDir, "products.csv"),
		Listings:   filepath.Join(outDir, "listings.csv"),
	}

	if err := writeRows(files.Merchants, merchantColumns, len(c.Merchants), func(i int) []string {
		m := c.Merchants[i]
		return []string{
			m.MerchantID,
			m.Name,
			strconv.Itoa(m.DefaultCommissionBps),
			strconv.Itoa(m.HoldPeriodDays),
			strconv.Itoa(m.ReversalWindowDays),
		}
	}); err != nil {
		return Files{}, fmt.Errorf("write merchants: %w", err)
	}

	if err := writeRows(files.Publishers, publisherColumns, len(c.Publishers), func(i int) []string {
		p := c.Publishers[i]
		return []string{p.PublisherID, p.Name, p.PayoutCurrency}
	}); err != nil {
		return Files{}, fmt.Errorf("write publishers: %w", err)
	}

	if err := writeRows(files.Products, productColumns, len(c.Products), func(i int) []string {
		p := c.Products[i]
		return []string{
			p.ProductID,
			p.CanonicalTitle,
			p.Brand,
			p.CategoryID,
			p.Description,
			p.AttributesJSON,
		}
	}); err != nil {
		return Files{}, fmt.Errorf("write products: %w", err)
	}

	if err := writeRows(files.Listings, listingColumns, len(c.Listings), func(i int) []string {
		l := c.Listings[i]
		return []string{
			l.ListingID,
			l.ProductID,
			l.MerchantID,
			l.MerchantSKU,
			l.ListingTitle,
			strconv.FormatInt(l.PriceCents, 10),
			l.Currency,
			boolForCopy(l.InStock),
			strconv.Itoa(l.CommissionBps),
			l.DeepLinkURL,
		}
	}); err != nil {
		return Files{}, fmt.Errorf("write listings: %w", err)
	}

	return files, nil
}

func writeRows(path string, header []string, count int, row func(int) []string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	w := csv.NewWriter(f)

	if err := w.Write(header); err != nil {
		return err
	}

	for i := 0; i < count; i++ {
		if err := w.Write(row(i)); err != nil {
			return err
		}
	}

	w.Flush()

	if err := w.Error(); err != nil {
		return err
	}

	return f.Sync()
}

// Postgres COPY accepts t and f for boolean columns in CSV format.
func boolForCopy(v bool) string {
	if v {
		return "t"
	}
	return "f"
}
