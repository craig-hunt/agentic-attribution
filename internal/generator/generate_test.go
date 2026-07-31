package generator

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func testConfig() Config {
	return Config{Seed: 42, CanonicalProducts: 200, MerchantCount: 12, PublisherCount: 5}
}

// Determinism is the generator's entire contract. Published benchmark numbers
// mean nothing if a reviewer running the same seed gets a different catalog.
func TestGenerateIsDeterministicForASeed(t *testing.T) {
	first := Generate(testConfig())
	second := Generate(testConfig())

	if len(first.Listings) != len(second.Listings) {
		t.Fatalf("listing counts diverged: %d then %d", len(first.Listings), len(second.Listings))
	}

	for i := range first.Listings {
		if first.Listings[i] != second.Listings[i] {
			t.Fatalf("listing %d diverged:\n first: %+v\nsecond: %+v", i, first.Listings[i], second.Listings[i])
		}
	}

	for i := range first.Products {
		if first.Products[i] != second.Products[i] {
			t.Fatalf("product %d diverged", i)
		}
	}
}

func TestDifferentSeedsProduceDifferentCatalogs(t *testing.T) {
	a := Generate(testConfig())

	other := testConfig()
	other.Seed = 43
	b := Generate(other)

	identical := len(a.Listings) == len(b.Listings)
	if identical {
		for i := range a.Listings {
			if a.Listings[i] != b.Listings[i] {
				identical = false
				break
			}
		}
	}

	if identical {
		t.Fatal("seeds 42 and 43 produced identical catalogs, so the seed does not reach the generator")
	}
}

func TestGenerateHonoursRequestedCounts(t *testing.T) {
	cfg := testConfig()
	catalog := Generate(cfg)

	if len(catalog.Products) != cfg.CanonicalProducts {
		t.Errorf("products = %d, want %d", len(catalog.Products), cfg.CanonicalProducts)
	}
	if len(catalog.Merchants) != cfg.MerchantCount {
		t.Errorf("merchants = %d, want %d", len(catalog.Merchants), cfg.MerchantCount)
	}
	if len(catalog.Publishers) != cfg.PublisherCount {
		t.Errorf("publishers = %d, want %d", len(catalog.Publishers), cfg.PublisherCount)
	}
}

// The same product listed by many merchants is the pattern the whole demo
// exists to handle. A generator producing one offer per product would make the
// deduplication and best-offer logic untestable downstream.
func TestEveryProductCarriesSeveralDistinctMerchantOffers(t *testing.T) {
	catalog := Generate(testConfig())

	offersPerProduct := make(map[string][]string)
	for _, l := range catalog.Listings {
		offersPerProduct[l.ProductID] = append(offersPerProduct[l.ProductID], l.MerchantID)
	}

	if len(offersPerProduct) != len(catalog.Products) {
		t.Fatalf("%d products carry listings, want %d", len(offersPerProduct), len(catalog.Products))
	}

	for productID, merchants := range offersPerProduct {
		if len(merchants) < MinMerchantsPerProduct || len(merchants) > MaxMerchantsPerProduct {
			t.Fatalf("%s carries %d offers, want %d..%d",
				productID, len(merchants), MinMerchantsPerProduct, MaxMerchantsPerProduct)
		}

		seen := make(map[string]bool, len(merchants))
		for _, m := range merchants {
			if seen[m] {
				t.Fatalf("%s carries two offers from %s, so pickMerchants returned a duplicate", productID, m)
			}
			seen[m] = true
		}
	}
}

func TestListingIdentifiersAreUnique(t *testing.T) {
	catalog := Generate(testConfig())

	seen := make(map[string]bool, len(catalog.Listings))
	for _, l := range catalog.Listings {
		if seen[l.ListingID] {
			t.Fatalf("duplicate listing id %s", l.ListingID)
		}
		seen[l.ListingID] = true
	}

	for _, p := range catalog.Products {
		if !strings.HasPrefix(p.ProductID, "prd_") {
			t.Fatalf("product id %q lacks the prd_ prefix", p.ProductID)
		}
	}
}

