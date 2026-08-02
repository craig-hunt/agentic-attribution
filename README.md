# agentic-attribution

**A working demonstration of commission attribution for agent-mediated commerce, settled over x402.**

---

## The problem this solves

Affiliate commerce rests on a click. A human clicks a tracked link, a cookie or click ID persists, a conversion fires a postback, and commission flows back through the attribution chain.

**Agent-mediated purchase breaks every link in that chain.** No browser. No cookie. Possibly no click at all. An AI agent reads product data, decides, and transacts directly with the merchant, potentially settling in a single HTTP exchange the affiliate platform never observes.

So when an agent uses a data platform's catalog to make a purchase decision and then pays the merchant directly, **who gets credited, and how does commission flow?**

x402 solves the payment primitive. Nothing solves attribution, and that gap holds the value.

This project implements one answer: **cryptographically signed attribution assertions that travel with the payment and drive automatic commission split at settlement.**

---

## The three-layer stack

Agentic commerce protocols get discussed as competitors. They stack.

| Layer | Protocol | Answers |
|---|---|---|
| Authorization | AP2 (Google) | Did the user authorize this agent to buy? |
| Commerce | ACP (OpenAI/Stripe) | What do we buy, on what terms? |
| **Settlement** | **x402 (Coinbase)** | **How does the money move?** |

This demo implements the settlement layer and adds the missing piece: **attribution that survives the agent boundary.**

---

## The flow

```
1. Agent queries the product API
       ↓
2. API returns products + a SIGNED ATTRIBUTION ASSERTION
   (publisher ID, product ID, timestamp, expiry, Ed25519 signature)
       ↓
3. Agent selects a product, requests purchase from merchant
       ↓
4. Merchant responds 402 Payment Required
       ↓
5. Agent pays via x402, carrying the attribution assertion
       ↓
6. Merchant verifies the assertion signature, settles on-chain,
   and splits commission to the attributed publisher
       ↓
7. Dashboard renders the full chain: query → assertion → payment → split
```

---

## Architecture

Full diagram: [`docs/architecture.drawio`](docs/architecture.drawio) · Detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

```
                    ┌──────────────────────────┐
   AI Agent ───────▶│  gateway                 │  x402 routing
   (simulator)      │  (TypeScript, edge)      │  assertion verify
                    └───────────┬──────────────┘  rejects forgeries here
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
        ┌──────────┐                       ┌──────────────┐
        │ search   │                       │  merchant    │  402 challenge
        │ svc      │  Go                   │ (TypeScript) │  verify · fulfil
        └────┬─────┘  mints assertions     └──────┬───────┘
             │        in process                  │
             ▼                                    ▼
    ┌──────────────────┐              ┌───────────────────────┐
    │  OpenSearch      │              │  settlement svc       │  Go
    │  hybrid search   │              │  verify · claim       │  x402 state
    │  BM25 + k-NN     │              │  settle · split       │  machine
    │  (derived index) │              └───┬───────────────┬───┘
    └──────────────────┘                  │               │
             ▲                            ▼               ▼
             │                   ┌────────────────┐  ┌──────────────┐
             │                   │  facilitator   │  │  Postgres    │
             │                   │  mock by       │  │  system of   │
             │                   │  default       │  │  record      │
             │                   └────────────────┘  │  + ledger    │
             └───────────────────────────────────────┤  double-entry│
                  rebuilt from Postgres              └──────┬───────┘
                  via atomic alias swap                     │
                                                            ▼
                                                    ┌──────────────┐
                                                    │ PHP 8.3      │
                                                    │ publisher    │
                                                    │ dashboard    │
                                                    └──────────────┘

Everything above runs under Docker Compose on one machine. No account,
no wallet, no funded testnet balance, no hosted dependency.
```

---

## Why the languages split this way

**TypeScript at the edge. PHP for the application layer. Go for the data layer.** [ADR-0001](docs/adr/0001-language-selection-per-layer.md) documents the reasoning behind that split.

