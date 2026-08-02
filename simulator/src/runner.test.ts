import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';

import { ASSERTION_HEADER } from './agent.js';
import { Runner, pick } from './runner.js';

const PRODUCT_ID = 'prd_00000001';
const PUBLISHER_ID = 'pub_000001';
const QUERY = 'trail running shoes';
const GENUINE_PUBLISHER_ONLY = 0;
const ALWAYS_FRAUD = 1;

interface FakeOptions {
  // Called with the assertion the agent presented, returning the rejection to
  // answer with, or null to let the purchase settle.
  reject?: (assertion: Record<string, unknown>) => { status: number; reason: string } | null;
  emptyCatalog?: boolean;
}

/**
 * Stands in for the gateway, which is the only thing the runner talks to.
 * Deliberately answers a real 402 and a real fulfilment shape, so the runner
 * exercises the same code path it uses against the live stack.
 */
function fakeGateway(options: FakeOptions = {}): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '/';
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };

      if (url === '/search') {
        if (options.emptyCatalog) {
          send(200, { search_request_id: 'req_1', products: [], assertions: [] });
          return;
        }

        send(200, {
          search_request_id: 'req_1',
          products: [
            {
              product_id: PRODUCT_ID,
              canonical_title: 'Trail Runner Pro',
              offers: [
                {
                  listing_id: 'lst_1',
                  merchant_id: 'mer_000042',
                  listing_title: 'Trail Runner Pro',
                  price_cents: 7175,
                  in_stock: true,
                  commission_bps: 214,
                  deep_link_url: 'https://example/p/1',
                },
              ],
            },
          ],
          assertions: [
            {
              assertion_id: 'a1',
              publisher_id: PUBLISHER_ID,
              product_id: PRODUCT_ID,
              search_request_id: 'req_1',
              issued_at: '2026-08-02T12:00:00Z',
              expires_at: '2099-08-02T13:00:00Z',
              commission_bps: 214,
              signature: 'ed25519:genuine',
            },
          ],
        });
        return;
      }

      if (url === '/purchase') {
        const presented = request.headers[ASSERTION_HEADER];

        if (presented === undefined) {
          send(402, {
            x402Version: 1,
            accepts: [
              {
                scheme: 'exact',
                network: 'base-sepolia',
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                maxAmountRequired: '71750',
                payTo: '0x1111111111111111111111111111111111111111',
                maxTimeoutSeconds: 120,
                resource: `/purchase/${PRODUCT_ID}`,
                description: 'Trail Runner Pro',
              },
            ],
          });
          return;
        }

        const assertion = JSON.parse(
          Buffer.from(String(presented), 'base64').toString(),
        ) as Record<string, unknown>;

        const rejection = options.reject?.(assertion) ?? null;
        if (rejection) {
          send(rejection.status, { error: 'rejected', reason: rejection.reason });
          return;
        }

        send(200, {
          order_id: 'ord_1',
          product_id: PRODUCT_ID,
          amount_cents: 7175,
          settlement_id: 'stl_1',
          tx_hash: '0xabc',
          attributed_publisher_id: assertion.publisher_id,
          publisher_commission_cents: 108,
        });
        return;
      }

      send(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

const servers: Server[] = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
});

async function runnerAgainst(options: FakeOptions = {}, fraudRate = GENUINE_PUBLISHER_ONLY) {
  const { url, server } = await fakeGateway(options);
  servers.push(server);

  const runner = new Runner({
    gatewayUrl: url,
    queries: [QUERY],
    publisherIds: [PUBLISHER_ID],
    fraudRate,
    pauseMs: 1,
  });

  return runner;
}

test('a genuine run settles and counts once', async () => {
  const runner = await runnerAgainst();

  await runner.runOnce();

  assert.equal(runner.stats.settled, 1);
  assert.equal(runner.stats.blocked, 0);
  assert.equal(runner.stats.failed, 0);
  assert.equal(runner.stats.started, 1);
});

// The event line is the only place a viewer reads what an agent just did, so
// the amounts in it have to be the amounts that moved.
test('a settled run reports the commission and the sale in dollars', async () => {
  const runner = await runnerAgainst();

  await runner.runOnce();

  assert.match(runner.stats.lastEvent, /\$1\.08/);
  assert.match(runner.stats.lastEvent, /\$71\.75/);
  assert.match(runner.stats.lastEvent, new RegExp(PUBLISHER_ID));
});

// A platform that refuses without naming a reason still has to be counted
// under something a reader can act on.
test('a rejection carrying no reason falls back to its status code', async () => {
  const { url, server } = await fakeGateway({ reject: () => ({ status: 503, reason: '' }) });
  servers.push(server);
  const runner = new Runner({
    gatewayUrl: url,
    queries: [QUERY],
    publisherIds: [PUBLISHER_ID],
    pauseMs: 1,
  });

  await runner.runOnce();

  assert.equal(runner.stats.byReason.http_503, 1);
});

test('selection walks the whole list rather than favouring one end', () => {
  const items = ['a', 'b', 'c', 'd'];

  assert.equal(pick(items, () => 0), 'a');
  assert.equal(pick(items, () => 0.26), 'b');
  assert.equal(pick(items, () => 0.51), 'c');
  assert.equal(pick(items, () => 0.99), 'd');
});

test('selecting from an empty list yields nothing rather than throwing', () => {
  assert.equal(pick([], () => 0.5), undefined);
});

