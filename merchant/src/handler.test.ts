import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { importVerificationKey, type AttributionAssertion } from '@agentic-attribution/types';

import type { Catalog, Listing } from './catalog.js';
import { centsToAtomicUnits, type MerchantConfig } from './config.js';
import { HTTP_STATUS, PurchaseHandler, type Fulfillment } from './handler.js';
import type { SettlementClient, SettlementOutcome, SettlementRequest } from './settlement.js';
import {
  X402_HEADER,
  encodeHeaderJson,
  type PaymentPayload,
  type PaymentRequiredBody,
} from './x402.js';

interface Fixture {
  public_key: string;
  verify_at: string;
  expired_at: string;
  assertion: AttributionAssertion;
}

// The same fixture the types package verifies, so the merchant is exercised
// against an assertion Go actually signed rather than one built in TypeScript
// to match TypeScript's own expectations.
const fixture: Fixture = JSON.parse(
  readFileSync(
    new URL('../../packages/types/src/__fixtures__/go-minted-assertion.json', import.meta.url),
    'utf8',
  ),
);

const PAY_TO = '0x1111111111111111111111111111111111111111';
const PRICE_CENTS = 12_999;

const LISTING_MERCHANT = 'mer_000042';

const config: MerchantConfig = {
  merchantId: '',
  port: 8090,
  postgresDsn: 'unused',
  settlementUrl: 'unused',
  publicKey: fixture.public_key,
  payToAddress: PAY_TO,
  assetAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  network: 'base-sepolia',
};

const listing: Listing = {
  listingId: 'lst_1',
  productId: fixture.assertion.product_id,
  merchantId: LISTING_MERCHANT,
  listingTitle: 'Test Listing',
  priceCents: PRICE_CENTS,
  currency: 'USD',
  inStock: true,
};

function fakeCatalog(result: Listing | null): Catalog {
  return { findListing: async () => result, close: async () => {} } as unknown as Catalog;
}

function fakeSettlement(
  outcome: SettlementOutcome,
  captured?: { request?: SettlementRequest },
): SettlementClient {
  return {
    settle: async (request: SettlementRequest) => {
      if (captured) {
        captured.request = request;
      }
      return outcome;
    },
  } as unknown as SettlementClient;
}

const confirmedOutcome: SettlementOutcome = {
  ok: true,
  result: {
    settlement_id: 'stl_1',
    status: 'confirmed',
    tx_hash: '0xdeadbeef',
    network: 'base-sepolia',
    payer: '0x2222222222222222222222222222222222222222',
    commission_bps: 450,
    commission_amount_cents: 584,
    platform_fee_cents: 175,
    publisher_amount_cents: 409,
  },
};

function payment(overrides: Partial<PaymentPayload['authorization']> = {}): PaymentPayload {
  return {
    x402Version: 1,
    scheme: 'exact',
    network: 'base-sepolia',
    authorization: {
      from: '0x2222222222222222222222222222222222222222',
      to: PAY_TO,
      value: centsToAtomicUnits(PRICE_CENTS),
      validAfter: '0',
      validBefore: '99999999999',
      nonce: '0xabc',
      ...overrides,
    },
    signature: '0xsig',
  };
}

function paidHeaders(
  assertion: AttributionAssertion = fixture.assertion,
  payload: PaymentPayload = payment(),
): Record<string, string> {
  return {
    [X402_HEADER.PaymentSignature]: encodeHeaderJson(payload),
    [X402_HEADER.AttributionAssertion]: encodeHeaderJson(assertion),
  };
}

const key = await importVerificationKey(fixture.public_key);
const at = new Date(fixture.verify_at);

function handlerWith(
  catalog: Catalog,
  settlement: SettlementClient = fakeSettlement(confirmedOutcome),
): PurchaseHandler {
  return new PurchaseHandler(config, catalog, settlement, key);
}

test('a request without payment returns a 402 carrying the requirements', async () => {
  const response = await handlerWith(fakeCatalog(listing)).handle(
    { product_id: listing.productId },
    {},
    at,
  );

  assert.equal(response.status, HTTP_STATUS.PaymentRequired);

  const body = response.body as PaymentRequiredBody;
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts.length, 1);

  const requirements = body.accepts[0];
  assert.ok(requirements);
  assert.equal(requirements.scheme, 'exact');
  assert.equal(requirements.payTo, PAY_TO);
  assert.equal(requirements.maxAmountRequired, centsToAtomicUnits(PRICE_CENTS));
  assert.ok(response.headers?.[X402_HEADER.PaymentRequired]);
});

// The conversion is a factor of ten thousand, and getting it wrong would still
// settle, just for the wrong amount.
test('prices convert from cents to USDC atomic units', () => {
  assert.equal(centsToAtomicUnits(1), '10000');
  assert.equal(centsToAtomicUnits(100), '1000000');
  assert.equal(centsToAtomicUnits(12_999), '129990000');
  assert.equal(centsToAtomicUnits(0), '0');
  assert.throws(() => centsToAtomicUnits(1.5));
  assert.throws(() => centsToAtomicUnits(-1));
});

