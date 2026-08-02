# ADR-0008: Lucene rather than Faiss for the k-NN Engine

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

Hybrid search needs an approximate-nearest-neighbour index over the 384-dimension embeddings the ingest pipeline generates. OpenSearch offers three k-NN engines, and Faiss serves as the conventional production choice: it holds the largest corpora, it supports product quantization, and it wins most published benchmarks at scale. The index mapping specified Faiss from the first draft, for those reasons.

Faiss loads through JNI. `libopensearchknn_faiss_avx2.so` links against the system C++ runtime, and the plugin resolves that runtime at the moment a shard first builds an HNSW graph, which happens during refresh rather than at node startup.

Separately, ADR-0002 puts embedding generation inside the cluster. The neural ingest pipeline runs the ONNX model through ML Commons, which pulls a PyTorch distribution through DJL on first use and unpacks it into the data directory. That distribution ships its own `libstdc++.so.6`, and the unpack directory lands on the dynamic linker's search path.

The two decisions collide. The linker resolves Faiss's dependency against PyTorch's older bundled `libstdc++` rather than the system copy, the `GLIBCXX` version check fails, and `UnsatisfiedLinkError` propagates out of a refresh thread. OpenSearch treats an uncaught error on that thread as fatal and exits the process. Ingest observes the node vanishing mid-request and reports `EOF` on `_refresh`, which describes the symptom and points nowhere near the cause.

Nothing about the failure is intermittent, and nothing about it is specific to one machine. Any single-node deployment running in-cluster inference alongside a Faiss k-NN index reaches the same state on the first refresh after seeding.

## Decision

**The products index uses the Lucene k-NN engine.**

```json
"method": {
  "name": "hnsw",
  "space_type": "cosinesimil",
  "engine": "lucene",
  "parameters": { "ef_construction": 256, "m": 16 }
}
```

Lucene implements HNSW in Java and loads no native library, so the conflict has nothing to act on. The method, the space type, and both graph parameters carry over unchanged, and the hybrid query, the normalization processor, and the search service need no modification.

**The heap allocation rises to 2GB**, configurable through `OPENSEARCH_HEAP`. In-cluster inference means a bulk batch holds the request, the vectors it generates, the graph under construction, and the indexing buffer at once. 1GB does not fit that, and the node exits with a fatal `OutOfMemoryError` partway through the catalog rather than degrading.

## Consequences

**Positive.**

The demo runs from a clean clone on one node, which the Faiss configuration never did. Removing a JNI dependency removes a class of platform-specific failure along with it, so an ARM laptop and an x86 CI runner exercise the same code path. Lucene's engine also integrates with Lucene's own filtering, which pre-filters during graph traversal rather than over-fetching and filtering afterwards.

**Negative.**

Faiss outperforms Lucene at large corpora, and it supports product quantization while Lucene does not. A production deployment holding tens of millions of vectors under memory pressure would want Faiss and would need to solve the library conflict properly, most directly by running inference on dedicated ML nodes so the PyTorch distribution never shares a JVM with the k-NN plugin.

**Neutral.**

The corpus this demo builds, roughly 20,000 canonical products by default and around a million listings at the documented larger setting, sits far below where the engines diverge meaningfully. `SCALING.md` records the threshold rather than leaving the choice to look like a preference.

## Alternatives considered

**Keep Faiss and force a compatible PyTorch build.** DJL selects the `precxx11` distribution when it detects an older toolchain, and the `cxx11` build carries no conflicting runtime. Rejected because the selection happens inside a dependency of a plugin, configuring it means pinning behaviour this project does not own, and a reader cloning the repository next year inherits a workaround whose trigger they cannot see.

**Keep Faiss and isolate inference on a dedicated ML node.** The correct production answer, and the one this ADR recommends for a real deployment. Rejected here because it turns a single-node demo into a multi-node cluster, and it raises the memory floor beyond what a laptop reliably provides. ADR-0007 already establishes that a reviewer's first run matters more than architectural fidelity in the local topology.

**Generate embeddings outside the cluster, in the Go ingest service.** Removes ML Commons entirely, which removes the PyTorch distribution and therefore the conflict, while leaving Faiss in place. Rejected because query-time embedding would then need the same model in the search service, and Go's ONNX runtime bindings would add a CGO dependency to a binary that deliberately builds static. It also loses the neural ingest pipeline, which demonstrates something worth showing.

**Drop the vector field and run BM25 alone.** Simplest configuration, and no engine to choose. Rejected because hybrid retrieval carries a real part of the argument this project makes about search quality, and lexical-only matching would not surface a product whose merchant titles drift the way the generator makes them drift.

## References

- ADR-0002, which places embedding generation inside the cluster
- ADR-0007, which establishes a reviewer's first run as the constraint that outranks local architectural fidelity
- [`docs/SCALING.md`](../SCALING.md), for where the engines diverge
- [`docs/RUNNING.md`](../RUNNING.md), for the memory requirement and its failure mode
