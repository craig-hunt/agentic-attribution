package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/craig-hunt/agentic-attribution/internal/generator"
)

const (
	defaultSeed              = 42
	defaultCanonicalProducts = 150_000
	defaultMerchants         = 2_000
	defaultPublishers        = 48
	defaultOutDir            = "db/seed"
)

func main() {
	cfg := generator.Config{}
	var outDir string

	flag.Int64Var(&cfg.Seed, "seed", defaultSeed, "PRNG seed; identical seeds produce identical catalogs")
	flag.IntVar(&cfg.CanonicalProducts, "canonical", defaultCanonicalProducts, "distinct real-world products")
	flag.IntVar(&cfg.MerchantCount, "merchants", defaultMerchants, "merchants listing those products")
	flag.IntVar(&cfg.PublisherCount, "publishers", defaultPublishers, "publishers earning attribution")
	flag.StringVar(&outDir, "out", defaultOutDir, "directory for the COPY-ready CSV files")
	flag.Parse()

	if cfg.CanonicalProducts < 1 {
		log.Fatal("canonical must exceed zero")
	}
	if cfg.MerchantCount < generator.MinMerchantsPerProduct {
		log.Fatalf("merchants must reach at least %d", generator.MinMerchantsPerProduct)
	}
	if cfg.PublisherCount < 1 {
		log.Fatal("publishers must exceed zero")
	}

	start := time.Now()
	catalog := generator.Generate(cfg)
	generated := time.Since(start)

	start = time.Now()
	files, err := generator.WriteCSV(catalog, outDir)
	if err != nil {
		log.Fatalf("write csv: %v", err)
	}
	written := time.Since(start)

	avgOffers := float64(len(catalog.Listings)) / float64(len(catalog.Products))

	fmt.Fprintf(os.Stdout, `catalog generated (seed %d)

  merchants          %s
  publishers         %s
  canonical products %s
  merchant listings  %s
  avg offers/product %.2f

  generate  %s
  write     %s

files:
  %s
  %s
  %s
  %s
`,
		cfg.Seed,
		commas(len(catalog.Merchants)),
		commas(len(catalog.Publishers)),
		commas(len(catalog.Products)),
		commas(len(catalog.Listings)),
		avgOffers,
		generated.Round(time.Millisecond),
		written.Round(time.Millisecond),
		files.Merchants,
		files.Publishers,
		files.Products,
		files.Listings,
	)
}

func commas(n int) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}

	var out []byte
	for i, digit := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, digit)
	}

	return string(out)
}
