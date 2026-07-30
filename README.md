# agentic-attribution

**A working demonstration of commission attribution for agent-mediated commerce, settled over x402.**

---

## The problem this solves

Affiliate commerce rests on a click. A human clicks a tracked link, a cookie or click ID persists, a conversion fires a postback, and commission flows back through the attribution chain.

**Agent-mediated purchase breaks every link in that chain.** No browser. No cookie. Possibly no click at all. An AI agent reads product data, decides, and transacts directly with the merchant, potentially settling in a single HTTP exchange the affiliate platform never observes.

So when an agent uses a data platform's catalog to make a purchase decision and then pays the merchant directly, **who gets credited, and how does commission flow?**

The payment primitive is solved. x402 handles settlement. Attribution is not solved, and that gap is where the value sits.

This project implements one answer: **cryptographically signed attribution assertions that travel with the payment and drive automatic commission split at settlement.**

---

## The three-layer stack

Agentic commerce protocols get discussed as competitors. They stack.

| Layer | Protocol | Answers |
|---|---|---|
| Authorization | AP2 (Google) | Did the user authorize this agent to buy? |
| Commerce | ACP (OpenAI/Stripe) | What are we buying, on what terms? |
| **Settlement** | **x402 (Coinbase)** | **How does the money move?** |

This demo implements the settlement layer and adds the missing piece: **attribution that survives the agent boundary.**

---

## The flow

```
1. Agent queries the product API
       ↓
2. API returns products + a SIGNED ATTRIBUTION ASSERTION
   (publisher ID, product ID, timestamp, expiry, Ed25519 signature)
       ↓
3. Agent selects a product, requests purchase from merchant
       ↓
4. Merchant responds 402 Payment Required
       ↓
5. Agent pays via x402, carrying the attribution assertion
       ↓
6. Merchant verifies the assertion signature, settles on-chain,
   and splits commission to the attributed publisher
       ↓
7. Dashboard renders the full chain: query → assertion → payment → split
```

---

## Architecture

Full diagram: [`docs/architecture.drawio`](docs/architecture.drawio) · Detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

```
                    ┌──────────────────────────┐
   AI Agent ───────▶│  gateway                 │  x402 routing
   (simulator)      │  (TypeScript, edge)      │  assertion verify
                    └───────────┬──────────────┘  rejects forgeries here
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
        ┌──────────┐                       ┌──────────────┐
        │ search   │                       │  merchant    │  402 challenge
        │ svc      │  Go                   │ (TypeScript) │  verify · fulfil
        └────┬─────┘  mints assertions     └──────┬───────┘
             │        in process                  │
             ▼                                    ▼
    ┌──────────────────┐              ┌───────────────────────┐
    │  OpenSearch      │              │  settlement svc       │  Go
    │  hybrid search   │              │  verify · claim       │  x402 state
    │  BM25 + k-NN     │              │  settle · split       │  machine
    │  (derived index) │              └───┬───────────────┬───┘
    └──────────────────┘                  │               │
             ▲                            ▼               ▼
             │                   ┌────────────────┐  ┌──────────────┐
             │                   │  facilitator   │  │  Postgres    │
             │                   │  mock by       │  │  system of   │
             │                   │  default       │  │  record      │
             │                   └────────────────┘  │  + ledger    │
             └───────────────────────────────────────┤  double-entry│
                  rebuilt from Postgres              └──────┬───────┘
                  via atomic alias swap                     │
                                                            ▼
                                                    ┌──────────────┐
                                                    │ PHP 8.3      │
                                                    │ publisher    │
                                                    │ dashboard    │
                                                    └──────────────┘

Everything above runs under Docker Compose on one machine. No account,
no wallet, no funded testnet balance, no hosted dependency.
```

---

## Why the languages split this way

**TypeScript at the edge. PHP for the application layer. Go for the data layer.** This split is deliberate and documented in [ADR-0001](docs/adr/0001-language-selection-per-layer.md).

