# ADR-0009: Generate Embeddings Explicitly Rather Than Through an Ingest Pipeline

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

ADR-0002 puts embedding generation inside the cluster, and the original implementation used the idiomatic mechanism: a `text_embedding` ingest processor declared as the index's `default_pipeline`. Every bulk request then arrived, the processor read `embedding_source`, wrote the vector into `embedding`, and a second processor dropped the source text. OpenSearch never held a document without its vector, so the semantic path never went partially searchable.

That mechanism corrupts the document.

The `text_embedding` processor rebuilds the document it processes, and the rebuild does not survive an array of objects. A product enters the pipeline carrying three to eight offers, each with seven fields. It reaches the index carrying the same number of offers, each with exactly one field. The rest disappear.

**Nothing reports an error.** The bulk response returns success. The document count matches what Postgres expects, so the ingest run's own validation passes. Product-level rollups computed before the pipeline runs, including `offer_count`, `min_price_cents`, and `in_stock_anywhere`, all arrive intact and correct, which makes the index look healthy under casual inspection.

The failure surfaces four services away. An agent searches, receives products whose offers all carry `price_cents: 0` and `in_stock: false`, finds nothing purchasable, and gets a 404. Reading that error leads an engineer toward the search service, the merchant, or the generator, and the defect sits in none of them.

A pipeline simulation isolates it exactly:

```bash
POST /_ingest/pipeline/{embedding-only}/_simulate   # offers keep one field
POST /_ingest/pipeline/{remove-only}/_simulate      # offers keep all seven
```

## Decision

**The ingest run generates embeddings by calling ML Commons directly, and the index declares no default pipeline.**

For each batch, ingest collects the source text, calls `POST /_plugins/_ml/_predict/text_embedding/{model_id}` once for the whole batch, assigns each returned vector to its document, and bulk-indexes documents that already carry their embedding.

`Embed` rejects a response whose length differs from the request, and rejects any vector whose dimension count differs from the mapping. A model that returns fewer vectors than it received would otherwise pair vectors with the wrong documents and produce an index full of plausible nonsense.

Ingest resolves the model identifier through a deployed-model search when a reload skips registration, the same way the search service discovers it.

## Consequences

**Positive.**

Documents reach the index exactly as assembled, which is the point. Batch inference through one call per batch costs no more round trips than the pipeline did, since the pipeline also ran per bulk request. Errors surface in the ingest run, at the moment they happen, rather than in an agent four services later. The model still runs in-cluster, so ADR-0002's argument survives intact: no API key, no per-token cost, no external dependency.

Explicit calls also make dimension mismatches detectable. A pipeline writes whatever the model produces and the mapping rejects it later with a less useful message.

**Negative.**

The write path now carries a step the cluster used to own, so a client that indexes directly, outside this ingest run, would write documents without vectors and make them invisible to the semantic path. Production would enforce that with a pipeline validating the vector's presence rather than generating it.

**Neutral.**

`opensearch/embedding-pipeline.json` stays in the repository as documentation of the approach and the reason it does not run.

## Alternatives considered

**Keep the pipeline and stop nesting offers.** Flattening offers into parallel arrays would sidestep the processor's rebuild. Rejected because nested offers carry a real modelling argument, recorded in `documents.go`: one row per product rather than eight near-identical rows, which removes field collapsing at query time. Changing the data model to work around a processor bug inverts the priority.

**Keep the pipeline and restore the offers with a second pass.** Index through the pipeline, then bulk-update every document to write the offers back. Rejected because it doubles the write volume, and a document sits corrupt between the two passes with nothing guaranteeing the second one runs.

**Wait for an upstream fix.** Rejected on timing. A demo that a reviewer cannot run has no value while the fix ships, and pinning a future version helps nobody cloning the repository today.

**Generate embeddings outside OpenSearch entirely.** A Go ONNX runtime, or a hosted embedding API. Rejected because the first adds a CGO dependency to binaries that deliberately build static, and the second reintroduces an API key and a per-token cost that ADR-0002 chose to avoid.

## References

- ADR-0002, which establishes in-cluster embedding generation
- ADR-0008, which changes the k-NN engine for a related native-library conflict
- `internal/ingest/opensearch.go`, `Embed`
- `simulator/src/smoke.ts`, the tier that caught this
