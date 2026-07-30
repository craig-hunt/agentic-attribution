# Architecture

## Design principles

Four principles drove every structural decision in this system.

**1. Keep inference and enrichment off the serving path.** Embeddings, categorization, and deduplication run once during ingest. Serving reads precomputed values. A system that runs inference per request pays for it on every request and forfeits its latency budget.

**2. Separate workloads before separating codebases.** Ingest and serving compete for connection pools, memory, and database resources. Isolating those resources delivers most of the benefit of decomposition at a fraction of the risk. This demo runs services separately because the boundaries are already known; a production monolith would start with process and data-path isolation inside the existing application.

**3. Choose the language per workload.** Application layers and data-path services optimize for different properties. See ADR-0001.

**4. Attribution must survive the agent boundary.** Every design choice in the attribution layer assumes no browser, no cookie, no referrer, and no guarantee the platform observes the transaction.

---

## Components

### Cloudflare Worker (edge)

**Responsibilities:** x402 protocol gateway, attribution assertion verification, request routing.

Runs at the edge because the 402 challenge-response adds a round trip, and terminating that exchange close to the caller keeps total latency acceptable. The Worker verifies assertion signatures before any origin request, so invalid assertions never consume backend capacity.

**Why not origin:** an agent that fails payment verification should burn edge compute, not a database connection.

### search-svc (Go)

**Responsibilities:** hybrid product search against OpenSearch, sub-100ms serving.

Issues a single OpenSearch query containing both a `multi_match` BM25 subquery and a `knn` vector subquery, processed through a **search pipeline with a normalization processor**. Raw BM25 scores are unbounded and corpus-dependent while cosine similarity runs 0 to 1, so blending them without normalization lets BM25 dominate arbitrarily. The pipeline applies `min_max` normalization and `arithmetic_mean` combination with configurable weights.

Returns products alongside a request identifier the attribution service binds assertions to.

**Latency budget:** p50 under 25ms, p99 under 100ms against 1M listings. Published in `bench/results.md`.

**Query embedding** is the one inference call on this path, cached aggressively on query-text hash. Product embeddings are precomputed at ingest.

### attribution-svc (Go)

**Responsibilities:** mint and verify attribution assertions.

Signs assertions with Ed25519. An assertion binds publisher ID, product ID, search request ID, issue timestamp, and expiry. Verification checks signature validity, expiry, and replay (assertion IDs are single-use, tracked in Redis-equivalent state).

**Why Ed25519:** small signatures (64 bytes), fast verification, no parameter-choice footguns. Signature size matters because the assertion travels inside a payment payload with size constraints.

### settlement-svc (Go)

**Responsibilities:** x402 payment flow, commission calculation, ledger writes.

Issues 402 challenges with `PaymentRequirements`, verifies `PaymentPayload` signatures, submits settlement through the facilitator, and writes double-entry commission records once settlement confirms.

**Commission split:** on confirmed settlement, the ledger records the merchant debit, the platform fee, and the publisher credit as a single atomic transaction. A settlement that confirms on-chain but fails to write the ledger would create an attribution gap, so the ledger write and the settlement confirmation are reconciled rather than assumed.

### PHP application layer

**Responsibilities:** publisher dashboard, agent simulator UI, attribution chain visualization.

PHP 8.3 with a thin router. No framework, because the demo's application surface is small and a framework would obscure rather than clarify. Reads through the Go services rather than hitting Postgres directly, which keeps the data contract in one place.

### Simulated merchant

**Responsibilities:** stand in for a real merchant endpoint.

Accepts purchase requests, returns 402 with payment requirements, verifies the attribution assertion, and confirms fulfillment. Deliberately simple. The demo proves the attribution mechanism, not merchant integration.

### Neon Postgres — the system of record

Three logical concerns in one instance:

- **Canonical catalog** with product identity and attributes
- **Merchant listings** partitioned by merchant bucket
- **Commission ledger** with double-entry records

Postgres owns correctness. Anything involving money lands here first, under transactional guarantees.

Production would separate the ledger onto its own instance for isolation and audit. Documented in PRODUCTIONALIZING.md.

### OpenSearch — the derived search index

**Responsibilities:** hybrid search over the product catalog.

**The index is not the system of record.** It gets rebuilt from Postgres, which means a corrupted index, a mapping change, or a relevance experiment carries no data-loss risk.

**Index design:**

