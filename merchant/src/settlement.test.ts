import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AttributionAssertion } from '@agentic-attribution/types';

import { SettlementClient, type SettlementRequest } from './settlement.js';

const originalFetch = globalThis.fetch;

interface Captured {
  url?: string;
  method?: string;
  headers?: Headers;
  body?: string;
}

function withFetch<T>(
  captured: Captured,
  response: Response | (() => Promise<Response>),
  run: () => Promise<T>,
): Promise<T> {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.method = init?.method;
    captured.headers = new Headers(init?.headers);
    captured.body = typeof init?.body === 'string' ? init.body : undefined;

    return typeof response === 'function' ? response() : response;
  }) as typeof globalThis.fetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

const assertion: AttributionAssertion = {
  assertion_id: 'a1',
  publisher_id: 'pub_000001',
  product_id: 'prd_1',
  search_request_id: 'req_1',
  issued_at: '2026-07-30T12:00:00Z',
  expires_at: '2026-07-30T13:00:00Z',
  commission_bps: 450,
  signature: 'ed25519:unused',
};

// Matches the identifier format the generator produces, so a reader does not
// carry away an invented shape.
const MERCHANT_ID = 'mer_000042';

function request(): SettlementRequest {
  return {
    assertion,
    merchant_id: MERCHANT_ID,
    gross_amount_cents: 12_999,
    currency: 'USD',
    payment_payload: {
      x402Version: 1,
      scheme: 'exact',
      network: 'base-sepolia',
      authorization: {
        from: '0x1',
        to: '0x2',
        value: '129990000',
        validAfter: '0',
        validBefore: '1',
        nonce: '0x0',
      },
      signature: '0xsig',
    },
    payment_requirements: {
      scheme: 'exact',
      network: 'base-sepolia',
      asset: '0x3',
      maxAmountRequired: '129990000',
      payTo: '0x2',
      maxTimeoutSeconds: 120,
      resource: '/purchase/prd_1',
      description: 'Test',
    },
  };
}

const confirmed = {
  settlement_id: 'stl_1',
  status: 'confirmed',
  tx_hash: '0xdeadbeef',
  network: 'base-sepolia',
  payer: '0xpayer',
  commission_bps: 450,
  commission_amount_cents: 584,
  platform_fee_cents: 175,
  publisher_amount_cents: 409,
};

test('a confirmed settlement comes back as a result', async () => {
  const captured: Captured = {};

  const outcome = await withFetch(
    captured,
    new Response(JSON.stringify(confirmed), { status: 200 }),
    () => new SettlementClient('http://settlement.test').settle(request()),
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.result.settlement_id, 'stl_1');
  assert.equal(outcome.ok && outcome.result.publisher_amount_cents, 409);
});

test('the request posts JSON to the settle endpoint', async () => {
  const captured: Captured = {};

  await withFetch(captured, new Response(JSON.stringify(confirmed), { status: 200 }), () =>
    new SettlementClient('http://settlement.test').settle(request()),
  );

  assert.equal(captured.url, 'http://settlement.test/settle');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers?.get('Content-Type'), 'application/json');

  const sent = JSON.parse(captured.body ?? '{}');
  assert.equal(sent.merchant_id, MERCHANT_ID);
  assert.equal(sent.gross_amount_cents, 12_999);
  assert.equal(sent.assertion.assertion_id, 'a1');
});

// A doubled slash would produce //settle, which the service answers with a 404
// rather than a settlement.
test('a trailing slash on the base URL does not double', async () => {
  const captured: Captured = {};

  await withFetch(captured, new Response(JSON.stringify(confirmed), { status: 200 }), () =>
    new SettlementClient('http://settlement.test///').settle(request()),
  );

  assert.equal(captured.url, 'http://settlement.test/settle');
});

// Failures come back as data rather than as thrown errors, because a rejected
// payment is an ordinary outcome the merchant has to translate into a status
// for the agent rather than an exception to unwind on.
test('a rejection returns the upstream status and reason', async () => {
  const captured: Captured = {};

  const outcome = await withFetch(
    captured,
    new Response(JSON.stringify({ error: 'assertion already consumed', reason: 'assertion_reused' }), {
      status: 409,
    }),
    () => new SettlementClient('http://settlement.test').settle(request()),
  );

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.status, 409);
  assert.equal(!outcome.ok && outcome.rejection.reason, 'assertion_reused');
});

// A proxy or load balancer in front of settlement can answer with HTML. Calling
// json() on that throws, and the status the merchant needs would be lost.
test('a non-JSON error body still yields a usable rejection', async () => {
  const captured: Captured = {};

  const outcome = await withFetch(
    captured,
    new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    }),
    () => new SettlementClient('http://settlement.test').settle(request()),
  );

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.status, 502);
  assert.equal(!outcome.ok && outcome.rejection.reason, 'settlement_unavailable');
  assert.ok(!outcome.ok && outcome.rejection.error.includes('502'));
});

test('an empty error body does not throw', async () => {
  const captured: Captured = {};

  const outcome = await withFetch(captured, new Response('', { status: 503 }), () =>
    new SettlementClient('http://settlement.test').settle(request()),
  );

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.status, 503);
});

// A transport failure is not a rejection. The merchant has to surface it as its
// own error rather than reporting a settlement that was refused, because the
// two mean opposite things to a retrying caller.
test('a transport failure propagates rather than becoming a rejection', async () => {
  const captured: Captured = {};

  await assert.rejects(() =>
    withFetch(
      captured,
      () => Promise.reject(new TypeError('fetch failed')),
      () => new SettlementClient('http://settlement.test').settle(request()),
    ),
  );
});

test('the request carries an abort signal so a wedged service cannot hold the agent', async () => {
  let sawSignal = false;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return new Response(JSON.stringify(confirmed), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await new SettlementClient('http://settlement.test').settle(request());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sawSignal, true);
});
