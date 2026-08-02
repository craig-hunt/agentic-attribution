package generator

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

// The generator's contract is reproducibility: the README stakes published
// benchmark numbers on a reviewer running the same seed and getting the same
// catalog. Structural assertions cannot enforce that, because a catalog with
// every price shifted by one still satisfies every range check. Pinning the
// exact output does enforce it, and it fails on any change to the arithmetic,
// the constants, or the order in which values are drawn from the PRNG.
//
// Regenerate deliberately when the catalog shape changes on purpose:
//
//	go test ./internal/generator/ -run Fingerprint -v
//
// then copy the printed digest here. A digest that changes without an
// intended change to the generator means something drifted.
const catalogFingerprint = "cfe1db39d4a8a1438d8572ee83c305800f629b541e460f8b00a2ca27bba9a49c"

func fingerprint(c Catalog) string {
	h := sha256.New()

	for _, m := range c.Merchants {
		fmt.Fprintf(h, "M|%s|%s|%d|%d|%d\n",
			m.MerchantID, m.Name, m.DefaultCommissionBps, m.HoldPeriodDays, m.ReversalWindowDays)
	}
	for _, p := range c.Publishers {
		fmt.Fprintf(h, "U|%s|%s|%s\n", p.PublisherID, p.Name, p.PayoutCurrency)
	}
	for _, p := range c.Products {
		fmt.Fprintf(h, "P|%s|%s|%s|%s|%s|%s\n",
			p.ProductID, p.CanonicalTitle, p.Brand, p.CategoryID, p.Description, p.AttributesJSON)
	}
	for _, l := range c.Listings {
		fmt.Fprintf(h, "L|%s|%s|%s|%s|%s|%d|%s|%t|%d|%s\n",
			l.ListingID, l.ProductID, l.MerchantID, l.MerchantSKU, l.ListingTitle,
			l.PriceCents, l.Currency, l.InStock, l.CommissionBps, l.DeepLinkURL)
	}

	return hex.EncodeToString(h.Sum(nil))
}

func TestCatalogFingerprint(t *testing.T) {
	got := fingerprint(Generate(Config{
		Seed: 42, CanonicalProducts: 50, MerchantCount: 8, PublisherCount: 4,
	}))

	if catalogFingerprint == "" {
		t.Fatalf("no fingerprint recorded; set catalogFingerprint to:\n\t%s", got)
	}

	if got != catalogFingerprint {
		t.Fatalf("the catalog changed for seed 42.\n got: %s\nwant: %s\n\n"+
			"Either a change to the generator altered its output, which means the "+
			"published benchmark numbers no longer describe what this produces, or "+
			"an intended change needs the constant updated.", got, catalogFingerprint)
	}
}

// varyPrice swings a reference price within a band. Every operator in it
// changes the result, so exact expected values catch what a range check cannot.
func TestVaryPriceProducesExactValues(t *testing.T) {
	cases := []struct {
		name      string
		seed      int64
		reference int64
	}{
		{"mid range", 1, 50_000},
		{"near the floor", 2, MinPriceCents + 100},
		{"high", 3, 400_000},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rng := rand.New(rand.NewSource(tc.seed))
			draw := rand.New(rand.NewSource(tc.seed)).Intn(PriceVarianceBps * 2)

			// The same arithmetic the function performs, written out so a
			// mutated operator inside varyPrice diverges from it.
			swing := (tc.reference * int64(draw)) / 10_000
			want := tc.reference - (tc.reference*PriceVarianceBps)/10_000 + swing
			if want < MinPriceCents {
				want = MinPriceCents
			}

			if got := varyPrice(rng, tc.reference); got != want {
				t.Fatalf("varyPrice(%d) = %d, want %d", tc.reference, got, want)
			}
		})
	}
}

// The floor exists so a downward swing on a cheap product cannot price it
// below the minimum, which Postgres would accept and a reviewer would read as
// a generator bug.
func TestVaryPriceClampsAtTheFloor(t *testing.T) {
	// A reference at the floor can only swing downward from there, so every
	// draw has to clamp.
	for seed := int64(0); seed < 50; seed++ {
		got := varyPrice(rand.New(rand.NewSource(seed)), MinPriceCents)

		if got < MinPriceCents {
			t.Fatalf("seed %d produced %d, below the floor of %d", seed, got, MinPriceCents)
		}
	}

	// A reference of zero forces the clamp on every path.
	if got := varyPrice(rand.New(rand.NewSource(1)), 0); got != MinPriceCents {
		t.Fatalf("a zero reference produced %d, want the floor %d", got, MinPriceCents)
	}
}

