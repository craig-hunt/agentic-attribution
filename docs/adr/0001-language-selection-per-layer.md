# ADR-0001: Language Selection Per Layer — TypeScript at the Edge, PHP for Application, Go for Data

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

This system spans three workload categories with genuinely different optimization targets.

**Edge.** The x402 challenge-response exchange adds a round trip before any resource returns. Terminating that exchange close to the caller keeps total latency acceptable, and rejecting invalid payments or forged assertions at the edge means bad requests never consume backend capacity. This layer optimizes for cold-start time, global distribution, and correctness against complex protocol payload structures.

**Application.** The publisher dashboard renders attribution chains and commission ledgers. It optimizes for development velocity, template ergonomics, and familiarity to the team that maintains it. Request volume stays low; a 40ms response satisfies every requirement.

**Data.** Hybrid search under a sub-100ms budget, Ed25519 verification on every settlement, and bulk indexing of millions of listings. This layer optimizes for throughput, predictable tail latency, concurrency, and memory footprint. A garbage collection pause that shifts p99 by 200ms breaks the product contract.

Forcing one language across all three means two layers lose the argument. Teams that standardize on the application language push data workloads into a runtime that fights them. Teams that standardize on the systems language slow application development and narrow the hiring pool for work that never needed the performance.

A further consideration shaped this specifically: the organization this demo targets runs PHP and TypeScript at the application layer, and its engineering leadership expects data-workload language decisions to run independent of that choice. A demo that collapsed everything into one language would model something the team cannot adopt, and it would stay silent on the exact question worth answering.

## Decision

**One language per layer, each chosen against that layer's constraints.**

| Layer | Language | Components |
|---|---|---|
| **Edge** | **TypeScript** | Cloudflare Worker: x402 gateway, assertion verification, routing |
| **Application** | **PHP 8.3** | Publisher dashboard, attribution chain visualization |
| **Client / simulation** | **TypeScript** | Agent simulator driving the full purchase loop |
| **Data** | **Go** | search, attribution, settlement, ingest services, dataset generator |

**TypeScript rather than plain JavaScript, without exception.** The x402 protocol carries structured payloads (`PaymentRequirements`, `PaymentPayload`, `PaymentResponse`) alongside the attribution assertion envelope. These structures nest, carry optional fields that vary by scheme and network, and get constructed in one place then verified in another. Static types catch the class of error that would otherwise surface as a failed settlement, which is the most expensive place to discover a mistake.

The application layer reads through the data services over HTTP rather than querying datastores directly. That keeps the data contract in one place and prevents the application layer from accumulating query logic that belongs elsewhere.

**Shared type definitions live in `packages/types`**, defined once as JSON Schema and consumed by TypeScript directly and by Go through code generation. That prevents the assertion structure from drifting across implementations.

## Consequences

**Positive.**

- Each workload runs in a runtime suited to it. Go services compile to static binaries under 15MB, start in milliseconds, and handle thousands of concurrent connections on modest memory. The Worker deploys globally with negligible cold starts. PHP keeps dashboard iteration fast.
- TypeScript at the edge catches payload-construction errors at compile time rather than at settlement. Given that a malformed `PaymentPayload` fails only after a facilitator round trip, that shift saves real debugging time.
- The application layer stays approachable for a team already fluent in PHP. Dashboard changes require no systems-programming context.
- Service boundaries emerge naturally from the language boundary. The HTTP contract between layers stays explicit rather than implied by shared database access.
- Go's concurrency primitives fit bulk indexing cleanly. Worker pools with bounded parallelism take a few lines rather than a framework.

**Negative.**

- Three toolchains, three dependency managers, three testing conventions. Operational surface grows meaningfully.
- Contributors need context across languages to change behavior end to end.
- Shared types exist in three places. The assertion structure appears in TypeScript, Go, and PHP, and drift between them is a real failure mode. Generating from a single schema mitigates this but does not remove the discipline required.
- CI runs three build pipelines and three mutation-testing passes.

**Neutral.**

- The HTTP boundary between layers adds a network hop the dashboard pays. At dashboard request volumes this stays irrelevant, and it buys a clean contract.
- The split makes future service extraction straightforward, because the boundaries already exist in production rather than only on a diagram.

## Alternatives considered

**Everything in PHP.** Modern PHP with Swoole or RoadRunner handles concurrency far better than the traditional request-per-process model, and this would collapse the toolchain to one. Rejected because the hybrid search path and bulk-index workers benefit materially from Go's concurrency model and memory profile, because Cloudflare Workers do not run PHP, and because the demo's explicit purpose includes showing that data-layer language choice runs independent of application-layer choice. Collapsing to PHP would make the demo silent on the question it exists to answer.

**Everything in TypeScript, including the data layer.** Genuinely viable, and a single language across edge, application, and data carries real appeal for a small team. Rejected on two grounds. The bulk-index and signature-verification paths run measurably better in Go, particularly under the concurrency the ingest workload demands. And the target organization runs PHP at the application layer, so a Node-only demo would model a stack they do not operate.

**Everything in Go.** Templating, form handling, and dashboard iteration all move slower in Go than in PHP. Go also cannot run in a Cloudflare Worker without WASM compilation that adds complexity for no benefit at this layer. Rejected on both counts.

**Plain JavaScript at the edge rather than TypeScript.** Removes a build step and a toolchain dependency. Rejected because the x402 payload structures are exactly the case static typing exists for: nested, scheme-dependent, constructed in one place and validated in another, with failures surfacing late and expensively. The build-step cost is trivial against that.

**Rust for the data layer.** Faster than Go on the hot path with stronger memory guarantees. Rejected on delivery timeline and handoff cost. The performance delta over Go does not change whether this system meets a sub-100ms budget, and Rust would slow both the initial build and any handoff to a team without Rust depth.

**Python for the data layer.** Strongest ecosystem for embedding generation and ML tooling. Rejected for the serving path on latency and concurrency grounds. Worth revisiting for the offline embedding pipeline specifically, where the ecosystem advantage is real and latency does not matter.
