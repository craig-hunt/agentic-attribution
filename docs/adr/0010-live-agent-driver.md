# ADR-0010: A Live Agent Driver, Controlled From the Dashboard

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

Until now the only way to make this system do anything was `make demo`, which drives one agent through one purchase and prints an attribution chain to a terminal.

That fails the people the project exists to convince. Someone opening the dashboard for the first time meets 48 publishers, 47 of them empty, and a page that tells them to go and run a command. They cannot see an agentic transaction happen. They read about one afterwards.

**The mismatch runs deeper than convenience.** The claim this project makes is that attribution survives the agent boundary, that commission reaches the publisher whose recommendation started the search, and that a tampered assertion earns nobody anything. The first two showed up as static rows. The third showed up nowhere: the verification paths rejected forged, expired, and replayed assertions, nothing recorded those refusals, and the only evidence was a log line. A security property nobody can watch hold is a claim rather than a demonstration.

## Decision

**A driver service runs a live agent population, started and stopped from the dashboard, with an option to mix in fraud.**

**Every agent drives the real path.** The gateway, the search service, a genuine 402 challenge, an EIP-3009 signature, the facilitator, and a settlement that writes ledger rows. Nothing fabricates a number the dashboard then displays. A simulated counter would have been quicker and would have proved nothing, and a technical audience recognises the difference within seconds.

**Fraud reuses the rejection paths that already existed.** Five modes rewrite a genuine assertion: redirecting the publisher, inflating the signed commission, backdating the expiry, forging the signature, and naming a publisher that does not exist. Each declares the rejection reason it expects, and the runner reports a mismatch rather than assuming the right control caught it. **An accepted fraud attempt counts as a failure, never as a settlement**, because a platform honouring an assertion it should have refused is the one outcome that makes the whole demonstration wrong.

**Refused attempts persist.** A `rejected_attempts` table records the publisher, the reason, and the moment, written at the single point in the settle handler where the platform decides to refuse. Journalling never changes the refusal: a failed write gets logged and dropped, because turning a clean 409 into a 500 would hand a caller a retry signal for a request already refused.

**The dashboard polls rather than pushes.** Every page refreshes its own numbers on a timer, and rows whose values changed flash once. Polling avoids a second protocol, works inside the existing PHP page, and stays debuggable with curl. Server-sent events would carry less latency and buy nothing a viewer perceives at this cadence.

**The browser reaches the driver only through the dashboard.** The driver publishes no host port. The dashboard proxies to it, which keeps the page same-origin and keeps a load generator off the host's network surface.

## Consequences

**Positive.**

Someone can now open one page, press a button, and watch commission reach publishers and fraud get refused, without a terminal. The security property became visible for the first time. The rejection journal also turns out to be useful beyond the demo, since a real platform wants exactly this record for its own fraud analysis.

**Negative.**

**The control endpoints carry no authentication.** That is acceptable for a service reachable only from a compose network on one machine and unacceptable anywhere else. Deploying this needs authentication in front of the driver first, and `PRODUCTIONALIZING.md` records that. The dashboard clamps concurrency, but a clamp is not authorization.

Throughput has a real ceiling. Query embedding runs inference per unique query, so the driver uses a fixed pool of eight queries whose vectors cache. Past roughly a dozen concurrent agents OpenSearch becomes the bottleneck on a laptop and the demonstration reads as sluggish, which is why the dashboard caps the control at 24 and defaults to 6.

**Neutral.**

`make demo` still exists and still works. It remains the better tool for reading a single chain end to end, and CI uses it nowhere while the smoke gate uses the driver.

## Alternatives considered

**Animate fake activity in the browser.** Trivial to build, perfectly smooth, and completely worthless. Any engineer asks what happens when they open the network tab, and the demo dies at that moment. Driving the real services was the point rather than a constraint.

**Keep `make demo` as the only entry and document it better.** The path this project was already on. Rejected because no amount of documentation makes a terminal command the thing a reviewer reaches for, and because it leaves the fraud rejections invisible regardless of how well the README explains them.

**Server-sent events or WebSockets instead of polling.** Lower latency and less redundant traffic. Rejected because a viewer cannot perceive the difference at a one-and-a-half-second cadence, and both add a protocol to debug when the interesting failures live in the settlement path rather than in the transport.

**Count rejections in the driver's memory rather than persisting them.** No migration, no schema change. Rejected because the counts vanish on restart, they cannot be attributed to a publisher on that publisher's own page, and a viewer would rightly ask whether the number came from the platform or from the thing generating the load. Reading them back out of Postgres answers that question.

**Generate fraud inside the platform rather than from an agent.** Simpler wiring, since the settlement service could reject synthetic attempts directly. Rejected because it would demonstrate the platform disagreeing with itself. An attack has to arrive the way a real one would, through the edge, carrying a payment, from a client the platform does not control.

## References

- ADR-0003, which defines the assertion the fraud modes attack
- ADR-0005, which scopes the simulated merchant
- ADR-0006, which the smoke tier now covers this surface under
- `simulator/src/runner.ts`, `simulator/src/fraud.ts`, `db/migrations/003_rejected_attempts.sql`