- Multi-field mapping: `title` as `text` for BM25 matching, `title.keyword` for exact filters and aggregations
- `knn_vector` field carrying precomputed product embeddings, HNSW algorithm, FAISS engine
- `merchant_id`, `category_id`, `brand` as `keyword` for filtering
- `dynamic: strict` because merchant feeds with inconsistent fields would otherwise explode the mapping toward the field limit

**Bulk indexing discipline** (implemented in `ingest-svc`, and the reason it exists as a separate service):

| Setting | During load | After load |
|---|---|---|
| `refresh_interval` | `-1` (disabled) | `1s` restored |
| `number_of_replicas` | `0` | restored to target |
| `translog.durability` | `async` | `request` restored |
| Segments | many small | `_forcemerge?max_num_segments=1` |

Those four settings dominate indexing throughput. Teams that bulk load with a one-second refresh and replicas live commonly pay several times more than necessary.

**Zero-downtime rebuild through alias swap:**

1. Serving reads through the alias `products`, resolving to `products_v1`
2. Build `products_v2` with the new mapping, refresh disabled, replicas at zero
3. Validate: document count, sample queries, relevance spot checks
4. Restore replicas, force merge, warm the cache
5. Atomically repoint the alias in a single API call
6. Retain `v1` for rollback, delete after a confidence window

Mappings are largely immutable, so changing a field type requires a reindex. This pattern makes that routine rather than an outage.

---

## Data flow

### Search path (latency critical)

```
Agent → Worker → search-svc → OpenSearch (BM25 + k-NN via normalization pipeline)
                      ↓                              ↓
              attribution-svc mints         results → search-svc → Worker → Agent
              assertion, returned
              alongside results
```

Postgres is not on this path. Search reads exclusively from the derived index, which is precisely why ingest write pressure cannot degrade search latency.

Precomputed product embeddings mean this path runs zero inference except the query embedding, cached on query-text hash.

### Purchase path

```
Agent → merchant (402 challenge)
Agent → builds PaymentPayload + attaches assertion → merchant
merchant → attribution-svc (verify assertion)
merchant → settlement-svc (verify + settle x402)
settlement-svc → facilitator /verify → /settle → Base Sepolia
settlement-svc → ledger write (merchant debit, platform fee, publisher credit)
merchant → Agent (resource + PAYMENT-RESPONSE)
```

### Ingest path (throughput critical, off the serving path)

```
generator → CSV → COPY into Postgres staging partition
                       ↓
              validate row counts and constraints
                       ↓
              embedding generation (batch, offline)
                       ↓
              atomic partition swap into live Postgres table
                       ↓
              Bulk API index into OpenSearch products_vN
              (refresh -1, replicas 0, async translog)
                       ↓
              validate → restore replicas → force merge
                       ↓
              atomic alias swap: products → products_vN
```

Serving never observes a partial load on either side. A failed feed leaves both the live Postgres partition and the live OpenSearch alias untouched.

**This dual-path pattern is the point.** Postgres takes the write under transactional guarantees; OpenSearch receives a derived index built for read performance. Neither compromises for the other.

---

## The attribution assertion

```json
{
  "assertion_id": "uuid-v7",
  "publisher_id": "pub_a1b2c3",
  "product_id": "prod_x7y8z9",
  "search_request_id": "req_m4n5p6",
  "issued_at": "2026-08-02T14:22:11Z",
  "expires_at": "2026-08-02T15:22:11Z",
  "commission_bps": 450,
  "signature": "ed25519:base64..."
}
```

**Design decisions:**

- **Short expiry (1 hour default).** Attribution should reflect a recent decision, not a stale one. Long windows invite assertion hoarding.
- **Single use.** Assertion IDs are consumed at settlement. Replay is rejected.
- **Commission rate embedded and signed.** The merchant cannot silently reduce the rate at settlement, and the publisher cannot inflate it.
- **Search request binding.** The assertion ties to the specific search that produced the recommendation, which creates an auditable chain from query to payment.

Full rationale in [ADR-0003](adr/0003-attribution-assertion-design.md).

---

## Deployment topology

| Component | Platform | Rationale |
|---|---|---|
| Worker | Cloudflare | Edge termination of the 402 exchange |
| Go services | Fly.io | Small containers, fast deploys, regional placement near the database |
| PHP app | Fly.io | Same platform, simpler operations |
| Postgres | Neon | Serverless, pgvector support, branching for test data |
| Settlement | Base Sepolia | Real protocol, testnet value |

**Why Fly.io over Lambda or Cloud Run:** persistent connections to Postgres. Serverless functions and connection pooling to Postgres fight each other, and the workaround (external poolers) adds a hop to the latency budget.
