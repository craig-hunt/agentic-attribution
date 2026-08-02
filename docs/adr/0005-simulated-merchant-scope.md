# ADR-0005: Simulate the Merchant Counterparty

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

The attribution flow requires a merchant. An agent discovers a product, requests purchase from a merchant endpoint, receives a 402 challenge, pays with an attribution assertion attached, and the merchant verifies the assertion before settling and honoring the commission split.

That merchant can take one of three forms: a real integration with a live commerce platform, a faithful emulation of one, or a minimal stand-in that implements only the protocol surface the flow touches.

The choice matters because merchant integration consumes enormous engineering effort at affiliate platforms in production. Real integrations demand catalog synchronization, order lifecycle management, inventory reconciliation, fulfillment status, returns handling, and commercial negotiation. None of that engineering answers the question this project exists to answer.

The question this project answers: **does a cryptographically signed attribution assertion survive the agent boundary and drive correct commission attribution at settlement?**

## Decision

**Implement a minimal simulated merchant that supports exactly the protocol surface the attribution flow requires.**

The simulated merchant:
- Accepts a purchase request for a product identifier
- Responds `402 Payment Required` with valid `PaymentRequirements`
- Accepts a retried request carrying `PAYMENT-SIGNATURE` and an attached attribution assertion
- Verifies the assertion signature against the platform's published public key
- Verifies the payment payload through the facilitator
- Confirms settlement and returns `PAYMENT-RESPONSE`
- Reports the honored commission back to the platform for ledger recording

The simulated merchant does **not** implement catalog sync, inventory, order lifecycle, shipping, returns, or any commercial workflow.

The README states this boundary explicitly so no reviewer mistakes the demo for a merchant integration.

## Consequences

**Positive.**

- Scope stays proportionate to the question. Engineering effort concentrates on the attribution mechanism rather than on commerce plumbing that already exists in mature form elsewhere.
- The merchant's verification path runs real. It performs actual Ed25519 signature verification and actual facilitator calls, so the demo proves the mechanism works against an independent counterparty rather than against itself.
- A team productionalizing this can replace the simulated merchant with a real integration without touching the attribution layer, because an HTTP contract rather than shared code forms the boundary.
- The demo runs entirely self-contained. No partner dependency, no credentials to obtain, no third-party availability risk.

**Negative.**

- The demo does not prove real merchants would adopt this. Merchant cooperation raises a commercial question, and no technical demonstration resolves it.
- Edge cases that only surface against real commerce systems stay unexplored: partial fulfillment, split shipments, price changes between quote and settlement, currency mismatches, tax calculation.
- A skeptical reviewer could reasonably note that a merchant written by the same author will always verify assertions correctly. That criticism holds, and the mitigation rests on the verification code implementing a published, independently checkable signature scheme rather than a private handshake.

**Neutral.**

- The simulated merchant lives in the repository rather than deployed separately, which keeps setup simple and makes the verification logic easy to inspect.

## Alternatives considered

**Real integration with a commerce platform.** Shopify, WooCommerce, or a similar system with a public API. Genuinely more convincing, and it would surface integration realities a simulation cannot. Rejected on timeline and dependency. Real integration requires credentials, a test store, catalog mapping, and order-lifecycle handling, and none of that work advances the attribution question. Worth doing as a follow-on if the mechanism proves out.

**Faithful emulation of a full merchant platform.** Implement catalog, inventory, orders, and fulfillment as a realistic stand-in. Rejected because it multiplies scope for no gain against the central question. A reviewer evaluating attribution design gains nothing from watching inventory decrement.

**No merchant at all, with settlement simulated inside the platform.** Simplest possible path. Rejected because it removes the independent counterparty entirely. The attribution mechanism's value rests on a third party verifying an assertion it did not issue, and collapsing that into one process demonstrates nothing about whether the design works across a trust boundary.

**Multiple simulated merchants with differing verification behavior.** One that honors assertions, one that ignores them, one that attempts tampering. Genuinely interesting for demonstrating failure modes. Rejected for the initial build as scope beyond the core question, and noted in `docs/PRODUCTIONALIZING.md` as a useful addition for testing adversarial cases.
