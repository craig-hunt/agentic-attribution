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

`make keys` alone would otherwise want a host toolchain. It
uses Go when it finds Go on the `PATH`, and otherwise builds a small container
and generates the keypair there. The container path costs roughly a minute on
first run while the Go image builds, and produces an identical keypair.

Allow Docker roughly 6GB of memory. OpenSearch claims 2GB of heap by default,
and it earns that: neural ingest runs model inference inside the cluster, so a
single bulk batch holds the request, the vectors it generates, the HNSW graph
under construction, and the indexing buffer at the same time. A smaller heap
does not degrade, it crashes the node partway through the catalog, and ingest
then reports `EOF` on `_bulk`.

A machine with less to spare seeds a smaller catalog instead:

```bash
OPENSEARCH_HEAP=1g make seed CANONICAL_PRODUCTS=5000
```

---

## Running without make

The targets use a POSIX shell, so Windows users either work from WSL or drive
compose directly. These four commands cover the same ground and run anywhere
Docker does, PowerShell included.

```powershell
# 1. Generate the keypair. Redirect it outside the repository.
mkdir -Force "$env:USERPROFILE\.agentic-attribution"
docker build -q -f docker/go.Dockerfile -t agentic-attribution-tools .
docker run --rm agentic-attribution-tools keygen `
  | Out-File -Encoding ascii "$env:USERPROFILE\.agentic-attribution\env"
Add-Content "$env:USERPROFILE\.agentic-attribution\env" `
  "MERCHANT_PAY_TO_ADDRESS=0x1111111111111111111111111111111111111111"

$env:ENV_FILE = "$env:USERPROFILE\.agentic-attribution\env"

# 2. Start everything
docker compose --env-file $env:ENV_FILE up -d --build

# 3. Generate the catalog and load it
docker compose --env-file $env:ENV_FILE --profile seed up --build `
  --abort-on-container-failure generate ingest

# 4. Drive the agent through the whole loop
docker compose --env-file $env:ENV_FILE --profile demo run --rm --build simulator
```

The same commands work in bash with `$ENV_FILE` in place of `$env:ENV_FILE`.

**One caution on the key file.** PowerShell offers no `chmod`, so the file
carries whatever the parent directory grants. Put it somewhere only your account
can read, which `%USERPROFILE%` already provides on a single-user machine.

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

That placement reflects deliberation rather than fuss. Gitignoring a key file
stops anyone committing it and does nothing to stop anyone reading it. Editor
extensions,
language servers, AI coding assistants, and any dependency with a postinstall
script all hold filesystem access to a project directory. A key inside the tree
sits inside every one of their reach.

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
key and nothing else, which explains the entire reason for an asymmetric
scheme: a verifier cannot forge what it can only check.

Rotating means deleting the file and running `make keys` again. Assertions
signed under the old key stop verifying immediately, the intended behaviour
rather than a migration problem, because assertions expire in an hour anyway.

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

That step takes the longest. The embedding model downloads on first run.

Raise or lower the catalog size with `CANONICAL_PRODUCTS`:

```bash
make seed CANONICAL_PRODUCTS=150000
```

**`make demo`** runs the agent: search, 402 challenge, EIP-3009 signature,
payment, settlement, commission split. It prints the attribution chain, then
replays the same assertion and requires a 409. It exits non-zero if the replay
succeeds, because a single-use guarantee nobody exercises amounts to a claim
rather than a property.

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

That last query returning no rows constitutes the strongest single check in the system.

---

## Settling for real on Base Sepolia

The mock facilitator runs by default so a first run needs no wallet. The agent
still performs genuine EIP-3009 typed-data signing in both modes, and the mock
verifies those signatures with real EIP-712 recovery. Only the on-chain transfer
covers only the on-chain transfer.

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
memory allocation to 6GB.

**`npx cypress run` fails with `error while loading shared libraries:
libnss3.so`.** Cypress ships a browser needing system libraries a minimal WSL
install does not carry. This is specific to WSL: Windows and macOS already have
them, so running the suite from PowerShell or a mac terminal needs no extra
setup. `make e2e` needs none of it anywhere, because the image carries its own
browser, and that is the path CI uses.

`make e2e-open` also runs the interactive runner from inside the container,
drawing on your desktop through the X socket. That needs no libraries on the
host either, only a display: WSLg supplies one on Windows 11, and a desktop
session supplies one on Linux.

To run it inside WSL directly instead, install what Cypress lists:

```bash
sudo apt-get install -y libgtk2.0-0 libgtk-3-0 libgbm-dev libnotify-dev \
  libnss3 libxss1 libasound2t64 libxtst6 xauth xvfb
```

Under WSL the interactive runner also needs an X server, which WSLg provides on
Windows 11. Without one, `cypress open` starts and renders nothing.

**`make seed` fails with `bulk index: Post "http://opensearch:9200/_bulk":
EOF`.** The cluster died mid-request, so ingest lost the connection rather than
receiving an error. Confirm it:

```bash
docker compose logs opensearch | grep -i outofmemory
```

A fatal `OutOfMemoryError` there means the heap could not hold a bulk batch
alongside in-cluster model inference. Give Docker more memory, or seed a
smaller catalog with `OPENSEARCH_HEAP=1g make seed CANONICAL_PRODUCTS=5000`.
The `EOF` names the symptom; the cause always sits in the OpenSearch log.

**`make up` fails with `required variable ATTRIBUTION_PUBLIC_KEY is missing`.**
Run `make keys`, or set `ENV_FILE` to wherever your existing key file lives.

**`make seed` appears to hang.** The embedding model downloads. Watch it
with `make logs`.

**The dashboard shows "No settlements yet."** Expected until `make demo` runs.
The dashboard reads confirmed settlements only, so a failed run shows nothing.

**A second keypair appeared.** Running `make keys` without `ENV_FILE` set
creates one at the default path even when your real key file lives elsewhere.
Delete the stray directory and export `ENV_FILE` in your shell profile.

**A build fails with `error getting credentials - err: exit status 1, out:` and
nothing after it.** Two causes produce that message, and neither concerns
credentials. Every image this stack pulls sits in a public registry, so nothing
here needs a login.

*First, check your working directory.* A message like `make: getcwd: No such
file or directory` alongside the build failure gives it away. Every target that
runs Docker now checks this first and stops with the real diagnosis, so a
current checkout reports the cause rather than the credentials error.

```bash
pwd || cd /path/to/agentic-attribution
```

Docker Desktop on Windows installs a credential helper that runs as a Windows
executable, and WSL launches it through interop. Interop translates your current
directory to a Windows path to do that, so a stale directory handle breaks the
launch. The helper exits 1 with empty output, and Docker reports the only thing
it can see: a credentials failure. Remounting `/mnt/c`, restarting Docker
Desktop, or leaving a shell idle can all invalidate the handle. Change into the
directory again, or open a fresh shell.

*Second, check the helper exists.* If your working directory checks out:

```bash
grep credsStore ~/.docker/config.json
which docker-credential-desktop.exe
```

A `credsStore` naming a helper that `which` cannot find means Docker Desktop's
PATH integration for this distribution stays switched off. Enable it under
Docker Desktop, Settings, Resources, WSL Integration. Failing that, every image
this stack pulls sits in a public registry, so removing the entry works:

```bash
echo '{}' > ~/.docker/config.json
```

**Starting clean.** `make clean` stops everything and deletes the volumes, so
the next `make seed` starts from an empty database and an empty index. It leaves
the key file alone.
