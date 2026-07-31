# Running it

Everything runs on one machine under Docker Compose. No account, no API key, no
wallet, no funded testnet balance, no hosted dependency. See
[ADR-0007](adr/0007-runtime-portable-edge-gateway.md) for why that constraint
shaped the architecture rather than merely the setup.

---

## Prerequisites

| Tool | Version | Needed for | Required |
|---|---|---|---|
| Docker | with Compose v2 | every service | yes |
| `make` | any | the documented commands | yes |
| Go | 1.25+ | the Go suite on the host | no |
| Node | 20.10+ | the TypeScript suites on the host | no |
| PHP | 8.3+ with ext-curl | the dashboard suite on the host | no |

`make` ships with macOS Command Line Tools and with most Linux distributions.
On Debian and Ubuntu: `sudo apt install make`. Under Windows, run everything
from WSL rather than PowerShell, since the targets assume a POSIX shell.

**Docker and `make` run the demo between them.** The containers carry their own
toolchains, so nothing else needs installing.

`make keys` is the one target that would otherwise want a host toolchain. It
uses Go when it finds Go on the `PATH`, and otherwise builds a small container
and generates the keypair there. The container path costs roughly a minute on
first run while the Go image builds, and produces an identical keypair.

Allow Docker roughly 4GB of memory. OpenSearch takes 1GB of heap and refuses to
start with less headroom than that.

---

## Quick start

```bash
make keys     # generate the signing keypair, once
make up       # build and start every service
make seed     # generate the catalog, load Postgres, build the OpenSearch index
make demo     # drive the agent through the whole loop
```

Then open the publisher dashboard at **http://localhost:8000**.

`make help` lists every target.

---

## Where key material lives, and why it lives there

**`make keys` writes the keypair outside the repository**, to
`~/.agentic-attribution/env` by default. Nothing in the working tree ever holds
a signing key.

That placement is deliberate rather than fussy. Gitignoring a key file stops it
being committed; it does nothing to stop it being read. Editor extensions,
language servers, AI coding assistants, and any dependency with a postinstall
script all hold filesystem access to a project directory. A key inside the tree
is a key inside every one of their reach.

The same reasoning explains why this repository ships **no `.env.example`**. A
template in the project root invites `cp .env.example .env`, which puts key
material back in the tree and quietly undoes the decision. The variables appear
below instead.

Override the location with `ENV_FILE`:

```bash
export ENV_FILE=/path/to/your/secrets/agentic-attribution.env
make up
```

`ENV_FILE` uses `?=`, so an exported value wins over the default and every
target picks it up without a flag. Compose receives it through `--env-file`
rather than reading a `./.env` by convention, so no key file needs to sit beside
`docker-compose.yml` for interpolation to work.

### What the file holds

| Variable | Written by | Held by |
|---|---|---|
| `ATTRIBUTION_PRIVATE_KEY` | `make keys` | search-svc alone, which mints |
| `ATTRIBUTION_PUBLIC_KEY` | `make keys` | gateway, merchant, settlement, all of which verify |
| `MERCHANT_PAY_TO_ADDRESS` | `make keys` | merchant, as the x402 payee |

Only the minting service ever sees the private half. Verifiers hold the public
key and nothing else, which is the entire reason for an asymmetric scheme: a
verifier cannot forge what it can only check.

Rotating means deleting the file and running `make keys` again. Assertions
signed under the old key stop verifying immediately, which is the intended
behaviour rather than a migration problem, because assertions expire in an hour
anyway.

---

## What each step does

**`make up`** starts Postgres, OpenSearch, search-svc, settlement-svc, the
gateway, the merchant, the mock facilitator, and the dashboard. The first run
pulls roughly 2GB of images, most of it OpenSearch, and builds three of its own.

**`make seed`** runs two one-shot containers in order. `generate` writes a
deterministic catalog to a shared volume, 20,000 canonical products fanned
across merchants by default. `ingest` then bulk-COPYs into Postgres through an
unlogged staging table and swaps partitions atomically, registers the ONNX
embedding model, builds a versioned index with refresh disabled and replicas at
zero, force merges, and swaps the alias onto it.