Each layer optimizes for different properties. The edge optimizes for cold-start time and correctness against complex protocol payloads. Application layers optimize for developer velocity and template ergonomics. Data-path services optimize for throughput, memory footprint, concurrency, and predictable latency. Forcing one language across all three compromises whichever layers lose the argument.

The edge gateway runs TypeScript because x402 payload structures nest, carry scheme-dependent optional fields, and get constructed in one place then verified in another. The dashboard runs PHP because application-layer work belongs there. Search, attribution, and settlement run Go because they sit on the latency-sensitive path where a 15MB static binary handling thousands of concurrent connections on modest memory beats the alternative.

---

## Why Postgres and OpenSearch both, and what each owns

Documented in [ADR-0002](docs/adr/0002-postgres-source-of-truth-opensearch-index.md).

**Postgres holds the system of record.** Canonical catalog, merchant listings, and the commission ledger. Strong consistency where correctness matters, especially for money.

**OpenSearch serves a derived index, rebuilt from Postgres.** It owns hybrid search: BM25 keyword relevance blended with k-NN vector similarity through a normalization processor in a search pipeline.

**The index never holds the system of record.** That distinction drives the operational model. Postgres rebuilds the index on demand, which turns mapping changes routine rather than dangerous and makes the alias-swap rebuild pattern safe.

This demo implements the ingest-side discipline that matters at volume: bulk indexing through the Bulk API, `refresh_interval` disabled during load, replicas at zero then restored, force merge on completion, and **zero-downtime index rebuilds through atomic alias swap**. Those four settings dominate indexing throughput and most teams leave them at defaults.

---

## Running it

Everything runs on one machine. **Docker and `make` cover every prerequisite.**
No account, no API key, no wallet, no funded testnet balance, no hosted
dependency.

**On Windows, run these from WSL rather than PowerShell.** The targets use a
POSIX shell. [`docker compose` commands that need no `make`](docs/RUNNING.md)
cover the same ground for anyone who would rather skip WSL.

```bash
make keys     # generate the signing keypair, once, outside the repository
make up       # build and start every service
make seed     # generate the catalog, load Postgres, build the index (~7 min)
make demo     # drive the agent through search, 402, payment, settlement, replay
```

Then open the publisher dashboard at **http://localhost:8000**.

Stopping and resetting:

```bash
make down     # stop every service, keeping the catalog and the index
make clean    # stop everything and delete the volumes, back to a fresh clone
make help     # every target, with a line each
```

**Stopping the containers through Docker Desktop leaves the volumes behind**,
so Postgres keeps the catalog, OpenSearch keeps the index, and the next start
reuses both. Use `make clean` when you want the state a clone actually begins
from, including the discarded model artifact that `make seed` downloads again.

**`make seed` runs about seven minutes on the default catalog, and longer on a
slower machine.** It generates 2,000 merchants, 48 publishers, 20,000 canonical
products, and 109,543 merchant listings, then loads roughly 131,600 rows into
Postgres and indexes 20,000 documents into OpenSearch.

Postgres accounts for about three seconds of that. Almost all the rest embeds
each product through the ONNX model before indexing it, which runs on CPU and
scales with the cores you give Docker. Model registration adds about thirty
seconds on the first run while the artifact downloads. Each phase prints its
own timing as it finishes, so a stalled run looks different from a slow one.

Seed a smaller catalog when you want the loop rather than the volume:

```bash
make seed CANONICAL_PRODUCTS=2000     # a tenth of the documents
```

Indexing dominates the wall clock and scales with the document count, so a
tenth of the catalog costs roughly a tenth of the time.

`CANONICAL_PRODUCTS=150000` produces close to a million listings, the corpus
the numbers in [`docs/SCALING.md`](docs/SCALING.md) describe. Expect it to run
considerably longer than the default.

Installing Go, Node, and PHP on the host remains optional and buys you only
the ability to run the test suites there. `make keys` uses a host Go toolchain when
it finds one and otherwise builds a small container to generate the keypair, so
the first run takes about a minute longer without Go and works either way.

### Keys

**Nothing gets shared and nothing gets distributed.** `make keys` generates a
fresh Ed25519 keypair on your machine. Every clone becomes its own platform
carrying its own signing identity, so no credential travels with the repository
and none needs requesting from anyone.

