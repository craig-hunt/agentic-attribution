# Data generation

The catalog runs synthetic and deterministic. This document explains both
choices, and the one structural property the generator exists to produce.

---

## Why synthetic

A real affiliate catalog cannot ship in a public repository. Merchant feeds
carry commercial terms, and the commission rates attached to them carry the
sensitivity rather than the product data.

Synthetic data also buys something a scrubbed real extract would not: control
over the exact distribution the demo needs. Four properties matter here:
duplication rate, price variance across merchants, title drift, and stock
availability. A real extract gives whatever those happened to hold on the day
someone captured it; a generator gives them on purpose.

## Why deterministic

`--seed 42` produces byte-identical output on every machine. The published
latency numbers describe a specific corpus, and a reviewer who cannot reproduce
that corpus cannot reproduce the measurement either.

A fingerprint test pins the exact catalog for a fixed seed, so a change to the
arithmetic, the constants, or the order the PRNG yields values fails a test
rather than quietly invalidating the benchmarks.

```bash
go test ./internal/generator/ -run Fingerprint
```

---

## The structure that matters

**One product, many merchants.** Three to eight merchants list each canonical
product. That single property makes the rest of the system non-trivial.

Without it the system faces no deduplication problem, no best-offer selection,
no reason for a commission rate to vary by merchant, and no reason for the
attribution assertion to carry a rate at all. A catalog of distinct products
would model a search problem rather than an affiliate one.

Around that, four kinds of variance:

| Property | Range | Why it exists |
|---|---|---|
| Price | ±18% around a per-product reference | Best-offer selection has something to select |
| Commission | ±100 bps around each merchant's default, clamped to 150–1200 | The signed rate and the listed rate can differ, which settlement has to reconcile |
| Title | Six templates recombining brand and model text | Merchant feeds drift, which makes deduplication hard |
| Stock | Roughly one listing in twelve out of stock | Availability filtering has something to exclude |

**Title drift rewards dwelling on.** Real merchant feeds never agree
on a product's name. The generator recombines the brand and the remaining title
text through several templates, so the same product arrives as "Ironwood Trail
Runner Pro", "Trail Runner Pro by Ironwood", and "Ironwood | Trail Runner Pro"
depending on the merchant. Both halves always survive, so the pieces stay
findable; the arrangement does not.

---

## Scale

```bash
make seed CANONICAL_PRODUCTS=150000
```

The default of 20,000 canonical products fans out to roughly 110,000 listings.
Generation itself takes about 200ms and the Postgres load about two seconds.
Indexing dominates everything else, because each product embeds through the
ONNX model before it reaches OpenSearch, which puts the default catalog at
roughly six minutes on a laptop and the first run higher still while the model
artifact downloads. 150,000 produces close to a million listings, the figure
the benchmark numbers describe.

Both fit comfortably on a laptop. The larger corpus earns its place because
`refresh_interval`, replica count, and force merge stop reading as theory and
start dominating the wall clock, which [`SCALING.md`](SCALING.md) discusses.

---

## What it deliberately does not model

**Category coherence.** Products draw from a shared vocabulary rather than a
category taxonomy, so a semantic search returns plausible neighbours without
the corpus encoding real category structure.

**Seasonal or temporal variation.** Every listing generates at once with no
price history. Real feeds change daily, and the reload path exists to handle
that, but the generator produces a single snapshot.

**Merchant quality variance.** Every merchant's feed arrives equally complete.
Real feeds carry missing fields, wrong categories, and stale prices at wildly
different rates, and a production ingest spends much of its complexity there.

**Adversarial data.** No merchant tries to game the catalog. See
[`PRODUCTIONALIZING.md`](PRODUCTIONALIZING.md) for what that would require.