This is the slow step. The embedding model downloads on first run.

Raise or lower the catalog size with `CANONICAL_PRODUCTS`:

```bash
make seed CANONICAL_PRODUCTS=150000
```

**`make demo`** runs the agent: search, 402 challenge, EIP-3009 signature,
payment, settlement, commission split. It prints the attribution chain, then
replays the same assertion and requires a 409. It exits non-zero if the replay
succeeds, because a single-use guarantee nobody exercises is a claim rather
than a property.

---

## Ports

| Service | URL |
|---|---|
| Publisher dashboard | http://localhost:8000 |
| Gateway | http://localhost:8080 |
| search-svc | http://localhost:8081 |
| settlement-svc | http://localhost:8082 |
| Merchant | http://localhost:8090 |
| Facilitator (mock) | http://localhost:8095 |
| OpenSearch | http://localhost:9200 |
| Postgres | localhost:5432, `agentic` / `agentic` |

---

## Confirming it worked

```bash
curl -s localhost:8080/healthz                      # gateway
curl -s localhost:9200/_cat/aliases?v               # products alias points at a versioned index
docker compose exec postgres psql -U agentic -d agentic \
  -c 'select count(*) from listings'                 # catalog loaded

# The ledger balances to zero for every confirmed settlement. Any other result
# means a commission split wrote rows that do not offset.
docker compose exec postgres psql -U agentic -d agentic \
  -c 'select settlement_id, sum(amount_cents) from ledger_entries group by 1 having sum(amount_cents) <> 0'
```

That last query returning no rows is the strongest single check in the system.

---

## Settling for real on Base Sepolia

The mock facilitator runs by default so a first run needs no wallet. The agent
still performs genuine EIP-3009 typed-data signing in both modes, and the mock
verifies those signatures with real EIP-712 recovery. Only the on-chain transfer
is simulated.

To settle against the live testnet, add to your key file:

```
X402_FACILITATOR_URL=https://x402.org/facilitator
AGENT_PRIVATE_KEY=0x...          # a funded Base Sepolia wallet
MERCHANT_PAY_TO_ADDRESS=0x...    # an address you control
```

The agent wallet needs testnet USDC from a faucet. Nothing about the default
path depends on that, deliberately, because faucets rate-limit and testnets get
deprecated while this repository stays clonable.

---

## Tests

```bash
make test        # Go, TypeScript, and PHP
make test-go
make test-ts
make test-php
make lint        # gofmt, tsc, php -l
```

The suites run against the host toolchains rather than in containers, so they
need Go, Node, and PHP installed. None of them needs the stack running.

`make fixture` regenerates the cross-language test vector after any change to
the assertion contract. Go mints it, TypeScript verifies it, and a divergence in
the canonical signing bytes fails a test rather than a settlement.

---

## Troubleshooting

**OpenSearch exits immediately.** Almost always `vm.max_map_count`. Under WSL or
Linux: `sudo sysctl -w vm.max_map_count=262144`. Under Docker Desktop, raise the
memory allocation to 4GB.

**`make up` fails with `required variable ATTRIBUTION_PUBLIC_KEY is missing`.**
Run `make keys`, or set `ENV_FILE` to wherever your existing key file lives.

**`make seed` appears to hang.** The embedding model is downloading. Watch it
with `make logs`.

**The dashboard shows "No settlements yet."** Expected until `make demo` runs.
The dashboard reads confirmed settlements only, so a failed run shows nothing.

**A second keypair appeared.** Running `make keys` without `ENV_FILE` set
creates one at the default path even when your real key file lives elsewhere.
Delete the stray directory and export `ENV_FILE` in your shell profile.

**Starting clean.** `make clean` stops everything and deletes the volumes, so
the next `make seed` starts from an empty database and an empty index. It leaves
the key file alone.