func TestVaryPriceStaysInsideItsBand(t *testing.T) {
	const reference int64 = 100_000

	lowest, highest := int64(1<<62), int64(0)

	for seed := int64(0); seed < 500; seed++ {
		got := varyPrice(rand.New(rand.NewSource(seed)), reference)

		if got < lowest {
			lowest = got
		}
		if got > highest {
			highest = got
		}
	}

	maxSwing := (reference * PriceVarianceBps) / 10_000

	if lowest < reference-maxSwing {
		t.Errorf("lowest price %d fell below reference-%d", lowest, maxSwing)
	}
	if highest > reference+maxSwing {
		t.Errorf("highest price %d rose above reference+%d", highest, maxSwing)
	}

	// The band has to actually span. A generator emitting the reference price
	// every time would satisfy the bounds above and defeat best-offer
	// selection entirely.
	if highest-lowest < maxSwing {
		t.Errorf("prices spanned only %d across 500 seeds, want at least %d", highest-lowest, maxSwing)
	}
}

func TestVaryCommissionProducesExactValues(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		base := 400 + int(seed)*30

		draw := rand.New(rand.NewSource(seed)).Intn(200) - 100
		want := base + draw
		if want < MinCommissionBps {
			want = MinCommissionBps
		}
		if want > MaxCommissionBps {
			want = MaxCommissionBps
		}

		if got := varyCommission(rand.New(rand.NewSource(seed)), base); got != want {
			t.Fatalf("varyCommission(seed %d, base %d) = %d, want %d", seed, base, got, want)
		}
	}
}

// Both clamps exist because the listings table carries a CHECK constraint on
// the range. A commission outside it fails the COPY partway through a load.
func TestVaryCommissionClampsBothEnds(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		rng := rand.New(rand.NewSource(seed))

		if got := varyCommission(rng, MinCommissionBps); got < MinCommissionBps {
			t.Fatalf("seed %d produced %d, below the floor %d", seed, got, MinCommissionBps)
		}
	}

	for seed := int64(0); seed < 100; seed++ {
		rng := rand.New(rand.NewSource(seed))

		if got := varyCommission(rng, MaxCommissionBps); got > MaxCommissionBps {
			t.Fatalf("seed %d produced %d, above the ceiling %d", seed, got, MaxCommissionBps)
		}
	}

	// Far outside the range on both sides, so the clamp is the only path.
	if got := varyCommission(rand.New(rand.NewSource(1)), -5_000); got != MinCommissionBps {
		t.Fatalf("a base far below the floor produced %d, want %d", got, MinCommissionBps)
	}
	if got := varyCommission(rand.New(rand.NewSource(1)), 50_000); got != MaxCommissionBps {
		t.Fatalf("a base far above the ceiling produced %d, want %d", got, MaxCommissionBps)
	}
}

// The subset draw has to return exactly the requested count, distinct, and has
// to fall back to the whole slice rather than looping forever when the request
// exceeds what exists.
func TestPickMerchantsReturnsExactlyTheRequestedDistinctCount(t *testing.T) {
	merchants := Generate(Config{Seed: 1, MerchantCount: 10}).Merchants

	for want := 1; want <= len(merchants); want++ {
		got := pickMerchants(rand.New(rand.NewSource(int64(want))), merchants, want)

		if len(got) != want {
			t.Fatalf("asked for %d merchants, got %d", want, len(got))
		}

		seen := make(map[string]bool, len(got))
		for _, m := range got {
			if seen[m.MerchantID] {
				t.Fatalf("asking for %d returned %s twice", want, m.MerchantID)
			}
			seen[m.MerchantID] = true
		}
	}
}

