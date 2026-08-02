import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BASE_SEPOLIA,
  EIP3009_PRIMARY_TYPE,
  EIP3009_TYPES,
  eip712Domain,
  toTypedMessage,
  type AttributionAssertion,
} from '@agentic-attribution/types';
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  ASSERTION_HEADER,
  Agent,
  AgentError,
  PAYMENT_HEADER,
  randomNonce,
  selectCheapestInStock,
  type PaymentRequirements,
  type SearchResponse,
} from './agent.js';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const NETWORK = 'base-sepolia';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const FIXED_NOW = 1_800_000_000_000;

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: NETWORK,
  asset: BASE_SEPOLIA.usdcAddress,
  maxAmountRequired: '129990000',
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  resource: '/purchase/prod_1',
  description: 'Test Listing',
};

function assertion(productId: string): AttributionAssertion {
  return {
    assertion_id: `a_${productId}`,
    publisher_id: 'pub_000001',
    product_id: productId,
    search_request_id: 'req_1',
    issued_at: '2026-07-30T12:00:00Z',
    expires_at: '2026-07-30T13:00:00Z',
    commission_bps: 450,
    signature: 'ed25519:unused-by-these-tests',
  };
}

const searchResponse: SearchResponse = {
  search_request_id: 'req_1',
  products: [
    {
      product_id: 'prod_a',
      canonical_title: 'Product A',
      offers: [
        { listing_id: 'l1', merchant_id: 'm1', price_cents: 9_999, in_stock: true, commission_bps: 400 },
        { listing_id: 'l2', merchant_id: 'm2', price_cents: 8_500, in_stock: false, commission_bps: 900 },
      ],
    },
    {
      product_id: 'prod_b',
      canonical_title: 'Product B',
      offers: [
        { listing_id: 'l3', merchant_id: 'm3', price_cents: 7_200, in_stock: true, commission_bps: 300 },
      ],
    },
  ],
  assertions: [assertion('prod_a'), assertion('prod_b')],
};

test('selects the cheapest in-stock offer and skips out-of-stock ones', () => {
  const selection = selectCheapestInStock(searchResponse);

  assert.equal(selection?.offer.listing_id, 'l3');
  assert.equal(selection?.product.product_id, 'prod_b');
  assert.equal(selection?.assertion.product_id, 'prod_b');
});

// An assertion covers a product, so a product arriving without one cannot be
// purchased with attribution and gets skipped rather than bought unattributed.
test('skips products carrying no assertion', () => {
  const selection = selectCheapestInStock({
    ...searchResponse,
    assertions: [assertion('prod_a')],
  });

  assert.equal(selection?.product.product_id, 'prod_a');
});

test('returns null when nothing is in stock', () => {
  const selection = selectCheapestInStock({
    ...searchResponse,
    products: searchResponse.products.map((p) => ({
      ...p,
      offers: p.offers.map((o) => ({ ...o, in_stock: false })),
    })),
  });

  assert.equal(selection, null);
});

// Reusing a nonce would fail on chain rather than transfer twice, so uniqueness
// is a correctness property rather than a nicety.
test('nonces are unique and correctly shaped', () => {
  const seen = new Set<string>();

  for (let i = 0; i < 1_000; i += 1) {
    const nonce = randomNonce();

    assert.match(nonce, /^0x[0-9a-f]{64}$/);
    assert.equal(seen.has(nonce), false, 'generated a duplicate nonce');
    seen.add(nonce);
  }
});

// The signature the agent produces must verify against the same domain and
// types the facilitator uses. Both sides import that definition from the
// shared package, and this test proves they agree end to end.
test('the signed authorization verifies against the EIP-712 domain', async () => {
  const agent = new Agent({
    gatewayUrl: 'http://gateway.test',
    account,
    now: () => FIXED_NOW,
  });

  const payment = await agent.signAuthorization(requirements);

  assert.equal(payment.authorization.from, account.address);
  assert.equal(payment.authorization.to, PAY_TO);
  assert.equal(payment.authorization.value, requirements.maxAmountRequired);

  const valid = await verifyTypedData({
    address: account.address,
    domain: eip712Domain(NETWORK),
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message: toTypedMessage(payment.authorization),
    signature: payment.signature as `0x${string}`,
  });

  assert.equal(valid, true);
});

test('the validity window brackets the signing moment', async () => {
  const agent = new Agent({ gatewayUrl: 'http://g.test', account, now: () => FIXED_NOW });
  const payment = await agent.signAuthorization(requirements);

  const seconds = BigInt(Math.floor(FIXED_NOW / 1000));

  assert.ok(BigInt(payment.authorization.validAfter) < seconds, 'validAfter must be backdated');
  assert.equal(
    BigInt(payment.authorization.validBefore),
    seconds + BigInt(requirements.maxTimeoutSeconds),
  );
});

