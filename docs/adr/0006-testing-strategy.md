# ADR-0006: Three-Tier Testing, Unit, Mutation, and Cypress Regression

**Status:** Accepted
**Date:** 2026-08-02

---

## Context

This project exists so a team can productionalize it. That intent raises the testing bar above what a demonstration usually carries, for three reasons.

**Code a team inherits gets changed.** The value of a starting point depends on whether the next engineer can modify it confidently. Tests that catch regressions provide the mechanism that makes inherited code safe to touch.

**Coverage measures the wrong thing.** Line coverage reports whether a line executed during a test run. It says nothing about whether any assertion would fail on a wrong line. A test suite can reach ninety percent coverage while asserting almost nothing, and that suite provides false confidence more dangerous than no suite at all.

**Three languages produce three contract boundaries.** The attribution assertion gets minted in Go, verified at the edge in TypeScript, verified again by the merchant, and rendered in PHP. Unit tests validate each implementation against its own understanding of the structure. Nothing in a unit test catches the case where the Go encoder and the TypeScript decoder disagree about field ordering or timestamp format. That failure surfaces only when the pieces run together.

Money moves through this system. A settlement crediting the wrong publisher, or crediting nobody, describes the failure mode that matters most, and it sits precisely at the seam where the three languages meet.

## Decision

**Four testing tiers, each answering a question the others cannot.**

### Tier 1: unit tests, per language

| Language | Framework |
|---|---|
| Go | standard `testing` with table-driven cases |
| TypeScript | Vitest |
| PHP | PHPUnit |

Focus on the logic that carries risk: assertion construction and verification, commission calculation, hybrid-score normalization, partition-swap sequencing, and every branch of the settlement state machine.

### Tier 2: mutation testing, per language, 70% minimum kill ratio

| Language | Tool |
|---|---|
| Go | gremlins |
| TypeScript | Stryker Mutator |
| PHP | Infection |

Mutation testing modifies the source (flips a conditional, changes an operator, removes a statement) and reruns the suite. A mutant that survives means no test would have caught that change, which identifies exactly where the suite asserts nothing meaningful.

**Threshold: 70% kill ratio minimum, enforced in CI.** Below that, the build fails.

The threshold applies to the logic that matters. Configuration excludes generated code, plain data structures, and framework glue rather than lowering the bar globally.

### Tier 3: the out-of-the-box smoke gate

`make smoke-cold` wipes the volumes, starts every service, seeds the catalog, drives a purchase end to end, replays the assertion to confirm the second attempt fails, and asserts that the settlement API and the dashboard both report what happened. It exits non-zero on any failed assertion, and CI runs it on every push.

**Tiers 1 and 2 are blind to an entire class of defect, by construction.** Each unit suite tests a service against a stub of its neighbours, and a stub encodes what its author believed the real dependency does. When that belief is wrong, the code and the stub carry the same mistake and agree with each other, so the tests pass and the system does not work. Mutation testing cannot reach this either: it measures whether the tests notice a change to the *code*, and no mutation operator rewrites a wrong assumption about OpenSearch. A high kill ratio against a wrong stub pins the wrong behaviour tightly.

The tier earned its place empirically. Running the documented first-run path found an Elasticsearch-only field type in the index mapping, a model used before its asynchronous deployment finished, a heap too small to build the k-NN graphs, a circuit breaker rejecting bulk batches, and an ingest processor silently stripping the fields of every nested object. Every unit suite passed throughout, at the mutation kill ratios recorded in the README.

This tier answers one question the others cannot: **does the thing work when someone clones it?**

### Tier 4: Cypress end-to-end regression

Drives the complete agent loop through the running system: search query, assertion issuance, product selection, 402 challenge, payment with attached assertion, settlement confirmation, and attribution chain rendered in the dashboard.

**The regression suite covers the paths that cross language boundaries:**

- Full happy path from search through settled commission
- Tampered assertion rejected at the edge
- Expired assertion rejected at settlement
- Replayed assertion rejected on second use
- Commission split lands on the correct publisher at the signed rate
- Search returns results within the latency budget
- Dashboard renders the complete chain from query to ledger entry

**Coverage target: 90% of mission-critical functionality.** Mission-critical means any path where a defect produces a wrong financial outcome, an incorrect attribution, or a security bypass. Cosmetic and convenience paths fall outside the bar.

### Test code standards

**The Cypress suite holds to the same engineering standards as production code.** Test code that violates the standards it exists to protect teaches the wrong lesson and rots faster than the code it tests.

**No magic strings or numbers anywhere in the suite.** Selectors, routes, fixture identifiers, expected commission rates, latency thresholds, and timeout values all live in named constants. A commission rate that appears as `450` inside an assertion becomes a silent failure the day the rate changes; the same value referenced from a shared constant fails loudly and in one place.