func TestPickMerchantsFallsBackWhenAskedForMoreThanExist(t *testing.T) {
	merchants := Generate(Config{Seed: 1, MerchantCount: 3}).Merchants

	for _, want := range []int{3, 4, 100} {
		got := pickMerchants(rand.New(rand.NewSource(1)), merchants, want)

		if len(got) != len(merchants) {
			t.Fatalf("asking for %d from %d returned %d", want, len(merchants), len(got))
		}
	}
}

// Identifier widths are load bearing: the SKU slices a fixed prefix off both
// the merchant and product identifiers, so a narrower format panics and a
// wider one produces a wrong SKU.
func TestIdentifierFormatsAreFixedWidth(t *testing.T) {
	catalog := Generate(Config{Seed: 1, CanonicalProducts: 3, MerchantCount: 2, PublisherCount: 2})

	if catalog.Merchants[0].MerchantID != "mer_000000" {
		t.Errorf("first merchant id = %q, want mer_000000", catalog.Merchants[0].MerchantID)
	}
	if catalog.Merchants[1].MerchantID != "mer_000001" {
		t.Errorf("second merchant id = %q, want mer_000001", catalog.Merchants[1].MerchantID)
	}
	if catalog.Publishers[0].PublisherID != "pub_000000" {
		t.Errorf("first publisher id = %q", catalog.Publishers[0].PublisherID)
	}
	if catalog.Products[0].ProductID != "prd_00000000" {
		t.Errorf("first product id = %q, want prd_00000000", catalog.Products[0].ProductID)
	}
	if catalog.Listings[0].ListingID != "lst_0000000000" {
		t.Errorf("first listing id = %q, want lst_0000000000", catalog.Listings[0].ListingID)
	}
}

// Publisher names cycle through a fixed vocabulary and gain a numeric suffix
// once it runs out, so a larger catalog never carries duplicate names.
func TestPublisherNamesStayDistinctPastTheVocabulary(t *testing.T) {
	count := len(publisherNames) * 2

	publishers := Generate(Config{Seed: 1, PublisherCount: count}).Publishers

	seen := make(map[string]bool, count)
	for _, p := range publishers {
		if seen[p.Name] {
			t.Fatalf("duplicate publisher name %q", p.Name)
		}
		seen[p.Name] = true
	}

	// The first pass through the vocabulary carries no suffix, and the second
	// carries 2 rather than 1, because the first pass is generation one.
	if publishers[0].Name != publisherNames[0] {
		t.Errorf("first name = %q, want the bare vocabulary entry %q", publishers[0].Name, publisherNames[0])
	}
	if want := fmt.Sprintf("%s 2", publisherNames[0]); publishers[len(publisherNames)].Name != want {
		t.Errorf("name after the vocabulary wraps = %q, want %q", publishers[len(publisherNames)].Name, want)
	}
}

// Merchant commission sits inside the declared range on every draw, since the
// listings CHECK constraint rejects anything outside it.
func TestMerchantCommissionStaysInsideTheDeclaredRange(t *testing.T) {
	merchants := Generate(Config{Seed: 9, MerchantCount: 400}).Merchants

	lowest, highest := MaxCommissionBps, MinCommissionBps

	for _, m := range merchants {
		if m.DefaultCommissionBps < MinCommissionBps || m.DefaultCommissionBps >= MaxCommissionBps {
			t.Fatalf("%s carries %d, outside [%d, %d)",
				m.MerchantID, m.DefaultCommissionBps, MinCommissionBps, MaxCommissionBps)
		}
		if m.DefaultCommissionBps < lowest {
			lowest = m.DefaultCommissionBps
		}
		if m.DefaultCommissionBps > highest {
			highest = m.DefaultCommissionBps
		}
	}

	// The rates have to spread. Every merchant sharing one rate would make
	// commission comparison across offers meaningless.
	if highest-lowest < (MaxCommissionBps-MinCommissionBps)/2 {
		t.Fatalf("commission spanned only %d..%d across 400 merchants", lowest, highest)
	}

	for _, m := range merchants {
		if m.HoldPeriodDays != 30 && m.HoldPeriodDays != 45 && m.HoldPeriodDays != 60 {
			t.Fatalf("%s carries hold period %d", m.MerchantID, m.HoldPeriodDays)
		}
		if m.ReversalWindowDays != 60 && m.ReversalWindowDays != 90 && m.ReversalWindowDays != 120 {
			t.Fatalf("%s carries reversal window %d", m.MerchantID, m.ReversalWindowDays)
		}
	}
}