// Every listing lands in Postgres against CHECK constraints and a foreign key.
// A generator emitting an out-of-range commission or an unknown merchant fails
// the COPY rather than a test, which is a far worse place to learn about it.
func TestListingsSatisfyTheDatabaseConstraints(t *testing.T) {
	catalog := Generate(testConfig())

	knownMerchants := make(map[string]bool, len(catalog.Merchants))
	for _, m := range catalog.Merchants {
		knownMerchants[m.MerchantID] = true
	}

	knownProducts := make(map[string]bool, len(catalog.Products))
	for _, p := range catalog.Products {
		knownProducts[p.ProductID] = true
	}

	for _, l := range catalog.Listings {
		if !knownMerchants[l.MerchantID] {
			t.Fatalf("listing %s references unknown merchant %s", l.ListingID, l.MerchantID)
		}
		if !knownProducts[l.ProductID] {
			t.Fatalf("listing %s references unknown product %s", l.ListingID, l.ProductID)
		}
		if l.PriceCents < MinPriceCents {
			t.Fatalf("listing %s priced at %d, below the floor of %d", l.ListingID, l.PriceCents, MinPriceCents)
		}
		if l.CommissionBps < 0 || l.CommissionBps > 10_000 {
			t.Fatalf("listing %s carries commission_bps %d, outside 0..10000", l.ListingID, l.CommissionBps)
		}
		if l.Currency != "USD" {
			t.Fatalf("listing %s carries currency %q", l.ListingID, l.Currency)
		}
		if l.DeepLinkURL == "" || l.ListingTitle == "" || l.MerchantSKU == "" {
			t.Fatalf("listing %s carries an empty required field: %+v", l.ListingID, l)
		}
	}
}

func TestMerchantsSatisfyTheDatabaseConstraints(t *testing.T) {
	catalog := Generate(testConfig())

	for _, m := range catalog.Merchants {
		if m.DefaultCommissionBps < 0 || m.DefaultCommissionBps > 10_000 {
			t.Fatalf("%s carries default_commission_bps %d", m.MerchantID, m.DefaultCommissionBps)
		}
		if m.HoldPeriodDays < 0 || m.ReversalWindowDays < 0 {
			t.Fatalf("%s carries a negative window: %+v", m.MerchantID, m)
		}
		if m.Name == "" {
			t.Fatalf("%s carries no name", m.MerchantID)
		}
	}

	for _, p := range catalog.Publishers {
		if p.PayoutCurrency == "" || p.Name == "" {
			t.Fatalf("publisher %s incomplete: %+v", p.PublisherID, p)
		}
	}
}

// Prices vary per merchant so best-offer selection has something to select.
// A generator emitting one price across every offer would make the cheapest
// in-stock choice arbitrary and the demo's selection logic meaningless.
func TestPricesVaryAcrossMerchantsForTheSameProduct(t *testing.T) {
	catalog := Generate(testConfig())

	pricesByProduct := make(map[string]map[int64]bool)
	for _, l := range catalog.Listings {
		if pricesByProduct[l.ProductID] == nil {
			pricesByProduct[l.ProductID] = make(map[int64]bool)
		}
		pricesByProduct[l.ProductID][l.PriceCents] = true
	}

	varied := 0
	for _, prices := range pricesByProduct {
		if len(prices) > 1 {
			varied++
		}
	}

	if varied < len(pricesByProduct)/2 {
		t.Fatalf("only %d of %d products carry differing prices across merchants", varied, len(pricesByProduct))
	}
}

// Merchant feeds drift from the canonical title in the real world, which is
// what makes deduplication hard. A generator emitting the canonical title
// everywhere would model a problem nobody has.
func TestListingTitlesDriftFromTheCanonicalTitle(t *testing.T) {
	catalog := Generate(testConfig())

	canonical := make(map[string]string, len(catalog.Products))
	for _, p := range catalog.Products {
		canonical[p.ProductID] = p.CanonicalTitle
	}

	drifted := 0
	for _, l := range catalog.Listings {
		if l.ListingTitle != canonical[l.ProductID] {
			drifted++
		}
	}

	if drifted == 0 {
		t.Fatal("no listing title drifted from its canonical title")
	}
}

