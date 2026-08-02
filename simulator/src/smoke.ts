// End-to-end verification of the path a reviewer actually follows: clone,
// start, seed, and use the demo. Every other suite in this repository tests a
// component against a stub of its neighbours, so a wrong belief about a real
// dependency produces code and a stub that agree with each other and a system
// that does not work. This file asserts against the running system instead.
//
// Exits non-zero on the first failed assertion, so `make smoke` gates a commit
// the way the unit suites cannot.

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import {
  Agent,
  AgentError,
  type Fulfillment,
  type SearchResponse,
  type Selection,
} from './agent.js';

const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 2_000;

const gatewayUrl = process.env.GATEWAY_URL?.trim() || 'http://localhost:8080';
const settlementUrl = process.env.SETTLEMENT_URL?.trim() || 'http://localhost:8082';
const dashboardUrl = process.env.DASHBOARD_URL?.trim() || 'http://localhost:8000';
const searchUrl = process.env.SEARCH_URL?.trim() || 'http://localhost:8081';
const query = process.env.DEMO_QUERY?.trim() || 'trail running shoes';
const publisherId = process.env.DEMO_PUBLISHER_ID?.trim() || 'pub_000001';

let failures = 0;
let checks = 0;

function pass(name: string, detail = ''): void {
  checks += 1;
  console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
}

function fail(name: string, reason: string): void {
  checks += 1;
  failures += 1;
  console.log(`  FAIL  ${name}`);
  console.log(`        ${reason}`);
}

function expect(name: string, condition: boolean, reason: string, detail = ''): void {
  if (condition) {
    pass(name, detail);
    return;
  }
  fail(name, reason);
}