test('a 200 on the unpaid purchase is treated as a failure', async () => {
  const agent = new Agent({
    gatewayUrl: 'http://g.test',
    account,
    fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => agent.requestChallenge('prod_a'),
    (error: unknown) => error instanceof AgentError && error.status === 200,
  );
});

test('the payment and assertion travel as base64 headers', async () => {
  let captured: Headers | undefined;

  const agent = new Agent({
    gatewayUrl: 'http://g.test',
    account,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response(JSON.stringify({ order_id: 'o1' }), { status: 200 });
    }) as typeof globalThis.fetch,
  });

  await agent.completePurchase('prod_a', assertion('prod_a'), { scheme: 'exact' });

  const encoded = captured?.get(ASSERTION_HEADER);
  assert.ok(encoded);
  assert.deepEqual(JSON.parse(atob(encoded)), assertion('prod_a'));
  assert.ok(captured?.get(PAYMENT_HEADER));
});

test('a rejected purchase surfaces the status and body', async () => {
  const agent = new Agent({
    gatewayUrl: 'http://g.test',
    account,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ reason: 'assertion_reused' }), {
        status: 409,
      })) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => agent.completePurchase('prod_a', assertion('prod_a'), {}),
    (error: unknown) =>
      error instanceof AgentError &&
      error.status === 409 &&
      (error.body as { reason: string }).reason === 'assertion_reused',
  );
});

