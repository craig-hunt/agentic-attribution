# Session Handoff — 2026-07-30

**Purpose:** resume the `agentic-attribution` build exactly where it stopped.

---

## Why this project exists

Craig interviewed for **VP of Engineering at Affiliate.com**. Round 2 (technical, 2026-07-29) went well. Round 3 expected **week of 2026-08-03**, a deeper technology dive. Craig gave them GitHub access during the interview and discussed this exact pattern with them: **build a demo the team can productionalize.**

Craig's read: shipping this over the weekend of Aug 1-3 likely lands the role.

**Repo creation is Craig's job, not mine.** Build lives in `Ideas/Demos/agentic-attribution/`.

---

## What Affiliate.com actually needs (confirmed in Round 2)

| Priority | Need |
|---|---|
| **Core** | Ingesting **billions of rows daily into a MONOLITHIC application** |
| **Core** | Serving customers at **sub-100ms** |
| Wants depth | **x402** |
| Wants depth | **AI/ML integration into enterprise products** |
| **NOT near-term** | Sub-affiliate network. "Very long term" roadmap. De-prioritized |

**They are committed to OpenSearch.** Never suggest Vespa, Elasticsearch, or pgvector as alternatives. OpenSearch is the search tier, full stop.

**Their app layer runs PHP and TypeScript.** Not JavaScript.

---

## The demo's thesis

Payment is solved by x402. **Attribution is not.** When an agent uses a platform's catalog to decide, then pays the merchant directly, no cookie, referrer, or click exists to carry commission attribution.

This demo implements one answer: **Ed25519-signed attribution assertions that travel with the payment and drive automatic commission split at settlement.**

Three-layer protocol stack framing (AP2 authorization / ACP checkout / x402 settlement) is the sophisticated point. They stack; they do not compete.

---

## BUILT (complete)

```
agentic-attribution/
├── README.md                          ✓ full, includes language-split argument
├── docs/
│   ├── ARCHITECTURE.md                ✓ components, data flow, OpenSearch discipline
│   ├── architecture.drawio            ✓ full diagram, numbered flow, 2 decision panels
│   ├── SESSION_HANDOFF.md             ✓ this file
│   └── adr/
│       ├── README.md                  ✓ index
│       ├── 0001-language-selection-per-layer.md      ✓ TS edge / PHP app / Go data
│       ├── 0002-postgres-source-of-truth-opensearch-index.md ✓
│       ├── 0003-attribution-assertion-design.md      ✓ Ed25519, single-use, 1h TTL
│       ├── 0004-x402-base-sepolia-testnet.md         ✓
│       ├── 0005-simulated-merchant-scope.md          ✓
│       └── 0006-testing-strategy.md                  ✓ unit + mutation 70% + Cypress 90%
├── db/migrations/
│   ├── 001_schema.sql                 ✓ 8-way hash-partitioned listings, double-entry ledger
│   └── 002_indexes.sql                ✓ no search indexes (OpenSearch owns search)
├── opensearch/
│   ├── products-index.json            ✓ dynamic:strict, knn_vector 384d HNSW/FAISS, nested offers
│   └── hybrid-search-pipeline.json    ✓ min_max normalization, 0.4 keyword / 0.6 vector
├── packages/types/
│   ├── assertion.schema.json          ✓ single source of truth for the contract
│   └── src/index.ts                   ✓ TS types, x402 shapes, commission math, canonicalization
└── internal/attribution/
    ├── assertion.go                   ✓ Ed25519 mint/verify, commission split
    └── assertion_test.go              ✓ 11 funcs, ~30 cases, 6 tamper vectors, expiry boundaries
```

**Critical invariant already in place:** Go and TypeScript canonicalize signing input through a **fixed-field-order struct** so the bytes are identical across languages. If those drift, cross-language signature verification breaks. Unit tests cannot catch it; the Cypress suite is designed to.

---

## REMAINING

**Docs:**
- `docs/SCALING.md` — demo scale to billions/day. Read replicas, connection pool isolation, vector quantization above ~100M vectors, CDC alongside bulk rebuild
- `docs/DATA_GENERATION.md` — why synthetic, the multi-merchant duplication model
- `docs/PRODUCTIONALIZING.md` — escrow/hold layer for the chargeback gap, ledger on its own instance, property-based testing, contract testing, adversarial merchants
- `docs/RUNNING.md` — local and deployed setup

**Code:**
- `generator/` (Go) — 150K canonical products fanned across 3-8 merchants each → 1M listings. Seeded, deterministic. Deliberately creates the same-product-many-merchants pattern that mirrors Affiliate.com's real dedup problem
- `services/search` (Go) — hybrid OpenSearch query through the normalization pipeline. **Hard to get right**
- `services/attribution` (Go) — HTTP wrapper over `internal/attribution`
- `services/settlement` (Go) — x402 state machine, facilitator calls, ledger writes. **Hard to get right**
- `services/ingest` (Go) — bulk COPY + staging + partition swap in Postgres; Bulk API + refresh -1 + replicas 0 + force merge + **atomic alias swap** in OpenSearch. **Hard to get right**
- `worker/` (TypeScript) — Cloudflare Worker, x402 gateway, edge assertion verification
- `simulator/` (TypeScript) — agent driving the full loop, EIP-3009 signing. **Hard to get right**
- `app/` (PHP 8.3) — publisher dashboard, attribution chain visualization
- `merchant/` — simulated merchant: 402 challenge, assertion verify, fulfillment
- `cypress/` — E2E per ADR-0006, 90% of mission-critical paths, `data-testid` selectors, constants not literals
- `docker-compose.yml`, `fly/*.toml`, `.github/workflows/`

---

## OPEN QUESTION I ASKED CRAIG (unanswered)

Build **everything in dependency order**, or **concentrate on the hard-to-get-right pieces** (hybrid query, x402 state machine, ingest/alias-swap, EIP-3009 signing) and leave mechanical scaffolding to Craig so he knows the codebase cold when they ask about it?

**Resume by asking this again.**

---

## Technical decisions already locked

- Ed25519, not JWT. Rejected JWT on size (64-byte sigs matter inside a payment envelope) and on algorithm-confusion history
- Commission rate signed inside the assertion so neither side can alter it
- Integer truncation on the split; **publisher absorbs the remainder** so the ledger CHECK constraint always holds
- Assertion binds to `search_request_id`, creating the audit chain query → payment → ledger
- Base Sepolia testnet, real EIP-3009, facilitator sponsors gas
- Commission split is a Postgres ledger entry, **not** a second on-chain transfer (models real payout cycles)
- Merchant is simulated; ADR-0005 states the boundary and includes the criticism a skeptic would raise
- **On-chain finality has no chargeback path.** Documented as a real tension needing an escrow layer, not hidden

---

## Reference docs built for Round 3 (in Ideas/Interviews/)

- `AFFILIATE_COM_ROUND3_PREP.md` — the monolith thesis is the differentiator. "Separate workloads before separating the codebase." Resist the microservices answer
- `OPENSEARCH_REFERENCE.md` — bulk-index tuning (4 settings), alias-swap rebuild, vector memory math
- `X402_REFERENCE.md` — EIP-3009 mechanics, facilitator trust model, the protocol layer cake, attribution as the unsolved problem
- `AI_ML_ENTERPRISE_REFERENCE.md` — LLM vs classical ML decision, eval discipline, keep inference off the serving path
- `AFFILIATE_COM_TECHNICAL_INTERVIEW_PREP.md` — Round 2 doc, restructured for live reference (15 Q&A in one block)