**It writes outside the working tree**, to `~/.agentic-attribution/env` by
default, and never into the project. Gitignoring a key file stops anyone
committing it and does nothing to stop anyone reading it: editor extensions,
language servers, AI assistants, and any dependency with a postinstall script
all hold filesystem access to a project directory.

The containers never read that file. Compose reads it on the host and passes
individual values into each service. That split sends the private half only to
the service that mints, while the three services that verify receive the public
half alone.

Point `ENV_FILE` anywhere else if you keep secrets somewhere specific:

```bash
export ENV_FILE=/path/to/your/secrets/agentic-attribution.env
```

Full setup, troubleshooting, and how to settle against live Base Sepolia:
[`docs/RUNNING.md`](docs/RUNNING.md)

---

## Seeing it work

**Open http://localhost:8000 and press a button.** No terminal, no arguments,
nothing to read first.

```
[ Run one purchase ] [ Start agents ] [ Stop ]  Agents [6]  [ ] Include fraud
                        12 settled · 3 blocked · 0 failed · all · 6 agents running
```

**Run one purchase** sends a single agent through search, a 402 challenge, a
signed payment, and settlement, then waits for it to land so you watch one
transaction complete. **Start agents** runs a population of them continuously.
The table re-sorts as commission accumulates, and rows whose numbers changed
flash, so you see which publisher just earned rather than hunting for the digit
that moved.

**Every agent drives the real system.** The edge gateway, hybrid search, a
genuine 402, an EIP-3009 signature, the facilitator, and a settlement that
writes ledger rows. Nothing on screen comes from a counter the page invented.
Open the network tab and watch if you like; that is rather the point.

### Watching fraud get refused

Tick **Include fraud attempts** and roughly a third of a running population
starts presenting tampered assertions: a redirected publisher, an inflated
commission rate, a backdated expiry, a forged signature, a publisher that does
not exist.

**With the box ticked, "Run one purchase" sends fraud every time.** A single
click has no population to average over, so a one-in-three chance would leave
you pressing the button and watching an ordinary purchase settle, concluding the
option does nothing.

**None of them earn anything.** The Blocked column climbs while Earned does not,
and each publisher's page lists what was refused and why. The verification paths
doing the refusing are the same ones a genuine purchase passes through; the
demonstration adds the attacker, not the defence.

That column is the security argument made visible. Everything else on the
dashboard shows money arriving where it should. This shows money failing to
arrive where it should not.

### Narrowing and reordering the table

**The three counters are filters.** Press `blocked` to show only publishers with
refused attempts, press it again to clear, or press `all` to reset. Both the
filter and the sort survive the live refresh, so a running population does not
snap the table back while you are reading it.

**Every column sorts.** Earned leads by default, descending. A second press on
the same column reverses it, and a different column starts descending, because
the interesting end of every column here is the large end. Ties break on
publisher identifier, so rows never shuffle between refreshes. The settlements
and blocked-attempt tables on each publisher's page sort the same way.

**Blocked and Failed count different things.** Blocked means the platform
refused an attempt, by signature, expiry, or single-use enforcement. Failed
means the platform accepted the assertion and the payment fell over afterwards,
so nobody defrauded anyone and nobody got paid either.

**Expect Failed to read zero.** The mock facilitator always succeeds, so nothing
fails during an ordinary run. The column and its filter both work; there is
simply nothing to show unless the facilitator errors.

### Following one purchase end to end

Open the publisher at the top of the table, then open a settlement from their
list:

```
1 · Agent searched            "trail running shoes"  ·  540ms
2 · Platform minted a signed assertion   Ed25519, single use,
                                         bound to that search request
3 · Agent chose a product      Bluecrest Ripstop Trail Running Shoes
                               from Meadow Trading Post
4 · Merchant charged over x402  $71.75 on base-sepolia  0xc4f5027...
5 · Assertion consumed, commission split
        2.14% of $71.75 = $1.53, of which the publisher earned $1.08

Ledger entries
  merchant_payable    mer_000572   commission   -$1.53
  platform_revenue    platform      commission    $0.45
  publisher_payable   pub_000001   commission    $1.08
  Balance                                        $0.00
```

