# ADR-0007: Target the Web-Standard Runtime Contract, Not a Platform

**Status:** Accepted

**Supersedes:** the edge-runtime portion of [ADR-0001](0001-language-selection-per-layer.md). The language selection in ADR-0001 stands unchanged; only its naming of Cloudflare Workers as the edge runtime gets replaced.

---

## Context

ADR-0001 selected TypeScript for the edge layer and named Cloudflare Workers as the runtime. A later decision, taken while evaluating hosting cost, established that the entire demo must run locally under Docker Compose with no hosted dependency and no account signup. Nobody reconciled the two.

Taken together they conflict. A Cloudflare Worker either deploys to Cloudflare, which reintroduces a hosted dependency and an account, or runs locally through `wrangler dev` against `workerd`, which drags the wrangler toolchain into the compose file and produces one container that behaves unlike the other four.

The conflict surfaced a sharper question. **What does the edge layer actually depend on?** Reading back through the gateway's requirements yields four answers: `Request`, `Response`, `fetch`, and WebCrypto. Workers, Deno, Bun, Node 18 and later, and browsers all implement every one of them as a Web standard. Nothing in the gateway needs a Cloudflare-specific API.

A second constraint pointed the same direction. The demo exists for a team to clone, run, and evaluate. Anything that requires an account, a credential, or a funded wallet before the first successful run costs reviewers who never get past setup, and a demo nobody runs teaches nobody anything.

## Decision

**The edge gateway targets the Web-standard runtime contract rather than a specific platform.**

The gateway exports a single `fetch(request, env)` handler built exclusively from `Request`, `Response`, `URL`, `fetch`, and `crypto.subtle`. It imports no Node built-in and no platform SDK.

Two thin entry points wrap that handler:

- **`src/node.ts`** adapts `node:http` to the handler for local Docker. `docker compose up` runs this one.
- **`wrangler.toml`** deploys the identical module to Cloudflare Workers with no source change.

The assertion verifier the gateway depends on already runs on WebCrypto for the same reason, so the merchant, the gateway, and any browser share one verification implementation rather than three that can drift apart.

**Settlement gains the same treatment.** The x402 facilitator sits behind an interface with two implementations: a local mock that the compose stack runs by default, and the Coinbase facilitator selected by setting `X402_FACILITATOR_URL`. The mock verifies the EIP-3009 signature properly rather than rubber-stamping it, and simulates only the on-chain transfer.

## Consequences

**Positive**

- `git clone` then `docker compose up` then `make demo` completes with no account, no credential, no wallet, and no funded testnet balance.
- The demo still runs a year from now. Testnet faucets rate-limit and deprecate; the default path depends on neither.
- The gateway remains genuinely deployable to Cloudflare, and the committed `wrangler.toml` lets a reviewer verify that claim rather than take it on faith.
- One verification implementation serves Node, Workers, and browsers. A second implementation would create a second place for the canonical signing bytes to drift away from Go.
- Nothing in the repository points at any URL the author controls, so no clone can execute against infrastructure belonging to someone else.

**Negative**

- The Node adapter exists solely to bridge runtimes. It stays small, roughly 40 lines, and it carries its own tests, though it remains a seam that Workers-only code would avoid.
- Running under Node locally and Workers in production means the two environments differ. Behaviour depending on runtime specifics would surface only after deployment. Restricting the gateway to Web standards keeps that risk small, and a lint rule forbidding Node built-in imports holds it there deliberately rather than by habit.
- The default demo path does not move value on-chain. A reviewer wanting to watch a real Base Sepolia transaction must opt in and fund a wallet.

**Neutral**

- The README's claim that signatures stay real rather than mocked holds. The agent performs genuine EIP-3009 typed-data signing in both modes, and the mock facilitator verifies that signature. Simulation covers only the settlement transfer.

## Alternatives considered

**Containerize wrangler and keep the literal Cloudflare dependency.** Preserves ADR-0001 word for word, and `wrangler dev` genuinely runs offline against `workerd`, the same runtime Cloudflare operates. Rejected because it adds a toolchain whose version churn breaks builds unrelated to this project, produces a container unlike the rest of the stack, and buys nothing the standards-only approach does not already deliver. The portability argument also makes the stronger technical statement.

**Drop the edge layer and write a plain Node gateway.** Simplest possible compose file. Rejected because it discards a real architectural argument, and because it would make ADR-0001's reasoning about terminating the 402 exchange close to the caller into decoration rather than a decision the code reflects.

**Deploy a single hosted gateway that all clones share.** Removes the local gateway entirely. Rejected on two grounds. An unauthenticated endpoint calling a settlement service that writes to a database presents an abuse surface with nothing in front of it, and a demo whose behaviour depends on infrastructure the reader does not control invites observation rather than evaluation.

**Keep the real facilitator as the only path.** Strongest possible fidelity, and the on-chain transaction genuinely rewards watching. Rejected as a default because it puts a faucet, a wallet, and a rate limit between a reviewer and the first successful run. Retained as an opt-in, where anyone who wants that fidelity can have it.

**Mock the signature as well as the transfer.** Would remove the EIP-3009 implementation entirely and simplify the simulator considerably. Rejected because the signing path ranks among the genuinely hard parts of x402, and demonstrating it carries much of the point. A mock skipping signature verification would also make the mock and the real facilitator disagree about which payloads count as valid, the worst property a test double can carry.