Each layer optimizes for different properties. The edge optimizes for cold-start time and correctness against complex protocol payloads. Application layers optimize for developer velocity and template ergonomics. Data-path services optimize for throughput, memory footprint, concurrency, and predictable latency. Forcing one language across all three compromises whichever layers lose the argument.

The edge gateway runs TypeScript because x402 payload structures nest, carry scheme-dependent optional fields, and get constructed in one place then verified in another. The dashboard runs PHP because that is where application-layer work belongs. Search, attribution, and settlement run Go because they sit on the latency-sensitive path where a 15MB static binary handling thousands of concurrent connections on modest memory beats the alternative.

---

## Why Postgres and OpenSearch both, and what each owns

Documented in [ADR-0002](docs/adr/0002-postgres-source-of-truth-opensearch-index.md).

**Postgres is the system of record.** Canonical catalog, merchant listings, and the commission ledger. Strong consistency where correctness matters, especially for money.

**OpenSearch is a derived index, rebuilt from Postgres.** It owns hybrid search: BM25 keyword relevance blended with k-NN vector similarity through a normalization processor in a search pipeline.

**The index is never the system of record.** That distinction drives the operational model. The index can be rebuilt at any time from Postgres, which makes mapping changes routine rather than dangerous and makes the alias-swap rebuild pattern safe.

This demo implements the ingest-side discipline that matters at volume: bulk indexing through the Bulk API, `refresh_interval` disabled during load, replicas at zero then restored, force merge on completion, and **zero-downtime index rebuilds through atomic alias swap**. Those four settings dominate indexing throughput and most teams leave them at defaults.

---

## Running it

```bash
# Generate the dataset (~1M listings across 150K canonical products)
go run ./cmd/generator --seed 42 --canonical 150000 --out db/seed

# Bring up the stack
docker compose up -d

# Load Postgres and rebuild the OpenSearch index
go run ./cmd/ingest

# Run the agent simulation end to end
make demo
```

Full setup: [`docs/RUNNING.md`](docs/RUNNING.md)

---

## What this demonstrates

- **x402 settlement** on Base Sepolia with real EIP-3009 signatures, not a mock
- **Attribution assertions** that survive the agent boundary and drive automatic commission split
- **Hybrid search in OpenSearch** (BM25 + k-NN, normalized and blended) with published p50/p99 latency against 1M listings
- **OpenSearch ingest discipline**: Bulk API, refresh disabled during load, replicas restored after, force merge, atomic alias swap for zero-downtime rebuilds
- **Postgres ingest discipline**: bulk COPY, staging tables, atomic partition swap
- **Correct language selection** per workload rather than per organizational habit
- **Documented scaling path** from demo scale to billions of rows daily

---

## What this deliberately does not do

- **The merchant is simulated.** Building a production merchant integration is not the point; demonstrating the attribution mechanism is.
- **No AP2 or ACP implementation.** This demo occupies the settlement layer. The other two layers get referenced, not built.
- **Testnet only.** Base Sepolia. No mainnet value moves.
- **Not production hardened.** No auth on internal service calls, no rate limiting, no HA. [`docs/PRODUCTIONALIZING.md`](docs/PRODUCTIONALIZING.md) lists what a team would add.

---

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component detail, data flow, service contracts |
| [SCALING.md](docs/SCALING.md) | What changes between demo scale and billions of rows daily |
| [DATA_GENERATION.md](docs/DATA_GENERATION.md) | Why synthetic, and the multi-merchant duplication model |
| [PRODUCTIONALIZING.md](docs/PRODUCTIONALIZING.md) | What a team adds to ship this for real |
| [RUNNING.md](docs/RUNNING.md) | Local and deployed setup |
| [ADRs](docs/adr/) | Every non-obvious decision, with alternatives considered |

---

*Built by Craig Hunt. Architecture and code intended as a starting point a team can productionalize rather than as a finished product.*
