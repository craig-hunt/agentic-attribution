# ADR-0003: Ed25519-Signed, Single-Use Attribution Assertions

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

Affiliate commerce attributes commission through a click. A human clicks a tracked link, a cookie or click identifier persists in the browser, a conversion fires a postback carrying that identifier, and commission flows back through the chain.

Agent-mediated purchase eliminates every element of that mechanism. No browser holds a cookie. No referrer header survives. Often no click occurs at all, because the agent reads structured product data, reasons over it, and transacts directly with the merchant. The platform whose data informed the decision may never observe the transaction.

The attribution question becomes: when an agent uses a data platform's catalog to decide what to buy, and then pays the merchant directly, how does the platform prove its data drove the decision, and how does commission reach the publisher who surfaced the product?

Three properties matter for any answer:

**Verifiable without trusting the agent.** An agent could fabricate an attribution claim to route commission somewhere it does not belong, or strip attribution entirely to obtain a lower price. Neither should succeed.

**Portable across the payment boundary.** The attribution evidence must travel with the payment through an HTTP exchange, arriving at a merchant that has no prior session with the platform.

**Cheap to verify.** Verification sits inline in the settlement path. It cannot require a database round trip to the issuing platform on every transaction, because that reintroduces the coupling agent-mediated commerce removes.

## Decision

**Attribution travels as a compact, cryptographically signed assertion issued at search time and consumed at settlement.**

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

**Signature scheme: Ed25519.** The platform signs with a private key; merchants and facilitators verify with a widely published public key. Verification requires no contact with the issuing platform.

**Single use.** Settlement consumes the `assertion_id` and records it in Postgres. A replayed assertion fails verification.

**One-hour expiry.** Assertions represent a recent purchase decision, not a durable entitlement.

**Commission rate embedded inside the signed payload.** `commission_bps` sits under the signature, so neither the merchant nor the publisher can alter the agreed rate after issuance.

**Bound to the originating search request.** `search_request_id` ties the assertion to the specific query that produced the recommendation, creating an auditable chain from query through payment to ledger entry.

## Consequences

**Positive.**

- Verification runs offline against a public key. No callback to the platform, no shared secret per merchant, no coupling reintroduced.
- Tampering fails. Altering the publisher, the product, or the commission rate invalidates the signature.
- Ed25519 signatures run 64 bytes, which matters because the assertion travels inside a payment payload with practical size constraints. RSA signatures at comparable security would consume four times the space.
- Verification costs microseconds, so it adds nothing meaningful to the settlement path.
- The signed commission rate removes an entire class of dispute between platform, publisher, and merchant.
- The search-request binding produces an audit trail that survives after the fact, which matters for reconciliation and for fraud investigation.

**Negative.**

- Replay protection requires state. The consumed-assertion record must stay durable and get checked on every settlement, which reintroduces a database dependency in the settlement path specifically. Acceptable there, since settlement already writes to the ledger.
- One-hour expiry may reject legitimate slow decisions. An agent that researches for ninety minutes before purchasing loses attribution. The window remains a tunable policy rather than a protocol constraint, and the right value depends on observed agent behavior.
- Key rotation requires care. Merchants cache the public key, so rotation needs an overlap period during which both keys verify.
- A compromised signing key allows arbitrary assertion forgery until rotation completes. Key custody becomes a first-class security concern.

**Neutral.**

- Assertion size grows the payment payload modestly. Immaterial at these dimensions.
- The scheme assumes merchants cooperate by honoring assertions. That cooperation rests on a commercial arrangement rather than a technical guarantee, and no cryptographic design changes it.

## Alternatives considered

**JWT with RS256 or ES256.** Standard, widely tooled, and every language ships a library. Rejected on two grounds. First, size: a JWT carrying equivalent claims runs several times larger than the compact assertion, and payload size matters inside a payment envelope. Second, the JWT ecosystem carries a long history of algorithm-confusion vulnerabilities, where a verifier accepts `alg: none` or a symmetric algorithm in place of the asymmetric one the designer intended. A fixed-scheme assertion with no algorithm negotiation removes that category entirely.

**HMAC with a shared secret.** Simplest to implement and fastest to verify. Rejected because it requires a shared secret between the platform and every merchant. That does not scale to twenty thousand merchants, secret distribution becomes an operational burden, and any merchant holding the secret can forge assertions for any publisher.

**Unsigned attribution claims, trusted from the agent.** Trivial to implement. Rejected immediately. An unsigned claim invites commission fraud, and the incentive to forge scales exactly with the commission at stake.

**On-chain attribution registry.** Write attribution records to a smart contract, verify at settlement. Genuinely trustless and auditable by anyone. Rejected on cost and latency. A registry write per search result makes search economically impossible, and a read per settlement adds chain-query latency to the payment path. Worth revisiting for high-value transactions where per-transaction cost amortizes, which describes a different product than this one.

**Merchant-side attribution lookup by callback.** The merchant calls the platform at settlement to ask who deserves credit. Simple and requires no cryptography. Rejected because it recreates exactly the coupling agent-mediated commerce eliminates, puts platform availability directly in the merchant's settlement path, and fails the moment the platform stops answering.
