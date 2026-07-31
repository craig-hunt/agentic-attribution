package generator

import (
	"encoding/csv"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func readCSV(t *testing.T, path string) ([]string, [][]string) {
	t.Helper()

	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer f.Close()

	records, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(records) == 0 {
		t.Fatalf("%s holds no rows at all, not even a header", path)
	}

	return records[0], records[1:]
}

// Postgres COPY is positional. A reordered column loads the wrong data into the
// wrong field without raising an error, which makes this coupling the most
// dangerous in the pipeline and the one most worth pinning.
func TestHeadersMatchTheCopyColumnOrder(t *testing.T) {
	files, catalog := writeTestCatalog(t)

	cases := []struct {
		path string
		want []string
	}{
		{files.Merchants, merchantColumns},
		{files.Publishers, publisherColumns},
		{files.Products, productColumns},
		{files.Listings, listingColumns},
	}

	for _, tc := range cases {
		header, _ := readCSV(t, tc.path)

		if strings.Join(header, ",") != strings.Join(tc.want, ",") {
			t.Errorf("%s header = %v, want %v", filepath.Base(tc.path), header, tc.want)
		}
	}

	if len(catalog.Listings) == 0 {
		t.Fatal("the fixture catalog produced no listings")
	}
}

func writeTestCatalog(t *testing.T) (Files, Catalog) {
	t.Helper()

	catalog := Generate(Config{Seed: 7, CanonicalProducts: 25, MerchantCount: 6, PublisherCount: 3})

	files, err := WriteCSV(catalog, t.TempDir())
	if err != nil {
		t.Fatalf("WriteCSV: %v", err)
	}

	return files, catalog
}

func TestEveryRowReachesItsFile(t *testing.T) {
	files, catalog := writeTestCatalog(t)

	cases := []struct {
		name string
		path string
		want int
	}{
		{"merchants", files.Merchants, len(catalog.Merchants)},
		{"publishers", files.Publishers, len(catalog.Publishers)},
		{"products", files.Products, len(catalog.Products)},
		{"listings", files.Listings, len(catalog.Listings)},
	}

	for _, tc := range cases {
		_, rows := readCSV(t, tc.path)

		if len(rows) != tc.want {
			t.Errorf("%s holds %d rows, want %d", tc.name, len(rows), tc.want)
		}
	}
}

// Field values have to survive the round trip in the order the header promises,
// because a COPY that silently transposes two columns produces a catalog that
// looks loaded and reads wrong.
func TestListingFieldsLandInTheColumnsTheHeaderNames(t *testing.T) {
	files, catalog := writeTestCatalog(t)
	header, rows := readCSV(t, files.Listings)

	index := make(map[string]int, len(header))
	for i, name := range header {
		index[name] = i
	}

	byID := make(map[string]Listing, len(catalog.Listings))
	for _, l := range catalog.Listings {
		byID[l.ListingID] = l
	}

	for _, row := range rows {
		id := row[index["listing_id"]]

		want, ok := byID[id]
		if !ok {
			t.Fatalf("file holds listing %s that the catalog does not", id)
		}

		if row[index["product_id"]] != want.ProductID {
			t.Errorf("%s product_id = %q, want %q", id, row[index["product_id"]], want.ProductID)
		}
		if row[index["merchant_id"]] != want.MerchantID {
			t.Errorf("%s merchant_id = %q, want %q", id, row[index["merchant_id"]], want.MerchantID)
		}
		if row[index["price_cents"]] != strconv.FormatInt(want.PriceCents, 10) {
			t.Errorf("%s price_cents = %q, want %d", id, row[index["price_cents"]], want.PriceCents)
		}
		if row[index["commission_bps"]] != strconv.Itoa(want.CommissionBps) {
			t.Errorf("%s commission_bps = %q, want %d", id, row[index["commission_bps"]], want.CommissionBps)
		}
		if row[index["merchant_sku"]] != want.MerchantSKU {
			t.Errorf("%s merchant_sku = %q, want %q", id, row[index["merchant_sku"]], want.MerchantSKU)
		}
	}
}

// Postgres COPY reads t and f for booleans in CSV format. Emitting Go's "true"
// and "false" fails the load rather than misreading it, which is at least loud,
// but the round trip belongs under test either way.
func TestBooleansUseThePostgresCopyEncoding(t *testing.T) {
	if boolForCopy(true) != "t" {
		t.Errorf("boolForCopy(true) = %q, want t", boolForCopy(true))
	}
	if boolForCopy(false) != "f" {
		t.Errorf("boolForCopy(false) = %q, want f", boolForCopy(false))
	}

	files, catalog := writeTestCatalog(t)
	header, rows := readCSV(t, files.Listings)

	stockColumn := -1
	for i, name := range header {
		if name == "in_stock" {
			stockColumn = i
		}
	}
	if stockColumn < 0 {
		t.Fatal("the listings header names no in_stock column")
	}

	expected := make(map[string]string, len(catalog.Listings))
	for _, l := range catalog.Listings {
		expected[l.ListingID] = boolForCopy(l.InStock)
	}

	for _, row := range rows {
		got := row[stockColumn]

		if got != "t" && got != "f" {
			t.Fatalf("in_stock = %q, want t or f", got)
		}
		if got != expected[row[0]] {
			t.Errorf("%s in_stock = %q, want %q", row[0], got, expected[row[0]])
		}
	}
}

// Product descriptions and JSON attributes carry commas and quotes. The CSV
// writer has to escape them, or the load shifts every subsequent column on that
// row by one.
func TestFieldsCarryingCommasAndQuotesSurviveTheRoundTrip(t *testing.T) {
	catalog := Catalog{
		Products: []Product{{
			ProductID:      "prd_00000001",
			CanonicalTitle: `Widget, 12" model`,
			Brand:          `Acme "Pro"`,
			CategoryID:     "cat_1",
			Description:    "One, two, three",
			AttributesJSON: `{"color":"red","size":"12\""}`,
		}},
	}

	files, err := WriteCSV(catalog, t.TempDir())
	if err != nil {
		t.Fatalf("WriteCSV: %v", err)
	}

	_, rows := readCSV(t, files.Products)
	if len(rows) != 1 {
		t.Fatalf("wrote %d product rows, want 1", len(rows))
	}

	want := []string{
		"prd_00000001",
		`Widget, 12" model`,
		`Acme "Pro"`,
		"cat_1",
		"One, two, three",
		`{"color":"red","size":"12\""}`,
	}

	for i := range want {
		if rows[0][i] != want[i] {
			t.Errorf("column %d = %q, want %q", i, rows[0][i], want[i])
		}
	}
}

func TestWriteCSVCreatesTheOutputDirectory(t *testing.T) {
	nested := filepath.Join(t.TempDir(), "does", "not", "exist", "yet")

	files, err := WriteCSV(Generate(Config{Seed: 1, CanonicalProducts: 2, MerchantCount: 2, PublisherCount: 1}), nested)
	if err != nil {
		t.Fatalf("WriteCSV into a missing directory: %v", err)
	}

	for _, path := range []string{files.Merchants, files.Publishers, files.Products, files.Listings} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("expected %s to exist: %v", path, err)
		}
	}
}

// An empty catalog still has to produce four files carrying headers. The ingest
// COPY targets all four unconditionally, so a missing file fails the load.
func TestAnEmptyCatalogStillWritesHeaders(t *testing.T) {
	files, err := WriteCSV(Catalog{}, t.TempDir())
	if err != nil {
		t.Fatalf("WriteCSV on an empty catalog: %v", err)
	}

	for _, path := range []string{files.Merchants, files.Publishers, files.Products, files.Listings} {
		header, rows := readCSV(t, path)

		if len(header) == 0 {
			t.Errorf("%s carries no header", filepath.Base(path))
		}
		if len(rows) != 0 {
			t.Errorf("%s carries %d rows, want none", filepath.Base(path), len(rows))
		}
	}
}

func TestWriteCSVReportsAnUnwritableDestination(t *testing.T) {
	// A path whose parent is a regular file cannot become a directory, which
	// exercises the MkdirAll failure branch without depending on permissions
	// that behave differently across filesystems.
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("prepare blocker: %v", err)
	}

	if _, err := WriteCSV(Catalog{}, filepath.Join(blocker, "out")); err == nil {
		t.Fatal("WriteCSV returned no error for a destination it cannot create")
	}
}