A query at the top, a balanced double-entry ledger at the bottom, and a signed
chain connecting them. Every value traces to a row a real settlement wrote.

**Watch the merchant change between purchases while the publisher stays whoever
asked.** The agent buys from whichever merchant priced best, and commission
still reaches the publisher whose recommendation started the search. That
separation is the problem this project exists to solve.

### From the command line instead

`make demo` drives one purchase and prints the same chain as text, which reads
better than the dashboard when you want the whole story in one screen:

```bash
make demo
DEMO_PUBLISHER_ID=pub_000007 DEMO_QUERY="waterproof hiking pack" make demo
```

Every run ends by replaying its assertion deliberately, which must fail with a
`409`. A single-use guarantee nobody exercises amounts to a claim rather than a
property.

Reading the same data as JSON:

```bash
curl -s localhost:8082/publishers | jq
curl -s localhost:8082/publishers/pub_000001 | jq
curl -s localhost:8082/settlements/<settlement-id>/chain | jq
```

**One note on the driver.** Its control endpoints carry no authentication, which
is fine for a service reachable only from the compose network on your own
machine and unacceptable anywhere else. It publishes no host port, and the
dashboard proxies to it. [ADR-0010](docs/adr/0010-live-agent-driver.md) covers
the design and what deploying it would require.

---

## Verifying it

Every suite runs with Docker alone, so a clean clone reproduces the numbers
below rather than taking them on trust.

```bash
make smoke-cold       # empty volumes through to a verified purchase
make test-docker      # Go, TypeScript, and PHP suites in containers
make e2e              # Cypress regression suite in a container, headless
make e2e-open         # the same suite, in a browser you can watch
make mutate-docker    # Stryker and Infection in containers
```

Every one of those needs Docker and nothing else. `make e2e` carries its own
browser, so no Cypress binary and no browser libraries land on your machine.

### The gate that matters most

`make smoke-cold` wipes the volumes, starts every service, seeds the catalog,
drives a purchase through search, 402, payment, and settlement, replays the
assertion to confirm the second attempt fails, then asserts the settlement API
and the dashboard both report what happened.

It also drives the dashboard's own controls: firing a single purchase from the
page, sending a tampered assertion through the same path to confirm it gets
blocked rather than settled, checking the refusal reaches the publisher table,
and starting and stopping a live population. Twenty-two checks in all. It exits
non-zero on any failed assertion, and CI runs it on every push.

**It exists because the other suites cannot catch what it catches.** Each of
them tests a service against a stub of its neighbours, and a stub encodes what
the author believed the real dependency does. When that belief turns out wrong,
the code and the stub carry the same mistake and agree with each other
perfectly, so the tests pass and the system does not work. Mutation testing
does not help here either: it measures whether the tests notice a change to the
*code*, and it cannot mutate a wrong assumption about OpenSearch. A high kill
ratio against a wrong stub pins the wrong behaviour tightly.

Running the real thing found ten defects: an Elasticsearch-only field type in
the index mapping, a model used before its deployment finished, a heap that
crashed partway through the catalog, a k-NN library that failed to load, an
ingest processor silently stripping the fields of every nested object, and
default merchant and publisher identifiers that had never existed in any
generated catalog. Two of them made the purchase flow impossible, so `make
demo` had never once completed. Every unit suite passed throughout, at the kill
ratios below.

Or on the host, if you have the toolchains installed:

```bash
make test             # every suite
make mutate           # gremlins, Stryker, and Infection
make lint             # gofmt, tsc, php -l
```

### End-to-end regression

