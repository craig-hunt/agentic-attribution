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
    publisher_id: 'pub_0001',
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