// Roughly one listing in twelve sits out of stock, so availability filtering
// has something to exclude. A ratio that drifted far from that would make the
// in-stock filter either useless or catastrophic.
func TestOutOfStockRatioApproximatesTheDeclaredOdds(t *testing.T) {
	listings := Generate(Config{Seed: 3, CanonicalProducts: 2_000, MerchantCount: 10, PublisherCount: 2}).Listings

	out := 0
	for _, l := range listings {
		if !l.InStock {
			out++
		}
	}

	ratio := float64(out) / float64(len(listings))
	expected := 1.0 / float64(OutOfStockOdds)

	if ratio < expected*0.7 || ratio > expected*1.3 {
		t.Fatalf("out-of-stock ratio %.4f across %d listings, want near %.4f",
			ratio, len(listings), expected)
	}
}

// Titles drift by recombining the brand and the rest of the canonical title
// through one of several templates, which is how real merchant feeds diverge.
// Both halves have to survive: a drift that dropped the brand or the model
// text would make deduplication trivially easy and model a problem nobody has.
func TestDriftedTitlesKeepBothTheBrandAndTheModelText(t *testing.T) {
	catalog := Generate(Config{Seed: 5, CanonicalProducts: 100, MerchantCount: 6, PublisherCount: 2})

	type product struct{ brand, canonical string }

	byID := make(map[string]product, len(catalog.Products))
	for _, p := range catalog.Products {
		byID[p.ProductID] = product{p.Brand, p.CanonicalTitle}
	}

	variants := make(map[string]map[string]bool)

	for _, l := range catalog.Listings {
		p := byID[l.ProductID]
		withoutBrand := strings.TrimSpace(strings.TrimPrefix(p.canonical, p.brand))

		if !strings.Contains(l.ListingTitle, p.brand) {
			t.Fatalf("%s title %q dropped the brand %q", l.ListingID, l.ListingTitle, p.brand)
		}
		if !strings.Contains(l.ListingTitle, withoutBrand) {
			t.Fatalf("%s title %q dropped the model text %q", l.ListingID, l.ListingTitle, withoutBrand)
		}

		if variants[l.ProductID] == nil {
			variants[l.ProductID] = make(map[string]bool)
		}
		variants[l.ProductID][l.ListingTitle] = true
	}

	// Several distinct forms have to appear, or the drift is a no-op and the
	// deduplication problem the demo exists to show never arises.
	multi := 0
	for _, forms := range variants {
		if len(forms) > 1 {
			multi++
		}
	}
	if multi < len(variants)/2 {
		t.Fatalf("only %d of %d products carry differing titles across merchants", multi, len(variants))
	}
}

// Every drift template has to produce a distinct rendering. A duplicate entry
// in the table would quietly halve the variation without failing anything.
func TestEveryDriftTemplateProducesADistinctForm(t *testing.T) {
	seen := make(map[string]int, len(titleDriftTemplates))

	for i := 0; i < len(titleDriftTemplates)*200; i++ {
		got := driftTitle(rand.New(rand.NewSource(int64(i))), "Ironwood", "Ironwood Trail Runner Pro")
		seen[got]++
	}

	if len(seen) != len(titleDriftTemplates) {
		t.Fatalf("produced %d distinct forms from %d templates: %v",
			len(seen), len(titleDriftTemplates), seen)
	}

	for form := range seen {
		if !strings.Contains(form, "Ironwood") || !strings.Contains(form, "Trail Runner Pro") {
			t.Errorf("form %q lost a half of the title", form)
		}
	}
}

// The brand gets stripped before recombination, so a title that does not start
// with its brand still renders without mangling.
func TestDriftHandlesATitleThatDoesNotLeadWithItsBrand(t *testing.T) {
	got := driftTitle(rand.New(rand.NewSource(1)), "Ironwood", "Trail Runner Pro")

	if !strings.Contains(got, "Trail Runner Pro") {
		t.Fatalf("drift mangled a title that does not lead with its brand: %q", got)
	}
}
