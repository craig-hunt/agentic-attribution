# ADR-0004: x402 Settlement on Base Sepolia Testnet

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

The demo must show money actually moving in response to an agent's purchase decision, because the attribution mechanism only matters if commission reaches a publisher at settlement. A payment layer that never settles proves nothing about whether the attribution design survives contact with a real protocol.

Three constraints shaped the choice.

**The protocol behavior must stay real.** x402 carries specific mechanics: a 402 challenge with `PaymentRequirements`, a client-constructed `PaymentPayload`, EIP-3009 `transferWithAuthorization` signatures, facilitator verification and settlement. A simulation skipping those mechanics fails to demonstrate whether attribution assertions fit inside the payment envelope, the open question this project addresses.

**No real value can move.** A public demonstration repository with live mainnet keys and real stablecoin balances creates security exposure disproportionate to any benefit, and invites accidental loss during development.

**Cost must approach zero.** The demo runs indefinitely for anyone who clones it. Per-transaction cost would make that impractical.

## Decision

**Settle on Base Sepolia testnet using the real x402 protocol, real EIP-3009 signatures, and a facilitator for gas sponsorship.**

- **Network:** Base Sepolia. EVM-compatible, well-documented for x402, and faucets hand out testnet USDC freely.
- **Asset:** testnet USDC, which implements EIP-3009 `transferWithAuthorization`.
- **Scheme:** `exact`, the first defined x402 scheme, transferring a specific predetermined amount.
- **Gas:** sponsored by the facilitator. The paying client signs an off-chain authorization and never holds native gas tokens.
- **Facilitator:** `/verify` before serving, `/settle` to broadcast.

The commission split executes as a ledger operation in Postgres once settlement confirms on-chain, rather than as a second on-chain transfer. That distinction reflects deliberation and gets discussed under consequences.

**Mainnet migration takes configuration rather than code.** Network identifier, asset address, and facilitator endpoint all live in environment configuration.

## Consequences

**Positive.**

- Every protocol mechanic executes for real: header structure, payload construction, signature format, facilitator round trips, on-chain confirmation. A reviewer can inspect transactions on a block explorer.
- The EIP-3009 gasless pattern gets demonstrated rather than described, which answers the practical objection that on-chain micropayments require the payer to hold gas.
- Zero cost to run, clone, or extend.
- No key custody risk. Testnet keys carry no value, so they can live in the repository's example configuration without hazard.
- Confirms in seconds, which keeps the demo loop tight.

**Negative.**

- Testnet reliability varies. Faucets rate-limit, RPC endpoints degrade, and block times occasionally lengthen. The demo needs graceful handling of settlement timeouts, which production would need regardless.
- Testnet behavior does not perfectly model mainnet economics. Gas pricing, congestion, and facilitator behavior under load all differ.
- Reviewers unfamiliar with testnets may need the distinction explained, which the README handles.

**Neutral.**

- The commission split runs as a Postgres ledger entry rather than a second on-chain transfer. That models how a platform would actually operate, since publishers get paid on a payout cycle rather than per transaction, and per-transaction on-chain payouts would consume the commission in fees. It does mean the money movement visible on-chain covers merchant-to-platform only, with the publisher's share tracked off-chain until payout.
- **On-chain settlement lands final and offers no chargeback path.** The affiliate model depends on reversal windows for refunds and fraud. This demo does not solve that tension; it documents it in `docs/PRODUCTIONALIZING.md` as a required escrow or hold layer before any production deployment.

## Alternatives considered

**Mock facilitator, simulated settlement.** Fastest to build and removes every external dependency. Rejected because the protocol mechanics describe precisely what needs demonstrating. The open question asks whether attribution assertions fit the payment envelope and survive verification, and a mock answers that by assumption rather than by evidence.

**Base mainnet with real USDC.** Maximum realism. Rejected on security and cost. A public repository carrying mainnet keys invites an accident, and per-transaction cost makes an open demo impractical. The migration path stays configuration-only, so the demo loses nothing conceptually.

**Solana rather than an EVM chain.** x402 supports SVM, and Solana's settlement speed and cost profile suit micropayments well. Rejected on documentation maturity and familiarity. The EVM `exact` scheme and EIP-3009 mechanics carry deeper reference material, and the demo exists to demonstrate the attribution layer rather than to explore chain selection. Worth revisiting as a production question where transaction economics matter more.

**Second on-chain transfer for the publisher's commission split.** Attractive because it makes the entire flow verifiable on-chain. Rejected because it does not model real operations. Affiliate networks pay publishers on cycles with minimum thresholds, hold periods, and reversal windows. Per-transaction on-chain payout would consume commissions in fees and eliminate the reversal capability the business model requires.

**Skip payment entirely, demonstrate attribution alone.** Meaningfully less work. Rejected because attribution divorced from settlement leaves the central question unanswered. The value of this project sits precisely at the seam where attribution meets payment.