test('a paid request settles and returns fulfillment naming the publisher', async () => {
  const captured: { request?: SettlementRequest } = {};
  const handler = handlerWith(fakeCatalog(listing), fakeSettlement(confirmedOutcome, captured));

  const response = await handler.handle({ product_id: listing.productId }, paidHeaders(), at);

  assert.equal(response.status, HTTP_STATUS.Ok);

  const fulfillment = response.body as Fulfillment;
  assert.equal(fulfillment.attributed_publisher_id, fixture.assertion.publisher_id);
  assert.equal(fulfillment.publisher_commission_cents, 409);
  assert.equal(fulfillment.tx_hash, '0xdeadbeef');
  assert.ok(response.headers?.[X402_HEADER.PaymentResponse]);

  // The merchant reports the price it holds, never the amount the buyer named.
  assert.equal(captured.request?.gross_amount_cents, PRICE_CENTS);
  // The listing decides which merchant made the sale, not the service's own
  // configuration. Reporting the configured identifier would credit revenue to
  // whichever merchant the process happened to name, and with MERCHANT_ID
  // unset it would report nothing at all.
  assert.equal(captured.request?.merchant_id, LISTING_MERCHANT);
});

test('an unknown product returns 404 before any payment work', async () => {
  const response = await handlerWith(fakeCatalog(null)).handle({ product_id: 'nope' }, {}, at);

  assert.equal(response.status, HTTP_STATUS.NotFound);
});

test('an out of stock listing never issues a challenge', async () => {
  const response = await handlerWith(fakeCatalog({ ...listing, inStock: false })).handle(
    { product_id: listing.productId },
    {},
    at,
  );

  assert.equal(response.status, HTTP_STATUS.Unprocessable);
});

test('payment without an assertion is rejected', async () => {
  const response = await handlerWith(fakeCatalog(listing)).handle(
    { product_id: listing.productId },
    { [X402_HEADER.PaymentSignature]: encodeHeaderJson(payment()) },
    at,
  );

  assert.equal(response.status, HTTP_STATUS.BadRequest);
  assert.equal((response.body as { reason: string }).reason, 'assertion_missing');
});

test('an expired assertion is rejected before settlement is called', async () => {
  const settlement = fakeSettlement(confirmedOutcome);
  let called = false;
  const watched = {
    settle: async (request: SettlementRequest) => {
      called = true;
      return settlement.settle(request);
    },
  } as unknown as SettlementClient;

  const response = await handlerWith(fakeCatalog(listing), watched).handle(
    { product_id: listing.productId },
    paidHeaders(),
    new Date(fixture.expired_at),
  );

  assert.equal(response.status, HTTP_STATUS.Unauthorized);
  assert.equal((response.body as { reason: string }).reason, 'expired');
  assert.equal(called, false, 'settlement should never see an expired assertion');
});

test('a tampered assertion is rejected', async () => {
  const forged = { ...fixture.assertion, commission_bps: 9_999 };

  const response = await handlerWith(fakeCatalog(listing)).handle(
    { product_id: listing.productId },
    paidHeaders(forged),
    at,
  );

  assert.equal(response.status, HTTP_STATUS.Unauthorized);
  assert.equal((response.body as { reason: string }).reason, 'invalid_signature');
});

// A valid assertion for a different product must not attach to this purchase.
// Signature verification alone would pass, since nothing about the assertion
// was altered.
test('an assertion minted for another product is rejected', async () => {
  const otherProduct: Listing = { ...listing, productId: 'prod_something_else' };

  const response = await handlerWith(fakeCatalog(otherProduct)).handle(
    { product_id: otherProduct.productId },
    paidHeaders(),
    at,
  );

  assert.equal(response.status, HTTP_STATUS.Unprocessable);
  assert.equal((response.body as { reason: string }).reason, 'assertion_product_mismatch');
});

test('an authorization for the wrong amount is rejected', async () => {
  const underpaying = payment({ value: centsToAtomicUnits(1) });

  const response = await handlerWith(fakeCatalog(listing)).handle(
    { product_id: listing.productId },
    paidHeaders(fixture.assertion, underpaying),
    at,
  );

  assert.equal(response.status, HTTP_STATUS.Unprocessable);
  assert.equal((response.body as { reason: string }).reason, 'amount_mismatch');
});

test('an authorization paying a different address is rejected', async () => {
  const misdirected = payment({ to: '0x9999999999999999999999999999999999999999' });

  const response = await handlerWith(fakeCatalog(listing)).handle(
    { product_id: listing.productId },
    paidHeaders(fixture.assertion, misdirected),
    at,
  );

  assert.equal(response.status, HTTP_STATUS.Unprocessable);
  assert.equal((response.body as { reason: string }).reason, 'payee_mismatch');
});

// The settlement service owns replay detection, so the merchant passes its
// verdict through rather than re-deriving one and risking disagreement.
test('a replayed assertion surfaces the settlement service 409', async () => {
  const replayed: SettlementOutcome = {
    ok: false,
    status: HTTP_STATUS.Conflict,
    rejection: { error: 'assertion already consumed', reason: 'assertion_reused' },
  };

  const response = await handlerWith(fakeCatalog(listing), fakeSettlement(replayed)).handle(
    { product_id: listing.productId },
    paidHeaders(),
    at,
  );

  assert.equal(response.status, HTTP_STATUS.Conflict);
  assert.equal((response.body as { reason: string }).reason, 'assertion_reused');
});

test('malformed headers are rejected without throwing', async () => {
  const response = await handlerWith(fakeCatalog(listing)).handle(
    { product_id: listing.productId },
    {
      [X402_HEADER.PaymentSignature]: 'not-base64-json',
      [X402_HEADER.AttributionAssertion]: 'also-not',
    },
    at,
  );

  assert.equal(response.status, HTTP_STATUS.BadRequest);
  assert.equal((response.body as { reason: string }).reason, 'malformed_headers');
});