// A gateway, load balancer, or proxy can answer with plain text or an HTML
// error page. Calling response.json() on that throws a SyntaxError that
// discards the status and body AgentError exists to carry.
test('a non-JSON error body preserves the status and the raw text', async () => {
  const agent = new Agent({
    gatewayUrl: 'http://g.test',
    account,
    fetchImpl: (async () =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => agent.completePurchase('prod_a', assertion('prod_a'), {}),
    (error: unknown) =>
      error instanceof AgentError &&
      error.status === 502 &&
      typeof error.body === 'string' &&
      error.body.includes('502 Bad Gateway'),
  );
});

test('an empty error body does not throw', async () => {
  const agent = new Agent({
    gatewayUrl: 'http://g.test',
    account,
    fetchImpl: (async () => new Response('', { status: 504 })) as typeof globalThis.fetch,
  });

  await assert.rejects(
    () => agent.completePurchase('prod_a', assertion('prod_a'), {}),
    (error: unknown) => error instanceof AgentError && error.status === 504,
  );
});

test('a non-JSON body on the search and challenge paths behaves the same way', async () => {
  const plain = (async () =>
    new Response('upstream unavailable', { status: 503 })) as typeof globalThis.fetch;

  const agent = new Agent({ gatewayUrl: 'http://g.test', account, fetchImpl: plain });

  await assert.rejects(
    () => agent.search('shoes', 'pub_000001'),
    (error: unknown) => error instanceof AgentError && error.body === 'upstream unavailable',
  );

  await assert.rejects(
    () => agent.requestChallenge('prod_a'),
    (error: unknown) => error instanceof AgentError && error.body === 'upstream unavailable',
  );
});

interface Sent {
  url: string;
  method?: string;
  headers: Headers;
  body?: string;
}

function recordingAgent(responses: Response[], gatewayUrl = 'http://g.test') {
  const sent: Sent[] = [];
  let next = 0;

  const agent = new Agent({
    gatewayUrl,
    account,
    now: () => FIXED_NOW,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return responses[next++] ?? new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  return { agent, sent };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// A trailing slash would produce //search, which the gateway answers with a
// 404 rather than results.
test('a trailing slash on the gateway URL does not double', async () => {
  const { agent, sent } = recordingAgent([json(searchResponse)], 'http://g.test///');

  await agent.search('shoes', 'pub_000001');

  assert.equal(sent[0]?.url, 'http://g.test/search');
});

test('search posts the query, publisher, and size as JSON', async () => {
  const { agent, sent } = recordingAgent([json(searchResponse)]);

  await agent.search('trail shoes', 'pub_0007', 42);

  assert.equal(sent[0]?.url, 'http://g.test/search');
  assert.equal(sent[0]?.method, 'POST');
  assert.equal(sent[0]?.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(sent[0]?.body ?? '{}'), {
    query: 'trail shoes',
    publisher_id: 'pub_0007',
    size: 42,
  });
});

test('search defaults its page size rather than omitting it', async () => {
  const { agent, sent } = recordingAgent([json(searchResponse)]);

  await agent.search('shoes', 'pub_000001');

  assert.equal(JSON.parse(sent[0]?.body ?? '{}').size, 10);
});

test('the challenge request carries the product and no payment headers', async () => {
  const { agent, sent } = recordingAgent([
    json({ x402Version: 1, accepts: [requirements] }, 402),
  ]);

  await agent.requestChallenge('prd_9');

  assert.equal(sent[0]?.url, 'http://g.test/purchase');
  assert.equal(sent[0]?.method, 'POST');
  assert.equal(sent[0]?.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(JSON.parse(sent[0]?.body ?? '{}'), { product_id: 'prd_9' });

  // The first half of the exchange carries no payment, so sending one would
  // skip the challenge the merchant is meant to issue.
  assert.equal(sent[0]?.headers.get(PAYMENT_HEADER), null);
  assert.equal(sent[0]?.headers.get(ASSERTION_HEADER), null);
});

// A 402 with no requirements leaves nothing to sign. Proceeding would build an
// authorization against undefined and fail somewhere unrelated.
test('a 402 carrying no requirements is refused', async () => {
  const { agent } = recordingAgent([json({ x402Version: 1, accepts: [] }, 402)]);

  await assert.rejects(
    () => agent.requestChallenge('prd_1'),
    (error: unknown) => error instanceof AgentError && error.status === 402,
  );
});

test('the completed purchase posts the product alongside both headers', async () => {
  const { agent, sent } = recordingAgent([json({ order_id: 'o1' })]);

  await agent.completePurchase('prd_3', assertion('prd_3'), { scheme: 'exact' });

  assert.equal(sent[0]?.url, 'http://g.test/purchase');
  assert.equal(sent[0]?.method, 'POST');
  assert.deepEqual(JSON.parse(sent[0]?.body ?? '{}'), { product_id: 'prd_3' });
  assert.ok(sent[0]?.headers.get(PAYMENT_HEADER));
  assert.ok(sent[0]?.headers.get(ASSERTION_HEADER));
});

// Ties resolve to the first offer seen rather than the last. A non-strict
// comparison would keep swapping between equally priced offers and make the
// selection depend on result ordering that carries no meaning.
test('equally priced in-stock offers resolve to the first seen', () => {
  const tied: SearchResponse = {
    search_request_id: 'req_1',
    products: [
      {
        product_id: 'prd_a',
        canonical_title: 'A',
        offers: [
          { listing_id: 'first', merchant_id: 'm1', price_cents: 5_000, in_stock: true, commission_bps: 100 },
          { listing_id: 'second', merchant_id: 'm2', price_cents: 5_000, in_stock: true, commission_bps: 900 },
        ],
      },
    ],
    assertions: [assertion('prd_a')],
  };

  assert.equal(selectCheapestInStock(tied)?.offer.listing_id, 'first');
});

test('a cheaper out-of-stock offer never wins over a costlier available one', () => {
  const mixed: SearchResponse = {
    search_request_id: 'req_1',
    products: [
      {
        product_id: 'prd_a',
        canonical_title: 'A',
        offers: [
          { listing_id: 'cheap', merchant_id: 'm1', price_cents: 100, in_stock: false, commission_bps: 100 },
          { listing_id: 'available', merchant_id: 'm2', price_cents: 9_999, in_stock: true, commission_bps: 100 },
        ],
      },
    ],
    assertions: [assertion('prd_a')],
  };

  assert.equal(selectCheapestInStock(mixed)?.offer.listing_id, 'available');
});

// purchase() drives the whole loop, so a search returning nothing buyable has
// to stop with a clear reason rather than signing an authorization for a
// product that does not exist.
test('the full loop refuses to proceed with nothing buyable', async () => {
  const empty: SearchResponse = { search_request_id: 'req_1', products: [], assertions: [] };
  const { agent } = recordingAgent([json(empty)]);

  await assert.rejects(
    () => agent.purchase('nothing matches this', 'pub_000001'),
    (error: unknown) =>
      error instanceof AgentError && error.status === 404 && error.message.includes('nothing matches this'),
  );
});

test('the full loop searches, takes the challenge, signs, and pays in order', async () => {
  const { agent, sent } = recordingAgent([
    json(searchResponse),
    json({ x402Version: 1, accepts: [requirements] }, 402),
    json({ order_id: 'o1', settlement_id: 'stl_1', attributed_publisher_id: 'pub_000001' }),
  ]);

  const { selection, fulfillment } = await agent.purchase('runner', 'pub_000001');

  assert.equal(sent.length, 3);
  assert.equal(sent[0]?.url, 'http://g.test/search');
  assert.equal(sent[1]?.url, 'http://g.test/purchase');
  assert.equal(sent[2]?.url, 'http://g.test/purchase');

  // Only the final call carries payment; the challenge must go out bare.
  assert.equal(sent[1]?.headers.get(PAYMENT_HEADER), null);
  assert.ok(sent[2]?.headers.get(PAYMENT_HEADER));

  assert.equal(selection.product.product_id, 'prod_b');
  assert.equal(fulfillment.settlement_id, 'stl_1');
});

test('AgentError identifies itself and carries its context', () => {
  const error = new AgentError('purchase rejected', 409, { reason: 'assertion_reused' });

  assert.equal(error.name, 'AgentError');
  assert.equal(error.message, 'purchase rejected');
  assert.equal(error.status, 409);
  assert.ok(error instanceof Error);
});
