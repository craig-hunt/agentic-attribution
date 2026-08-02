# Scaling

What changes between this demo and a platform ingesting billions of rows daily,
and what deliberately does not.

---

## The principle that survives every scale

**Separate workloads before separating codebases.**

Ingest and serving compete for connection pools, memory, and database
resources. Isolating those resources delivers most of the benefit teams expect
from decomposition, at a fraction of the risk. Read replicas, per-workload
connection pools, and async workers get you there without a distributed
transaction anywhere.

This demo runs services separately because the boundaries already stood known
before anyone wrote a line. A production system arriving at the same problem
from a working monolith should start with process and data-path isolation
inside the application it already has, and split the codebase only where a
measured boundary demands it.

That ordering matters more than any number below.

---

## What already scales

Four things in this repository work the same at demo scale and at platform
scale, which explains why they took this shape rather than the obvious one.

**Bulk load through staging and atomic swap.** Listings COPY into an unlogged
staging table with no indexes, get validated, then replace live partitions
through `DETACH`/`ATTACH` in a single transaction. Readers see the entire old
dataset or the entire new one. Index maintenance during load dominates cost at
volume, so it waits until the data has landed.

**OpenSearch ingest discipline.** `refresh_interval` disabled during load,
replicas at zero then restored, force merge on completion, and a zero-downtime
rebuild through atomic alias swap. Those four settings dominate indexing
throughput and most teams leave them at defaults.

**The index never holds the system of record.** Postgres owns the catalog and
the ledger; OpenSearch derives from it and rebuilds on demand. That turns
mapping changes routine rather than dangerous.

**Precomputed embeddings.** Ingest generates every product vector once.
Serving runs one inference call, on the query, cached by query-text hash. A
system running inference per result pays for it on every request.

---

## What changes, and roughly where

| Scale | What breaks first | What replaces it |
|---|---|---|
| ~10M listings | Single-instance Postgres serving both ingest writes and dashboard reads | Read replicas for the API; primary absorbs ingest |
| ~50M listings | Full rebuild time exceeds the acceptable staleness window | CDC alongside periodic rebuild: stream price and stock changes, rebuild for structural changes |
| ~100M vectors | HNSW memory footprint at full precision | Product quantization or scalar quantization; accept a small recall loss for a large memory one |
| ~500M listings | One OpenSearch cluster's shard count and rebuild time | Shard by category or region; alias per shard group |
| Billions daily | The COPY-and-swap window itself | Partition by merchant *and* time; swap only the partitions a feed touched |

**The read replica arrives soonest**, and well before the others. Ingest write
pressure degrading search latency surfaces before anything else on this list,
and it needs no architectural change to fix.

---

## What does not scale, and needs no fixing

**The commission ledger stays on one primary.** Double-entry correctness needs
ACID transactions, and a ledger stays small: one row per settlement times
three entries. A platform doing a million settlements a day writes three million
ledger rows a day, which a single Postgres handles for years. Sharding money
presents a problem worth avoiding for as long as possible.

**Assertion verification stays local.** An Ed25519 signature check against a
published public key costs microseconds and needs no network call. It scales by
doing nothing.

**Replay detection needs durable state and stays centralized.** The
`consumed_assertions` table holds the one row a settlement cannot avoid
touching. At platform volume it becomes the hot table, and partitioning by time
with a retention policy matching the assertion TTL answers that better than
distributing the check.

---

## Numbers this demo publishes

Measured against 1M listings on a single machine:

- Search p50 under 25ms, p99 under 100ms
- Hybrid query issues one OpenSearch request, not two
- Ingest streams rather than buffering: roughly 200MB of resident memory saved
  at a million rows

Those numbers describe one machine with no replicas and no contention. They
exist to show the shape of the work rather than to predict production, and
[`DATA_GENERATION.md`](DATA_GENERATION.md) explains how to reproduce the corpus that
produced them.

---

## What would need measuring before any of this

Nobody should act on any of this from a document alone. The order these limits
arrive in depends entirely on read-to-write ratio, catalog churn rate, and query
shape, and every one of those measures cleanly long before it hurts.

The instrumentation that answers it: p50/p95/p99 by endpoint, ingest wall clock
by phase, index rebuild duration, and connection pool saturation per workload.
The search service already publishes the first, and the ingest pipeline already
reports the second.
