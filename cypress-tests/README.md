# End-to-end regression suite

Cypress specs covering the flows [ADR-0006](../docs/adr/0006-testing-strategy.md)
commits to, plus an OWASP pass. Follows the conventions in
[cypress-standards](https://github.com/craig-hunt/cypress-standards).

---

## Running it

**Nothing needs installing for either container target.** The image carries the
browsers and every library they need.

```bash
make e2e         # headless, against a stack already running and seeded
make e2e-open    # interactive runner on your desktop, still in a container
make e2e-cold    # wipe, start, seed, then run headless
```

Run those from the repository root, not from here.

The `e2e` targets restart the facilitator with `FACILITATOR_FAULT_INJECTION`
enabled, because three specs exercise failure paths a facilitator that only
succeeds can never produce. It stays off everywhere else: the control has no
authentication in front of it, so leaving it reachable would hand any caller a
way to halt settlement.

`make e2e-open` needs somewhere to draw. WSLg supplies a display on Windows 11
and a desktop session supplies one on Linux. The target checks `DISPLAY` first
and says so plainly rather than failing several layers inside Cypress.

### On the host instead

```bash
npm ci
npm run cypress:open                 # interactive runner
npm run cypress:run                  # headless
npm run verify                       # eslint, prettier, and tsc, no browser
```

One spec while iterating. Arguments pass through after `--`, which behaves the
same in bash, PowerShell, and cmd:

```bash
npm run cypress:single -- --spec "cypress/support/test_cases/fraud/replayedAssertion.ts"
```

**`npm run verify` runs anywhere.** The two commands launching a browser need
its libraries, which Windows and macOS already carry and a minimal WSL install
does not. [`RUNNING.md`](../docs/RUNNING.md) lists what to add under WSL.

Host runs target `localhost` by default. Point them elsewhere with
`CYPRESS_DASHBOARD_BASE_URL`, `CYPRESS_GATEWAY_BASE_URL`, and
`CYPRESS_SETTLEMENT_BASE_URL`, or keep a `.env` outside the repository and name
it through `CYPRESS_DOTENV_PATH`.

---

## Layout

```
cypress/support/
├── constants/      selectors, routes, and test data as named values
├── repositories/   element retrieval only, one method per element
├── actions/        interactions built from repository methods
├── types/          the shapes the platform answers with
└── test_cases/     arrange, act, assert
```

**Tests never touch selectors. Selectors never contain logic. Logic never
contains assertions.** A renamed hook changes one repository method and no spec.

Selectors bind to `data-testid` through `cy.getByTestId()`, and to nothing else.
A `findByTestId` scopes inside an element already in hand, which the publisher
table needs because it renders forty-eight rows carrying identical hook names.

The application emits those hooks from two places: PHP renders them, and the
script that rebuilds rows on each poll re-emits them. A PHPUnit test asserts
both paths agree, so a rename fails there before it reaches a spec here.

---

## How specs get their data

**They create it, by driving the dashboard's own controls.** Assertions compare
deltas rather than absolute totals, because a live population keeps settling
while a spec runs.

Protocol-level flows go through the gateway with `cy.request` instead, since an
assertion refused at the edge never reaches a page.

**The replay spec signs a genuine EIP-3009 authorization.** The single-use check
sits behind facilitator verification, so a junk payment would be refused for the
wrong reason and prove nothing about replay. That is why `viem` appears in the
dependencies.

The suite declares the EIP-712 domain and EIP-3009 types itself rather than
importing them from `packages/types`. A suite sharing protocol definitions with
the code under test stops noticing when that code drifts.

---

## Two rejection vocabularies

The merchant verifies an assertion before forwarding anything, so a tampered or
expired one never reaches settlement. The two layers name the same refusal
differently:

| Layer                      | Signature failure             | Expiry failure      |
| -------------------------- | ----------------------------- | ------------------- |
| `packages/types/verify.ts` | `invalid_signature`           | `expired`           |
| `internal/settlement`      | `assertion_signature_invalid` | `assertion_expired` |

`constants/testData.ts` names both sets separately, so a spec asserts the layer
it actually reached and the split stays visible rather than accidental.

---

## OWASP coverage

A01, A02, A03, A05, A07, A08, and A09 carry specs. A06 and A10 do not, on
purpose: no browser test assesses dependency vulnerabilities, and no endpoint
here accepts a URL. The [README](../README.md) records both with the reason.

**A07 asserts the posture that exists rather than the one that should.** This
application authenticates nothing, deliberately, and
[`PRODUCTIONALIZING.md`](../docs/PRODUCTIONALIZING.md) records that as a deploy
blocker. A suite failing on purpose every run teaches a team to ignore its own
colour, so the finding lives in the test names instead.
