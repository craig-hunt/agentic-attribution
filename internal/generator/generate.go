// Package generator produces a deterministic synthetic catalog. The design
// goal is not realism for its own sake but reproducing the structural problem
// Affiliate.com actually has: the same product listed by many merchants at
// differing prices with drifting titles. No off-the-shelf dataset produces
// that pattern, which is why this exists rather than a Hugging Face download.
package generator

import (
	"fmt"
	"math/rand"
	"strings"
)

const (
	MinMerchantsPerProduct = 3
	MaxMerchantsPerProduct = 8

	MinPriceCents = 1_499
	MaxPriceCents = 89_999

	// Merchants price the same product within a band around a reference
	// price. Wide enough that price-sorted results differ per merchant,
	// narrow enough to stay plausible.
	PriceVarianceBps = 1_800

	MinCommissionBps = 150
	MaxCommissionBps = 1_200

	// Roughly one listing in twelve sits out of stock, so availability
	// filtering has something to exclude.
	OutOfStockOdds = 12
)

type Config struct {
	Seed              int64
	CanonicalProducts int
	MerchantCount     int
	PublisherCount    int
}

type Merchant struct {
	MerchantID           string
	Name                 string
	DefaultCommissionBps int
	HoldPeriodDays       int
	ReversalWindowDays   int
}

type Publisher struct {
	PublisherID     string
	Name            string
	PayoutCurrency  string
}

type Product struct {
	ProductID      string
	CanonicalTitle string
	Brand          string
	CategoryID     string
	Description    string
	AttributesJSON string
}

type Listing struct {
	ListingID     string
	ProductID     string
	MerchantID    string
	MerchantSKU   string
	ListingTitle  string
	PriceCents    int64
	Currency      string
	InStock       bool
	CommissionBps int
	DeepLinkURL   string
}

type Catalog struct {
	Merchants  []Merchant
	Publishers []Publisher
	Products   []Product
	Listings   []Listing
}

// Generate builds the full catalog. Deterministic for a given seed so
// benchmark numbers stay comparable across runs and reviewers reproduce
// exactly what the published results describe.
func Generate(cfg Config) Catalog {
	rng := rand.New(rand.NewSource(cfg.Seed))

	merchants := buildMerchants(rng, cfg.MerchantCount)
	publishers := buildPublishers(rng, cfg.PublisherCount)
	products := buildProducts(rng, cfg.CanonicalProducts)
	listings := buildListings(rng, products, merchants)

	return Catalog{
		Merchants:  merchants,
		Publishers: publishers,
		Products:   products,
		Listings:   listings,
	}
}

func buildMerchants(rng *rand.Rand, count int) []Merchant {
	out := make([]Merchant, 0, count)

	for i := 0; i < count; i++ {
		prefix := merchantPrefixes[rng.Intn(len(merchantPrefixes))]
		suffix := merchantSuffixes[rng.Intn(len(merchantSuffixes))]

		out = append(out, Merchant{
			MerchantID:           fmt.Sprintf("mer_%06d", i),
			Name:                 fmt.Sprintf("%s %s", prefix, suffix),
			DefaultCommissionBps: MinCommissionBps + rng.Intn(MaxCommissionBps-MinCommissionBps),
			HoldPeriodDays:       []int{30, 45, 60}[rng.Intn(3)],
			ReversalWindowDays:   []int{60, 90, 120}[rng.Intn(3)],
		})
	}

	return out
}

func buildPublishers(rng *rand.Rand, count int) []Publisher {
	out := make([]Publisher, 0, count)

	for i := 0; i < count; i++ {
		name := publisherNames[i%len(publisherNames)]
		if i >= len(publisherNames) {
			name = fmt.Sprintf("%s %d", name, i/len(publisherNames)+1)
		}

		out = append(out, Publisher{
			PublisherID:    fmt.Sprintf("pub_%06d", i),
			Name:           name,
			PayoutCurrency: "USD",
		})
	}

	return out
}

