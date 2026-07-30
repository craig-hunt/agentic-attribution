# Architecture Decision Records

Every non-obvious decision in this system, with the reasoning that produced it and the alternatives rejected along the way.

Each record follows the same structure: **Context** (what problem surfaced this), **Decision** (what we chose), **Consequences** (positive, negative, and neutral), **Alternatives considered** (what got rejected and why).

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-language-selection-per-layer.md) | TypeScript at the edge, PHP for application, Go for data | Accepted (edge runtime superseded by [0007](0007-runtime-portable-edge-gateway.md)) |
| [0002](0002-postgres-source-of-truth-opensearch-index.md) | Postgres as system of record, OpenSearch as derived index | Accepted |
| [0003](0003-attribution-assertion-design.md) | Ed25519-signed, single-use attribution assertions | Accepted |
| [0004](0004-x402-base-sepolia-testnet.md) | x402 settlement on Base Sepolia testnet | Accepted |
| [0005](0005-simulated-merchant-scope.md) | Simulate the merchant counterparty | Accepted |
| [0006](0006-testing-strategy.md) | Unit + mutation (70% kill ratio) + Cypress regression | Accepted |
| [0007](0007-runtime-portable-edge-gateway.md) | Target the Web-standard runtime contract, not a platform | Accepted |

**Why these exist.** A demo intended for a team to productionalize needs its reasoning documented, not just its code. The next engineer to touch this should understand why each boundary sits where it does, and which decisions would change under different constraints.
