# Productionalizing

What a team adds to ship this for real. Written as an honest list of what the
demo lacks rather than a roadmap, because the gaps carry the value.

---

## Security, and the ones that matter most

**No authentication anywhere.** Internal service calls carry no credentials.
Settlement trusts any caller reaching `/settle` to speak for the merchant
service, and nothing enforces that. A merchant could settle against a listing belonging to
another merchant.

Service-to-service authentication closes it: a service-credentials JWT, a
shared secret validated server-side against a value from a secrets store, or
mTLS client certificates. Not an allowlist, and not "it sits behind a
perimeter", because defence in depth demands HTTP-layer auth even where
network exposure supposedly stays limited.

**Fault injection ships disabled and must stay that way.** The mock
facilitator accepts a mode that stops it answering, which a regression suite
needs and nothing else does. `FACILITATOR_FAULT_INJECTION` gates it, the
default leaves `/fault` answering 404 rather than answering with a disabled
state, and only the `e2e` targets turn it on. Enabling it on anything reachable
would hand an unauthenticated caller a way to halt every settlement.

**Validate at every boundary, not at the one that was easiest to find.** Three
services took a decoded JSON body and read fields from it without checking the
shape. In TypeScript a cast is a claim the runtime never keeps. The merchant
answered 502 carrying a JavaScript error message, and the facilitator threw
inside an async handler with no catch, which terminated the process: a single
unauthenticated request stopped every settlement on the platform. Both now
validate before any field access and answer 400. Anything added later that
accepts a payload needs the same treatment, and a `catch` that turns an
unexpected throw into a response rather than an exit.

**The driver's control endpoints need authentication before anything deploys.**
`POST /start` spawns concurrent agents against the platform, and nothing
authenticates the caller. Today the driver publishes no host port and the
dashboard proxies to it, which keeps it inside the compose network on one
machine. Neither of those facts protects a deployed instance. The dashboard
clamps concurrency, and a clamp bounds the blast radius rather than deciding
who may cause it. Anywhere real, the control surface needs an authenticated
operator identity, and the fraud injection needs disabling outright rather than
merely defaulting off. See [ADR-0010](adr/0010-live-agent-driver.md).

**Environment variables carry key material.** Fine for a local demo where the
operator owns the machine, wrong in production: `docker inspect` and anyone who
can run Docker commands can read them. A secrets manager, or Kubernetes and
Swarm secrets mounted as tmpfs files, keeps them out of process environment.

**No rate limiting.** The gateway caps body size and nothing else. An agent can
issue unlimited searches, and each one mints signed assertions. Per-publisher
and per-agent limits belong at the edge.

**The publisher dashboard has no login.** It renders one publisher's earnings to
anyone who knows the URL. Publisher-scoped authentication and authorization
tops the list for any real deployment.

---

## The commercial gap this demo does not close

**Chargebacks and reversals.** The schema carries `hold_period_days` and
`reversal_window_days` on every merchant, and nothing uses them. A confirmed
settlement credits the publisher immediately.

Real affiliate commerce holds commission for a reversal window, because
purchases get refunded, and a publisher paid on a refunded order costs the
platform money it cannot recover. The ledger already supports the fix:
`reversal` and `adjustment` entry types exist and nothing ever writes them.

**That gap separates this demo from a working platform more than any other**,
and it presents a business-rules problem rather than a technical one. The escrow
layer, the payout cycle, and the dispute path hold the actual complexity of an
affiliate network.

**Nothing implements payouts.** The ledger records what a publisher has
earned. Nothing moves it to them. The `payout` entry type exists for the same reason
the reversal one does.

---

## Merchants who fall short of cooperative

The simulated merchant behaves honestly. Real merchants tend toward
inconsistent rather than adversarial, though the system has to survive both.

**A merchant reporting a lower price than it charged** would understate the
commission. Settlement validates gross against the listing, which catches it
only when the listing stays current.

**A merchant that never reports a conversion** simply keeps the commission.
Affiliate networks handle that through postback reconciliation against
merchant-side order data, and this demo implements none of it.

**Stale listings.** Settlement compares the payment against whatever the
catalog last ingested. A price that changed after the agent searched but before
it paid resolves against the stale figure. The assertion carries a one-hour TTL
which bounds the window; it does not close it.

---

## Reliability

**No reconciler.** `SETTLE` deliberately carries no retry, because a timeout
leaves the on-chain outcome unknown and resending an EIP-3009 authorization
that already landed risks a second transfer. The correct recovery reads chain
state and reconciles, and that reconciler does not exist. Settlements can sit
`pending` forever.

**No dead letter path.** A settlement failing after the assertion gets
consumed leaves the publisher uncredited with no mechanism to issue a
replacement assertion.

**No idempotency keys on the HTTP surface.** Replay protection covers
assertions and payment nonces. A duplicate `/settle` carrying a fresh assertion
and a fresh nonce would settle twice, correctly, and nothing at the transport
layer would notice.

---

## Operations

**Observability stops at structured logs and a latency endpoint.** No tracing,
so nothing attributes a slow purchase to a stage. No metrics export, no
alerting, no SLOs. OpenTelemetry across the four services and the gateway makes
the obvious first move, and the attribution chain already provides a natural
correlation identifier.

**No migration tooling.** The demo applies SQL files in filename order. A
production system needs versioned, reversible migrations with a lock, which
`internal/testsupport` approximates for tests and the runtime does not.

**Single instance of everything.** No HA, no failover, no backups.

---

## Verification the demo does not do

**Property-based testing** would suit the cryptographic and numeric paths
better than the table-driven tests they carry now. Generated inputs explore
commission-split edge cases that hand-written ones miss, and the invariant
states easily: the three amounts always sum to the commission.

**Contract testing between languages.** The Go-minted fixture pins the
assertion contract in one direction. A full contract suite would pin every
boundary, including the x402 payload shapes the facilitator and settlement
service both construct independently.

**Load testing.** The published latency numbers describe single requests.
Nothing establishes behaviour under concurrency, and reasoning rather than
measurement set the connection pool sizes.

**A hosted verification endpoint.** Verification runs locally everywhere,
which serves merchants better than an HTTP call would: no hop, no dependency,
and no purchase intent revealed to the platform before the buyer commits. The
one case justifying a hosted verifier involves a merchant unable to implement
Ed25519 at all, which real affiliate networks do encounter given the range from
in-house engineering teams to storefront plugins.

---

## What would ship first

If this became a real product, in order:

1. **Service-to-service authentication.** Everything else counts as a feature;
   this one leaves a hole.
2. **The escrow and reversal layer.** Without it the platform pays out money it
   may have to claw back.
3. **The settlement reconciler.** Pending settlements that never resolve become
   support tickets and then accounting problems.
4. **Publisher authentication on the dashboard.** Earnings data carries
   commercial sensitivity.
5. **Tracing.** Everything after this prioritizes more easily once latency
   attributes to a stage.