The Cypress suite lives in [`cypress-tests/`](cypress-tests/) and follows the
conventions in [cypress-standards](https://github.com/craig-hunt/cypress-standards):
three-layer separation, no magic strings, and `data-testid` reached through
`cy.getByTestId()` as the only sanctioned selector.

**Headless, needing only Docker:**

```bash
make e2e         # headless, against a stack already seeded and running
make e2e-open    # interactive runner on your desktop, still in a container
make e2e-cold    # wipe, start, seed, then run the suite headless
```

The container joins the compose network and reaches services by name, which is
also how it reaches the driver, since that service publishes no port and the
dashboard proxies to it.

**Headed, watching the browser work:**

```bash
make e2e-open
```

The interactive runner opens on your desktop, from inside the container. Pick
**E2E Testing**, choose Chrome, Firefox, or Electron, and click a spec. Specs
bind-mount rather than copy, so editing one reruns it without rebuilding
anything.

**Nothing gets installed on your machine for this.** The image carries the
browsers and every library they need. What it borrows is somewhere to draw:
`make e2e-open` mounts the X socket, which WSLg supplies on Windows 11 and any
desktop session supplies on Linux. The target checks `DISPLAY` first and says
so plainly rather than failing inside Cypress.

To watch a run rather than drive one:

```bash
docker compose --profile e2e-open run --rm --entrypoint sh cypress-open \
  -c 'npx cypress run --headed --browser chrome'
```

**On the host instead**, if you would rather not go through Docker:

```bash
cd cypress-tests
npm ci
npm run cypress:open     # interactive runner, time travel, DOM snapshots
npm run cypress:run      # headless on the host
npm run verify           # eslint, prettier, and tsc without running a browser
```

**`npm run verify` needs no browser**, so lint, formatting, and types check on
any machine.

The two commands that launch one need a browser and its libraries. Windows and
macOS carry those already, so `cypress open` works from PowerShell or a mac
terminal with no extra setup. A minimal WSL install does not, and
[`RUNNING.md`](docs/RUNNING.md) lists what to add there. Both container targets
sidestep all of it.

Run one spec while iterating:

```bash
npm run cypress:single --spec=fraud/replayedAssertion
```

**What it covers.** The seven flows [ADR-0006](docs/adr/0006-testing-strategy.md)
commits to, plus an OWASP pass. The suite drives the dashboard's own controls to
create the activity it asserts on, and asserts deltas rather than absolute
totals, because a live population keeps settling while a spec runs.

Protocol-level flows go through the gateway directly with `cy.request`, since an
assertion refused at the edge never reaches a page. The replay spec signs a
genuine EIP-3009 authorization, because the single-use check sits behind
facilitator verification and a junk payment would be refused for the wrong
reason.

### OWASP coverage, and its limits

| | Covered | How |
|---|---|---|
| A01 Broken Access Control | Yes | Unknown and traversed identifiers, cross-publisher reads |
| A02 Cryptographic Failures | Yes | Signed assertions, bounded lifetimes, no key material in responses |
| A03 Injection | Yes | SQL metacharacters in identifiers and queries, stored XSS through rendered data |
| A04 Insecure Design | Partly | Single use, expiry, and a signed rate, carried by the fraud specs |
| A05 Security Misconfiguration | Yes | Handled error pages, no stack traces, no directory listing, no source disclosure |
| A06 Vulnerable Components | **No** | `npm audit` and `govulncheck` in CI. No browser test can assess this |
| A07 Authentication Failures | Documented | The app carries no authentication by design; the specs assert that posture and name it |
| A08 Data Integrity Failures | Yes | Swapped products, rewritten search bindings, immutable recorded splits |
| A09 Logging Failures | Yes | Every refusal persists with its reason and reaches the publisher page |
| A10 Server-Side Request Forgery | **No** | No endpoint accepts a URL; upstreams come from environment rather than requests |

**A07 deserves a note.** Nothing here authenticates anything, and the A07 specs
assert what is true rather than what should be. A suite that fails on purpose,
every run, teaches a team to ignore its own colour, which is the failure
[ADR-0006](docs/adr/0006-testing-strategy.md) warns about for brittle selectors.
The finding lives in the test names and in
[`PRODUCTIONALIZING.md`](docs/PRODUCTIONALIZING.md) instead.

### Mutation scores

Passing tests prove code runs. Mutation testing proves the tests would notice
if it stopped behaving correctly. [ADR-0006](docs/adr/0006-testing-strategy.md)
sets a 70% kill ratio; every package clears it.

| Package | Language | Kill ratio |
|---|---|---|
| `internal/settlement` | Go | 100.00% |
| `internal/ingest` | Go | 100.00% |
| `internal/attribution` | Go | 91.30% |
| `internal/generator` | Go | 89.09% |
| `internal/search` | Go | 82.00% |
| `simulator` | TypeScript | 86.61% |
| `packages/types` | TypeScript | 89.38% |
| `merchant` | TypeScript | 88.96% |
| `facilitator` | TypeScript | 87.58% |
| `gateway` | TypeScript | 86.61% |
| `app` | PHP | 92% MSI, 96% covered |

Within the simulator workspace, `agent.ts` scores 93.81%, `fraud.ts` 97.30%,
and `runner.ts` 77.50%. The runner sits lowest because its surviving mutants
live in loop and timing plumbing: sleep intervals, the drain counter, and the
break that stops an agent mid-flight. Killing those needs timing-sensitive
assertions, which buy a number and cost reliability. The logic deciding whether
a purchase settled, got blocked, or failed is covered.

**What the suites actually catch.** Go signs assertions and TypeScript verifies
them, so `cmd/fixture` mints a test vector in Go whose identifiers deliberately
carry `<` and `&`, and the TypeScript suite verifies it. A divergence in the
canonical signing bytes fails a test rather than a settlement.

Eight goroutines race for one assertion and exactly one wins. A settlement's
three ledger entries sum to zero on the rendered page, not merely in the
database. The mock facilitator verifies EIP-3009 signatures through real
EIP-712 recovery, so any payload it accepts the live facilitator accepts
too.

Database-backed tests run against a real Postgres rather than a mock, because
the correctness lives in constraints, transactions, and aggregate types that no
fake enforces. `internal/testsupport` starts one, gives each package its own
database, and skips only when the machine offers neither Docker nor
`TEST_POSTGRES_DSN`.

---

## What this demonstrates

- **x402 settlement** on Base Sepolia with real EIP-3009 signatures, not a mock
- **Attribution assertions** that survive the agent boundary and drive automatic commission split
- **Hybrid search in OpenSearch** (BM25 + k-NN, normalized and blended) with published p50/p99 latency against 1M listings
- **OpenSearch ingest discipline**: Bulk API, refresh disabled during load, replicas restored after, force merge, atomic alias swap for zero-downtime rebuilds
- **Postgres ingest discipline**: bulk COPY, staging tables, atomic partition swap
- **Correct language selection** per workload rather than per organizational habit
- **Documented scaling path** from demo scale to billions of rows daily
- **Tests that would notice a regression**: mutation-tested above 70% in all three languages, verified against a real database rather than a mock

---

## What this deliberately does not do

- **The merchant runs simulated.** A production merchant integration misses the point; demonstrating the attribution mechanism carries it.
- **No AP2 or ACP implementation.** This demo occupies the settlement layer. The other two layers get referenced, not built.
- **Testnet only.** Base Sepolia. No mainnet value moves.
- **Not production hardened.** No auth on internal service calls, no rate limiting, no HA. [`docs/PRODUCTIONALIZING.md`](docs/PRODUCTIONALIZING.md) lists what a team would add.

---

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component detail, data flow, service contracts |
| [SCALING.md](docs/SCALING.md) | What changes between demo scale and billions of rows daily |
| [DATA_GENERATION.md](docs/DATA_GENERATION.md) | Why synthetic, and the multi-merchant duplication model |
| [PRODUCTIONALIZING.md](docs/PRODUCTIONALIZING.md) | What a team adds to ship this for real |
| [RUNNING.md](docs/RUNNING.md) | Local and deployed setup |
| [cypress-tests/](cypress-tests/) | End-to-end regression suite, and how to run it headless or headed |
| [ADRs](docs/adr/) | Every non-obvious decision, with alternatives considered |

---

*Built by Craig Hunt. Architecture and code intended as a starting point a team can productionalize rather than as a finished product.*