func buildProducts(rng *rand.Rand, count int) []Product {
	out := make([]Product, 0, count)

	for i := 0; i < count; i++ {
		cat := categories[rng.Intn(len(categories))]
		brand := brands[rng.Intn(len(brands))]
		productType := cat.Types[rng.Intn(len(cat.Types))]
		modifier := cat.Modifiers[rng.Intn(len(cat.Modifiers))]
		unit := cat.Units[rng.Intn(len(cat.Units))]
		color := colors[rng.Intn(len(colors))]

		title := fmt.Sprintf("%s %s %s %s %s", brand, modifier, productType, unit, color)

		out = append(out, Product{
			ProductID:      fmt.Sprintf("prd_%08d", i),
			CanonicalTitle: title,
			Brand:          brand,
			CategoryID:     cat.ID,
			Description:    buildDescription(productType, modifier, unit, color),
			AttributesJSON: buildAttributes(modifier, unit, color),
		})
	}

	return out
}

func buildDescription(productType, modifier, unit, color string) string {
	return fmt.Sprintf(
		"The %s %s delivers %s performance in a %s finish. Rated at %s. Designed for daily use with a two-year warranty.",
		modifier, productType, strings.ToLower(modifier), strings.ToLower(color), unit,
	)
}

func buildAttributes(modifier, unit, color string) string {
	return fmt.Sprintf(
		`{"color":%q,"spec":%q,"feature":%q}`,
		color, unit, modifier,
	)
}

// buildListings fans each canonical product across a random subset of
// merchants. This is the function that creates the demo's central data
// characteristic: duplication across merchants with price and title drift.
func buildListings(rng *rand.Rand, products []Product, merchants []Merchant) []Listing {
	estimated := len(products) * (MinMerchantsPerProduct + MaxMerchantsPerProduct) / 2
	out := make([]Listing, 0, estimated)

	listingSeq := 0

	for _, p := range products {
		offerCount := MinMerchantsPerProduct + rng.Intn(MaxMerchantsPerProduct-MinMerchantsPerProduct+1)
		referencePrice := int64(MinPriceCents + rng.Intn(MaxPriceCents-MinPriceCents))

		for _, m := range pickMerchants(rng, merchants, offerCount) {
			out = append(out, Listing{
				ListingID:     fmt.Sprintf("lst_%010d", listingSeq),
				ProductID:     p.ProductID,
				MerchantID:    m.MerchantID,
				MerchantSKU:   fmt.Sprintf("%s-%s", strings.ToUpper(m.MerchantID[4:]), p.ProductID[4:]),
				ListingTitle:  driftTitle(rng, p.Brand, p.CanonicalTitle),
				PriceCents:    varyPrice(rng, referencePrice),
				Currency:      "USD",
				InStock:       rng.Intn(OutOfStockOdds) != 0,
				CommissionBps: varyCommission(rng, m.DefaultCommissionBps),
				DeepLinkURL:   fmt.Sprintf("https://%s.example/p/%s", m.MerchantID, p.ProductID),
			})
			listingSeq++
		}
	}

	return out
}

// pickMerchants draws a distinct subset without allocating a full shuffle of
// the merchant slice per product, which matters at a million listings.
func pickMerchants(rng *rand.Rand, merchants []Merchant, want int) []Merchant {
	if want >= len(merchants) {
		return merchants
	}

	chosen := make(map[int]struct{}, want)
	out := make([]Merchant, 0, want)

	for len(out) < want {
		idx := rng.Intn(len(merchants))
		if _, seen := chosen[idx]; seen {
			continue
		}
		chosen[idx] = struct{}{}
		out = append(out, merchants[idx])
	}

	return out
}

func varyPrice(rng *rand.Rand, reference int64) int64 {
	swing := (reference * int64(rng.Intn(PriceVarianceBps*2))) / 10_000
	adjusted := reference - (reference*PriceVarianceBps)/10_000 + swing

	if adjusted < MinPriceCents {
		return MinPriceCents
	}

	return adjusted
}

func varyCommission(rng *rand.Rand, base int) int {
	swing := rng.Intn(200) - 100
	adjusted := base + swing

	if adjusted < MinCommissionBps {
		return MinCommissionBps
	}
	if adjusted > MaxCommissionBps {
		return MaxCommissionBps
	}

	return adjusted
}

func driftTitle(rng *rand.Rand, brand, canonicalTitle string) string {
	template := titleDriftTemplates[rng.Intn(len(titleDriftTemplates))]
	withoutBrand := strings.TrimSpace(strings.TrimPrefix(canonicalTitle, brand))

	return fmt.Sprintf(template, brand, withoutBrand)
}