func TestSomeListingsSitOutOfStock(t *testing.T) {
	catalog := Generate(testConfig())

	out := 0
	for _, l := range catalog.Listings {
		if !l.InStock {
			out++
		}
	}

	if out == 0 {
		t.Fatal("every listing reports in stock, so availability filtering has nothing to exclude")
	}
	if out == len(catalog.Listings) {
		t.Fatal("every listing reports out of stock")
	}
}

// The attributes column is JSONB. Postgres rejects the COPY outright on
// malformed JSON, so this catches at test time what would otherwise surface as
// a failed bulk load partway through.
func TestProductAttributesParseAsJSON(t *testing.T) {
	catalog := Generate(testConfig())

	for _, p := range catalog.Products {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(p.AttributesJSON), &parsed); err != nil {
			t.Fatalf("%s carries invalid attributes JSON %q: %v", p.ProductID, p.AttributesJSON, err)
		}
		if len(parsed) == 0 {
			t.Fatalf("%s carries empty attributes", p.ProductID)
		}
		if p.Description == "" || p.Brand == "" || p.CategoryID == "" {
			t.Fatalf("%s incomplete: %+v", p.ProductID, p)
		}
	}
}

func TestPickMerchantsReturnsEveryMerchantWhenAskedForMoreThanExist(t *testing.T) {
	catalog := Generate(testConfig())
	cfg := testConfig()
	cfg.MerchantCount = 2
	small := Generate(cfg)

	// With fewer merchants than the per-product minimum, every product has to
	// fall back to the full set rather than looping forever looking for a
	// distinct draw that does not exist.
	for _, l := range small.Listings {
		if l.MerchantID == "" {
			t.Fatal("a listing carries no merchant")
		}
	}

	if len(small.Merchants) != 2 {
		t.Fatalf("merchant count = %d, want 2", len(small.Merchants))
	}
	if len(catalog.Merchants) == len(small.Merchants) {
		t.Fatal("merchant count did not track the config")
	}
}

func TestGenerateHandlesAMinimalCatalog(t *testing.T) {
	catalog := Generate(Config{Seed: 1, CanonicalProducts: 1, MerchantCount: 1, PublisherCount: 1})

	if len(catalog.Products) != 1 || len(catalog.Merchants) != 1 || len(catalog.Publishers) != 1 {
		t.Fatalf("minimal catalog malformed: %d products, %d merchants, %d publishers",
			len(catalog.Products), len(catalog.Merchants), len(catalog.Publishers))
	}
	if len(catalog.Listings) != 1 {
		t.Fatalf("one product and one merchant should yield one listing, got %d", len(catalog.Listings))
	}
}

func TestGenerateHandlesAnEmptyCatalog(t *testing.T) {
	catalog := Generate(Config{Seed: 1})

	if len(catalog.Products) != 0 || len(catalog.Listings) != 0 {
		t.Fatalf("zero counts should produce nothing, got %d products and %d listings",
			len(catalog.Products), len(catalog.Listings))
	}
}

// The SKU drops the four-character prefix from each identifier, so a listing
// stays traceable to both its merchant and its product from the SKU alone.
func TestMerchantSKUDerivesFromBothIdentifiers(t *testing.T) {
	catalog := Generate(testConfig())

	for _, l := range catalog.Listings[:min(20, len(catalog.Listings))] {
		want := fmt.Sprintf("%s-%s", strings.ToUpper(l.MerchantID[4:]), l.ProductID[4:])

		if l.MerchantSKU != want {
			t.Fatalf("sku %q for merchant %s product %s, want %q",
				l.MerchantSKU, l.MerchantID, l.ProductID, want)
		}
	}
}
