# ADR-0002: Postgres as System of Record, OpenSearch as Derived Index

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

This system carries two data responsibilities that pull in opposite directions.

**Correctness.** The commission ledger records money owed to publishers. A double-entry record that partially commits, silently reorders, or loses a reversal creates a financial discrepancy someone eventually reconciles by hand. This work demands ACID transactions, foreign key enforcement, and unambiguous consistency semantics.

**Read performance.** Publisher-facing and agent-facing search must return relevant products from a million-listing catalog inside 100ms at p99, blending keyword relevance with semantic similarity. This work demands inverted indexes, vector search, and a scoring model tuned for relevance rather than for correctness.

No single datastore serves both well. A search engine asked to guarantee financial consistency compromises what makes it fast. A relational database asked to serve hybrid semantic search at scale compromises what makes it correct.

A second consideration: catalogs change constantly. Merchant feeds arrive with inconsistent schemas, mappings need adjustment, and relevance experiments require reindexing. Any design where the search index holds authoritative data makes each of those operations dangerous.

## Decision

**Postgres holds the system of record. OpenSearch holds a derived index rebuilt from it.**

**Postgres owns:**
- Canonical product identity and attributes
- Merchant listings, partitioned by merchant bucket
- The double-entry commission ledger
- Attribution assertion consumption records

**OpenSearch owns:**
- The searchable product index
- Hybrid retrieval: BM25 keyword matching blended with k-NN vector similarity through a normalization processor in a search pipeline
- Nothing authoritative

**The governing principle: the index is never the system of record.** Every document in OpenSearch can be reconstructed from Postgres. That single constraint drives the operational model.

**Index lifecycle:**
- Built through the Bulk API with `refresh_interval` disabled, replicas at zero, and async translog durability during load
- Validated on document count and sample queries before promotion
- Replicas restored and force merged before serving traffic
- Promoted through **atomic alias swap**, so `products` repoints from `products_v1` to `products_v2` in a single call
- Previous version retained for rollback

**The search path never touches Postgres.** That separation is why ingest write pressure cannot degrade search latency.

## Consequences

**Positive.**

- Money lives under transactional guarantees. Ledger correctness never depends on search-engine consistency semantics.
- Index rebuilds carry no data-loss risk, which converts mapping changes from a migration project into a routine operation.
- Relevance experiments become cheap. Build a candidate index, evaluate it, promote or discard it.
- The search tier scales independently of the write tier. Adding search capacity means adding OpenSearch nodes without touching the transactional path.
- Ingest write pressure and search read latency stop competing, because they hit different systems entirely.

**Negative.**

- Two datastores to operate, monitor, back up, and reason about.
- Eventual consistency between Postgres and the index. A product updated in Postgres does not appear in search until the next index refresh cycle. Acceptable for a catalog; unacceptable if it ever backed the ledger, which is exactly why the ledger stays out of it.
- Reindex cost grows with catalog size. At platform volume, full rebuilds become expensive enough to require incremental strategies alongside the full-rebuild path.
- The dual-write path in `ingest-svc` needs care. A failure between the Postgres commit and the OpenSearch index leaves them diverged until the next rebuild.

**Neutral.**

- Storage duplication between the canonical record and the index. Real cost, but modest relative to the operational benefit.
- Requires discipline to prevent the index from accumulating authoritative fields over time. That drift happens gradually and is worth guarding against in review.

## Alternatives considered

**OpenSearch alone.** Removes a system, simplifies operations, and search-oriented workloads often run fine on it. Rejected outright because the commission ledger requires ACID transactions. A financial record living in a search index that lacks multi-document transactional guarantees is not a tradeoff worth debating.

**Postgres alone, with pgvector for semantic search.** Genuinely viable at this demo's scale. A single system, transactional throughout, and pgvector handles vector similarity competently. Rejected for three reasons. First, hybrid scoring in Postgres requires hand-rolling the normalization and blending that OpenSearch provides through a search pipeline. Second, vector index performance in Postgres degrades relative to purpose-built engines as vector count grows, and this architecture must model platform scale rather than demo scale. Third, and decisively, the target platform runs OpenSearch, so a demo modeling a different search tier would demonstrate an architecture the team cannot adopt.

**Both systems authoritative for different entities.** Products authoritative in OpenSearch, money authoritative in Postgres. Rejected because it produces two sources of truth in one system, and reconciling product state between them during failures becomes a recurring operational burden. One system of record with derived views stays comprehensible under pressure; two authoritative systems do not.

**Change data capture from Postgres into OpenSearch, replacing bulk rebuild.** Attractive for freshness, and worth adopting at platform scale alongside the rebuild path. Rejected as the primary mechanism here because CDC pipelines add operational complexity disproportionate to a demo, and because the bulk-rebuild-plus-alias-swap pattern demonstrates the operational discipline this project exists to show. Documented as a production consideration in `docs/PRODUCTIONALIZING.md`.