// A tampered assertion the platform refuses counts as blocked rather than
// failed. Conflating the two would make the security demonstration report its
// successes as errors.
test('a refused fraud attempt counts as blocked, not failed', async () => {
  const runner = await runnerAgainst(
    { reject: () => ({ status: 401, reason: 'assertion_signature_invalid' }) },
    ALWAYS_FRAUD,
  );

  await runner.runOnce();

  assert.equal(runner.stats.blocked, 1);
  assert.equal(runner.stats.failed, 0);
  assert.equal(runner.stats.byReason.assertion_signature_invalid, 1);
});

// Reporting only "blocked" would let the demonstration claim a signature check
// caught something an expiry check actually caught. Naming both keeps it
// honest about which control fired.
test('fraud refused for an unexpected reason names what was expected', async () => {
  const runner = await runnerAgainst(
    { reject: () => ({ status: 409, reason: 'assertion_reused' }) },
    ALWAYS_FRAUD,
  );

  await runner.runOnce();

  assert.equal(runner.stats.blocked, 1);
  assert.match(runner.stats.lastEvent, /expected/);
  assert.match(runner.stats.lastEvent, /assertion_reused/);
});

test('fraud refused for the expected reason reports it plainly', async () => {
  const runner = await runnerAgainst(
    { reject: () => ({ status: 401, reason: 'assertion_signature_invalid' }) },
    ALWAYS_FRAUD,
  );

  await runner.runOnce();

  // Only three of the five modes expect a signature failure, so this asserts
  // the shape rather than a reason the draw does not control.
  assert.match(runner.stats.lastEvent, /^blocked \w+ on pub_\d+/);
});

// The one outcome that makes the whole demonstration wrong: a platform that
// accepts an assertion it should have refused.
test('fraud the platform accepts counts as a failure, never as a settlement', async () => {
  const runner = await runnerAgainst({ reject: () => null }, ALWAYS_FRAUD);

  await runner.runOnce();

  assert.equal(runner.stats.settled, 0);
  assert.equal(runner.stats.failed, 1);
  assert.match(runner.stats.lastEvent, /SECURITY/);
});

test('a rejection of a genuine purchase counts as failed rather than blocked', async () => {
  const runner = await runnerAgainst({
    reject: () => ({ status: 409, reason: 'assertion_reused' }),
  });

  await runner.runOnce();

  assert.equal(runner.stats.failed, 1);
  assert.equal(runner.stats.blocked, 0);
  assert.equal(runner.stats.byReason.assertion_reused, 1);
});

test('an empty catalog reports rather than throwing', async () => {
  const runner = await runnerAgainst({ emptyCatalog: true });

  await runner.runOnce();

  assert.equal(runner.stats.failed, 1);
  assert.match(runner.stats.lastEvent, /no purchasable offer/);
});

test('a runner with no publishers configured reports instead of crashing', async () => {
  const { url, server } = await fakeGateway();
  servers.push(server);
  const runner = new Runner({ gatewayUrl: url, queries: [QUERY], pauseMs: 1 });

  await runner.runOnce();

  assert.equal(runner.stats.failed, 1);
  assert.match(runner.stats.lastEvent, /no publishers/);
});

test('publishers arrive at runtime from the catalog', async () => {
  const runner = await runnerAgainst();
  const bare = new Runner({ gatewayUrl: 'http://unused', queries: [QUERY], pauseMs: 1 });

  bare.setPublishers([PUBLISHER_ID]);
  await runner.runOnce();

  assert.equal(runner.stats.settled, 1);
  assert.equal(bare.stats.failed, 0);
});

test('start runs continuously until stopped and drains cleanly', async () => {
  const runner = await runnerAgainst();

  runner.start({ concurrency: 2 });
  assert.equal(runner.stats.running, true);

  await new Promise((resolve) => setTimeout(resolve, 60));
  await runner.drain();

  assert.equal(runner.stats.running, false);
  assert.ok(runner.stats.settled >= 1, 'a continuous run settled nothing');
});

// Starting twice must not double the agent population, which would make the
// button add load every time an impatient viewer pressed it.
test('starting an already running runner adds no agents', async () => {
  const runner = await runnerAgainst();

  runner.start({ concurrency: 2 });
  runner.start({ concurrency: 2 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await runner.drain();

  assert.equal(runner.stats.running, false);
});

test('concurrency and fraud rate clamp to sane bounds', async () => {
  const runner = await runnerAgainst();

  runner.configure({ concurrency: 5000, fraudRate: 40 });
  assert.equal(runner.stats.concurrency, 32);
  assert.equal(runner.stats.fraudRate, 1);

  runner.configure({ concurrency: -3, fraudRate: -1 });
  assert.equal(runner.stats.concurrency, 1);
  assert.equal(runner.stats.fraudRate, 0);
});

// Changing one setting must leave the other alone, so ticking the fraud box
// mid-run does not silently reset the agent count.
test('configuring one setting leaves the other untouched', async () => {
  const runner = await runnerAgainst();

  runner.configure({ concurrency: 9 });
  runner.configure({ fraudRate: 0.5 });

  assert.equal(runner.stats.concurrency, 9);
  assert.equal(runner.stats.fraudRate, 0.5);
});

test('stats hand back a copy rather than the live object', async () => {
  const runner = await runnerAgainst();

  await runner.runOnce();
  const snapshot = runner.stats;
  snapshot.settled = 999;
  snapshot.byReason.injected = 1;

  assert.equal(runner.stats.settled, 1);
  assert.equal(runner.stats.byReason.injected, undefined);
});

test('a transport failure counts without throwing', async () => {
  const runner = new Runner({
    // Nothing listens here, so fetch rejects rather than answering.
    gatewayUrl: 'http://127.0.0.1:1',
    queries: [QUERY],
    publisherIds: [PUBLISHER_ID],
    pauseMs: 1,
  });

  await runner.runOnce();

  assert.equal(runner.stats.failed, 1);
});