// An AgentError carries the status and the service's own reason. Reporting
// only its message turns "the merchant rejected the assertion as expired" into
// "purchase failed", which sends the reader to the wrong service.
function describe(error: unknown): string {
  if (error instanceof AgentError) {
    return `${error.message} (HTTP ${error.status}) ${JSON.stringify(error.body)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    pass(name, detail || '');
  } catch (error) {
    fail(name, describe(error));
  }
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function getJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function getText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return await response.text();
}

// A service that answers its health endpoint has finished starting. Racing the
// assertions against a still-booting cluster would produce failures that say
// nothing about the code.
async function waitForReady(name: string, url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'never attempted';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  throw new Error(`${name} never became ready at ${url}: ${lastError}`);
}

console.log('agentic-attribution smoke test');
console.log(`  gateway    ${gatewayUrl}`);
console.log(`  settlement ${settlementUrl}`);
console.log(`  dashboard  ${dashboardUrl}`);

console.log('\nReadiness');
await check('search answers /healthz', () => waitForReady('search', `${searchUrl}/healthz`));
await check('settlement answers /healthz', () =>
  waitForReady('settlement', `${settlementUrl}/healthz`),
);
await check('dashboard answers /healthz', () =>
  waitForReady('dashboard', `${dashboardUrl}/healthz`),
);

if (failures > 0) {
  console.log('\nServices did not come up. Nothing further can be verified.');
  process.exit(1);
}

// The seeded corpus has to be searchable before anything downstream means
// anything. An empty index would let every later assertion fail for a reason
// that has nothing to do with attribution.
console.log('\nCatalog');
await check('gateway search returns products and signed assertions', async () => {
  const response = await fetch(`${gatewayUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, publisher_id: publisherId, size: 10 }),
  });

  if (!response.ok) {
    throw new Error(`POST /search returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as SearchResponse;

  if (body.products.length === 0) {
    throw new Error(`"${query}" matched nothing; the index is empty or the alias is unset`);
  }
  // One assertion per product. A search that returns products without them
  // would let an agent buy with nothing to attribute the sale to.
  if (body.assertions.length === 0) {
    throw new Error(`${body.products.length} products came back carrying no assertions`);
  }
  return `${body.products.length} products, ${body.assertions.length} assertions`;
});

console.log('\nPurchase');
const account = privateKeyToAccount(generatePrivateKey());
const agent = new Agent({ gatewayUrl, account });

let selection: Selection | undefined;
let fulfillment: Fulfillment | undefined;

await check('agent completes a purchase through 402', async () => {
  const result = await agent.purchase(query, publisherId);
  selection = result.selection;
  fulfillment = result.fulfillment;
  return `${money(result.fulfillment.amount_cents)} settled as ${result.fulfillment.settlement_id}`;
});

if (!selection || !fulfillment) {
  console.log('\nThe purchase failed, so the settlement assertions cannot run.');
  process.exit(1);
}

const settled = fulfillment;
const chosen = selection;

expect(
  'the attributed publisher matches the requesting publisher',
  settled.attributed_publisher_id === publisherId,
  `attributed to ${settled.attributed_publisher_id}, expected ${publisherId}`,
  settled.attributed_publisher_id,
);

expect(
  'the publisher earned a non-zero commission',
  settled.publisher_commission_cents > 0,
  `commission came back as ${settled.publisher_commission_cents}`,
  money(settled.publisher_commission_cents),
);

expect(
  'settlement carries a transaction hash',
  typeof settled.tx_hash === 'string' && settled.tx_hash.length > 0,
  'the settlement recorded no transaction hash',
);

// The single-use guarantee is the property the whole design exists to provide.
// A replay that succeeds means the demo proves the opposite of its claim.
console.log('\nReplay protection');
await check('a replayed assertion is rejected with 409', async () => {
  const requirements = await agent.requestChallenge(chosen.product.product_id);
  const payment = await agent.signAuthorization(requirements);

  try {
    await agent.completePurchase(chosen.product.product_id, chosen.assertion, payment);
  } catch (error) {
    if (error instanceof AgentError && error.status === 409) {
      const body = error.body as { reason?: string };
      return body.reason ?? 'rejected';
    }
    throw new Error(
      `the replay was rejected for the wrong reason: ${
        describe(error)
      }`,
    );
  }

  throw new Error('the replay succeeded, so single-use enforcement is broken');
});

console.log('\nSettlement reporting');
interface PublisherSummary {
  publisher_id: string;
  settlement_count: number;
  gross_amount_cents: number;
  earned_cents: number;
  platform_fee_cents: number;
  assertions_consumed: number;
}

interface PublisherDetail {
  summary: PublisherSummary;
  settlements: Array<{ settlement_id: string; status: string }>;
}

await check('the settlement API reports the publisher totals', async () => {
  const detail = await getJSON<PublisherDetail>(`${settlementUrl}/publishers/${publisherId}`);
  const { summary } = detail;

  if (summary.settlement_count < 1) {
    throw new Error('the publisher shows no settlements after a completed purchase');
  }
  if (summary.earned_cents <= 0) {
    throw new Error('the publisher shows no earnings after a completed purchase');
  }
  if (!detail.settlements.some((row) => row.settlement_id === settled.settlement_id)) {
    throw new Error(`the settlement list omits ${settled.settlement_id}`);
  }
  return `${summary.settlement_count} settlements, ${money(summary.earned_cents)} earned`;
});

// The commission gets split, not the sale. Both parties taking a share of
// gross would pay out roughly fifty times what the merchant agreed to.
await check('the publisher and platform split the commission, not the sale', async () => {
  const { summary } = await getJSON<PublisherDetail>(`${settlementUrl}/publishers/${publisherId}`);
  const { gross_amount_cents: gross, earned_cents: earned, platform_fee_cents: platform } = summary;

  if (earned <= 0 || platform < 0) {
    throw new Error(`publisher earned ${earned}, platform took ${platform}`);
  }
  if (earned + platform >= gross) {
    throw new Error(
      `publisher ${earned} + platform ${platform} reaches or exceeds the gross ${gross}`,
    );
  }
  return `${money(earned)} + ${money(platform)} out of ${money(gross)} gross`;
});

interface Chain {
  settlement_id: string;
  search_request_id: string;
  assertion_id: string;
  publisher_id: string;
  gross_amount_cents: number;
  publisher_amount_cents: number;
  platform_fee_cents: number;
  assertion_consumed_at: string | null;
  commission_bps: number;
  commission_amount_cents: number;
  ledger_entries: Array<{ account: string; entry_type: string; amount_cents: number }>;
}

await check('the chain resolves query through assertion through to settlement', async () => {
  const chain = await getJSON<Chain>(`${settlementUrl}/settlements/${settled.settlement_id}/chain`);

  if (chain.search_request_id !== chosen.assertion.search_request_id) {
    throw new Error(
      `chain points at search ${chain.search_request_id}, the assertion carried ${chosen.assertion.search_request_id}`,
    );
  }
  if (chain.assertion_id !== chosen.assertion.assertion_id) {
    throw new Error('the chain resolved a different assertion than the one presented');
  }
  if (chain.publisher_id !== publisherId) {
    throw new Error(`the chain credits ${chain.publisher_id} rather than ${publisherId}`);
  }
  // Consumption is what makes the assertion single-use. An unstamped assertion
  // would replay successfully, and the 409 above would be enforcing nothing.
  if (!chain.assertion_consumed_at) {
    throw new Error('the settled assertion carries no consumption timestamp');
  }
  return `${chain.search_request_id} to ${chain.settlement_id}`;
});

// The commission_splits_exactly CHECK constraint enforces this on the row, so
// a mismatch here means the reporting query disagrees with the row underneath.
await check('the commission splits exactly between publisher and platform', async () => {
  const chain = await getJSON<Chain>(`${settlementUrl}/settlements/${settled.settlement_id}/chain`);

  if (chain.publisher_amount_cents + chain.platform_fee_cents !== chain.commission_amount_cents) {
    throw new Error(
      `publisher ${chain.publisher_amount_cents} + platform ${chain.platform_fee_cents} does not equal the commission ${chain.commission_amount_cents}`,
    );
  }

  // The signed rate decides the commission. A rate applied to the wrong base,
  // or ignored in favour of a stored default, shows up here and nowhere else.
  const expected = Math.round((chain.gross_amount_cents * chain.commission_bps) / 10_000);
  if (Math.abs(expected - chain.commission_amount_cents) > 1) {
    throw new Error(
      `${chain.commission_bps} bps of ${chain.gross_amount_cents} comes to ${expected}, the settlement recorded ${chain.commission_amount_cents}`,
    );
  }

  return `${money(chain.publisher_amount_cents)} + ${money(chain.platform_fee_cents)} = ${money(chain.commission_amount_cents)} at ${chain.commission_bps} bps`;
});

// Three entries that sum to zero is what makes it double-entry. A settlement
// posting a credit without its matching debit balances nothing.
await check('the ledger entries sum to zero', async () => {
  const chain = await getJSON<Chain>(`${settlementUrl}/settlements/${settled.settlement_id}/chain`);

  if (chain.ledger_entries.length === 0) {
    throw new Error('the settlement posted no ledger entries');
  }

  const total = chain.ledger_entries.reduce((sum, entry) => sum + entry.amount_cents, 0);
  if (total !== 0) {
    throw new Error(`${chain.ledger_entries.length} entries sum to ${total} rather than zero`);
  }

  return `${chain.ledger_entries.length} entries`;
});

// The play button is how anyone meeting this demo actually drives it, so the
// path from the browser through the driver to a settled row has to be tested
// like any other. Every request below goes through the dashboard's own proxy,
// which is the only route a browser has to the driver.
console.log('\nLive driver');

interface DriverStats {
  running: boolean;
  started: number;
  settled: number;
  blocked: number;
  failed: number;
}

async function driver(path: string, body: Record<string, unknown> = {}): Promise<DriverStats> {
  const response = await fetch(`${dashboardUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`POST ${path} returned ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as DriverStats;
}

await check('the dashboard reports driver status', async () => {
  const status = await getJSON<DriverStats>(`${dashboardUrl}/api/driver/status`);

  if (typeof status.settled !== 'number') {
    throw new Error('status carried no counters');
  }
  return status.running ? 'running' : 'stopped';
});

await check('one purchase fires from the dashboard and settles', async () => {
  const before = await getJSON<DriverStats>(`${dashboardUrl}/api/driver/status`);
  const after = await driver('/api/driver/once', { fraud_rate: 0 });

  if (after.settled !== before.settled + 1) {
    throw new Error(`settled went from ${before.settled} to ${after.settled}, expected one more`);
  }
  return `${after.settled} settled`;
});

// The security claim this project makes becomes visible here or nowhere.
await check('a fraud attempt gets blocked rather than settled', async () => {
  const before = await getJSON<DriverStats>(`${dashboardUrl}/api/driver/status`);
  const after = await driver('/api/driver/once', { fraud_rate: 1 });

  if (after.settled !== before.settled) {
    throw new Error('a tampered assertion settled, so verification is not holding');
  }
  if (after.blocked !== before.blocked + 1) {
    throw new Error(`blocked went from ${before.blocked} to ${after.blocked}, expected one more`);
  }
  return `${after.blocked} blocked`;
});

await check('a blocked attempt reaches the publisher table', async () => {
  const body = await getJSON<{ publishers: Array<{ blocked_count: number }> }>(
    `${dashboardUrl}/api/publishers`,
  );

  const blocked = body.publishers.reduce((sum, p) => sum + p.blocked_count, 0);
  if (blocked === 0) {
    throw new Error('no publisher shows a blocked attempt after one was refused');
  }
  return `${blocked} across the table`;
});

await check('start and stop drive the population', async () => {
  const started = await driver('/api/driver/start', { concurrency: 2, fraud_rate: 0 });
  if (!started.running) {
    throw new Error('the driver reported stopped immediately after start');
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const stopped = await driver('/api/driver/stop');
  if (stopped.running) {
    throw new Error('the driver kept running after stop');
  }
  if (stopped.started <= started.started) {
    throw new Error('a running population attempted nothing');
  }
  return `${stopped.started - started.started} attempts while running`;
});

// The dashboard is the only surface a reviewer looks at rather than reads
// about, and no other test in this repository loads a page from it.
console.log('\nDashboard');
await check('the dashboard renders the publisher index', async () => {
  const html = await getText(`${dashboardUrl}/`);
  if (!html.includes(publisherId)) {
    throw new Error(`the index rendered without ${publisherId} in it`);
  }
  return `${html.length} bytes`;
});

await check('the dashboard renders the publisher detail page', async () => {
  const html = await getText(`${dashboardUrl}/publishers/${publisherId}`);
  if (!html.includes(settled.settlement_id)) {
    throw new Error(`the publisher page does not list settlement ${settled.settlement_id}`);
  }
  return settled.settlement_id;
});

await check('the dashboard renders the settlement chain page', async () => {
  const html = await getText(`${dashboardUrl}/settlements/${settled.settlement_id}`);
  if (!html.includes(chosen.assertion.assertion_id)) {
    throw new Error('the settlement page does not show the assertion it settled');
  }
  return chosen.assertion.assertion_id;
});

console.log('');
if (failures > 0) {
  console.log(`${failures} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`All ${checks} checks passed. The demo works from a clean start.`);