```
cypress/
├── constants/
│   ├── selectors.ts      data-testid values, and the attribute name itself
│   ├── routes.ts         application and API paths
│   ├── fixtures.ts       publisher IDs, product IDs, merchant IDs
│   └── thresholds.ts     latency budgets, expiry windows, commission rates
├── e2e/
└── support/
```

**Selectors bind to `data-testid` attributes exclusively, reached through a `cy.getByTestId()` command.** Never CSS classes, never element hierarchy, never text content. Class names change during styling work and hierarchy changes during refactors, and either one produces a failing suite that reports nothing about correctness. Routing every lookup through one command keeps the attribute name in a single place, so changing it is one edit rather than a find-and-replace across every spec.

This follows the selector hierarchy in [cypress-standards](https://github.com/craig-hunt/cypress-standards), which ranks `data-testid` first for application code, ARIA role and accessible name second, and stable structural selectors third and only for third-party pages nobody can modify.

**A test hook is not a functional attribute.** The dashboard already carries `data-sort`, `data-filter`, and `data-publisher`, which its own scripts read. Binding a spec to those would couple the suite to how the page implements sorting rather than to what it shows, and renaming an internal binding would break tests that had no business caring.

**No comments.** A test whose intent requires explanation needs a clearer name, not a comment. Test names read as complete sentences describing the behavior under test and the expected outcome.

**Shared constants cross the language boundary.** Commission rates, expiry windows, and latency thresholds originate in `packages/types` alongside the assertion schema, so a Cypress assertion and a Go implementation cannot disagree about the same value.

## Consequences

**Positive.**

- Mutation testing converts "we have tests" into "our tests would catch a defect," two different claims, and only one of them worth making.
- The Cypress suite validates the three-language contract that unit tests structurally cannot reach. When the Go encoder and TypeScript decoder drift, the E2E suite fails and the unit suites stay green, exactly the signal needed.
- Adversarial cases (tampering, replay, expiry) get tested as first-class scenarios rather than assumed. For a security-relevant mechanism, demonstrating the rejection paths matters more than demonstrating the happy path.
- A team inheriting this can refactor with real confidence, the entire point of shipping a starting point rather than a sketch.
- The published kill ratio gives a reviewer an objective read on test quality rather than a coverage percentage that flatters.

**Negative.**

- Mutation testing runs slowly. Every mutant requires a full suite execution, so runtime scales with mutant count times suite duration. Mitigated by running mutation on changed packages for pull requests and the full sweep nightly.
- Three mutation frameworks means three configurations, three exclusion lists, and three sets of tool-specific behavior to understand.
- Cypress requires the full stack running, including OpenSearch, Postgres, and a testnet connection. That makes the E2E suite the slowest and most brittle tier, and testnet variability can produce failures unrelated to code changes.
- Total CI time grows substantially over a unit-tests-only approach.

**Neutral.**

- The 70% threshold reflects judgment rather than law. It sits high enough to force meaningful assertions and low enough to avoid chasing mutants in code where the effort earns nothing.
- A stub at the facilitator boundary removes the Cypress testnet dependency for deterministic runs, with a separate suite exercising live settlement. That tradeoff gets decided during implementation.

## Alternatives considered

**Unit tests with a coverage threshold, no mutation testing.** The standard approach, and far cheaper in CI time. Rejected because coverage measures execution rather than assertion. A suite can execute every line while asserting almost nothing, and that produces confidence unbacked by evidence. Mutation testing stands alone among widely available techniques in measuring whether the tests would actually catch a defect.

**No tests, on the grounds that a demonstration needs none.** Common for demo repositories and defensible when the demo exists only for looking at. Rejected because this demo exists for a team to productionalize. Handing a team untested code and calling it a starting point transfers all the verification burden to them while claiming to have reduced it.

**Integration tests instead of unit tests.** Fewer tests, closer to real behavior, less coupling to implementation detail. Rejected as a replacement because integration tests localize failures poorly. When a commission calculation goes wrong, a unit test names the function and an integration test names the request. Both tiers stay, serving different purposes.

**Property-based testing rather than table-driven unit tests.** Genuinely stronger for the cryptographic and numeric paths, where generated inputs explore edge cases hand-written cases miss. Not rejected so much as deferred. Worth adding for assertion encoding and commission arithmetic specifically, and noted in `docs/PRODUCTIONALIZING.md`.

**Playwright rather than Cypress.** Faster, better parallelism, and stronger multi-browser support. A reasonable choice that would work equally well here. Cypress selected on familiarity and on the quality of its debugging experience during test authoring, which matters more for a suite this size than raw execution speed does.

**Contract testing (Pact or similar) instead of end-to-end.** Directly targets the cross-language boundary problem, and runs far faster than full E2E. Genuinely the better tool for validating that the Go producer and TypeScript consumer agree. Rejected for this build because it validates the contract without validating that the assembled system works, and a demo needs to demonstrate the working system. Worth adding alongside E2E at production scale, where E2E runtime becomes a bottleneck.
