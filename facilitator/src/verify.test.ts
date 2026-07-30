import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BASE_SEPOLIA,
  EIP3009_PRIMARY_TYPE,
  EIP3009_TYPES,
  eip712Domain,
  toTypedMessage,
} from '@agentic-attribution/types';
import { privateKeyToAccount } from 'viem/accounts';

import {
  simulatedTransactionHash,
  verifyPayment,
  type WireAuthorization,
  type WirePaymentPayload,
  type WirePaymentRequirements,
} from './verify.js';

// A throwaway key with no funds on any network. It exists so the tests can
// produce genuine EIP-3009 signatures rather than fixtures, which is the only
// way to prove the mock verifies rather than rubber-stamps.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(TEST_PRIVATE_KEY);

const NETWORK = 'base-sepolia';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const VALUE = '129990000';
const NOW = 1_800_000_000n;

function authorization(overrides: Partial<WireAuthorization> = {}): WireAuthorization {
  return {
    from: account.address,
    to: PAY_TO,
    value: VALUE,
    validAfter: String(NOW - 60n),
    validBefore: String(NOW + 600n),
    nonce: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

function requirements(overrides: Partial<WirePaymentRequirements> = {}): WirePaymentRequirements {
  return {
    scheme: 'exact',
    network: NETWORK,
    asset: BASE_SEPOLIA.usdcAddress,
    maxAmountRequired: VALUE,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    resource: '/purchase/prod_1',
    description: 'Test Listing',
    ...overrides,
  };
}

async function signedPayload(auth: WireAuthorization = authorization()): Promise<WirePaymentPayload> {
  const signature = await account.signTypedData({
    domain: eip712Domain(NETWORK),
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message: toTypedMessage(auth),
  });

  return {
    x402Version: 1,
    scheme: 'exact',
    network: NETWORK,
    authorization: auth,
    signature,
  };
}

test('accepts a genuine EIP-3009 signature and recovers the payer', async () => {
  const outcome = await verifyPayment(await signedPayload(), requirements(), NOW);

  assert.equal(outcome.isValid, true);
  assert.equal(outcome.payer?.toLowerCase(), account.address.toLowerCase());
});

// The point of the whole exercise. A mock that skipped this would accept
// payloads the real facilitator rejects, and the divergence would surface only
// against mainnet.
test('rejects a signature from a different key', async () => {
  const other = privateKeyToAccount(
    '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  );

  const auth = authorization();
  const signature = await other.signTypedData({
    domain: eip712Domain(NETWORK),
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message: toTypedMessage(auth),
  });

  const outcome = await verifyPayment(
    { x402Version: 1, scheme: 'exact', network: NETWORK, authorization: auth, signature },
    requirements(),
    NOW,
  );

  assert.equal(outcome.isValid, false);
  assert.equal(outcome.invalidReason, 'invalid_signature');
});

// Every field below sits inside the signed structure, so altering one after
// signing must break recovery. Together these prove the signature covers the
// whole authorization rather than a subset of it.
test('rejects every field tampered with after signing', async () => {
  const cases: Array<[string, Partial<WireAuthorization>]> = [
    ['value', { value: '1' }],
    ['to', { to: '0x9999999999999999999999999999999999999999' }],
    ['from', { from: '0x8888888888888888888888888888888888888888' }],
    ['nonce', { nonce: `0x${'cd'.repeat(32)}` }],
    ['validBefore', { validBefore: String(NOW + 9_999n) }],
    ['validAfter', { validAfter: String(NOW - 9_999n) }],
  ];

  for (const [field, override] of cases) {
    const payload = await signedPayload();
    const tampered = { ...payload, authorization: { ...payload.authorization, ...override } };

    // The amount and payee checks fire before signature recovery, so those two
    // report their specific reason. Either way the payment gets rejected.
    const outcome = await verifyPayment(tampered, requirements(), NOW);

    assert.equal(outcome.isValid, false, `tampering with ${field} should fail`);
  }
});

test('rejects an amount other than exactly the required one', async () => {
  const auth = authorization({ value: String(BigInt(VALUE) + 1n) });
  const outcome = await verifyPayment(await signedPayload(auth), requirements(), NOW);

  assert.equal(outcome.isValid, false);
  assert.equal(outcome.invalidReason, 'insufficient_amount');
});

test('rejects an authorization outside its validity window', async () => {
  const expired = await signedPayload(authorization({ validBefore: String(NOW - 1n) }));
  assert.equal((await verifyPayment(expired, requirements(), NOW)).invalidReason, 'authorization_expired');

  const early = await signedPayload(authorization({ validAfter: String(NOW + 60n) }));
  assert.equal(
    (await verifyPayment(early, requirements(), NOW)).invalidReason,
    'authorization_not_yet_valid',
  );
});

test('rejects a payee the merchant did not name', async () => {
  const misdirected = await signedPayload(
    authorization({ to: '0x9999999999999999999999999999999999999999' }),
  );

  const outcome = await verifyPayment(misdirected, requirements(), NOW);

  assert.equal(outcome.isValid, false);
  assert.equal(outcome.invalidReason, 'payee_mismatch');
});

test('rejects a scheme other than exact', async () => {
  const payload = await signedPayload();

  assert.equal(
    (await verifyPayment({ ...payload, scheme: 'upto' }, requirements(), NOW)).invalidReason,
    'unsupported_scheme',
  );
});

test('rejects a network the payload and requirements disagree on', async () => {
  const payload = await signedPayload();

  assert.equal(
    (await verifyPayment(payload, requirements({ network: 'base' }), NOW)).invalidReason,
    'network_mismatch',
  );
});

test('rejects an asset that is not the domain the signature commits to', async () => {
  const payload = await signedPayload();

  assert.equal(
    (
      await verifyPayment(
        payload,
        requirements({ asset: '0x0000000000000000000000000000000000000001' }),
        NOW,
      )
    ).invalidReason,
    'asset_mismatch',
  );
});

test('malformed payloads are rejected without throwing', async () => {
  const payload = await signedPayload();

  const outcome = await verifyPayment(
    { ...payload, authorization: { ...payload.authorization, value: 'not-a-number' } },
    requirements(),
    NOW,
  );

  assert.equal(outcome.isValid, false);
  assert.equal(outcome.invalidReason, 'malformed_payload');
});

// Determinism makes the nonce's single-use property visible: the same
// authorization always produces the same hash, exactly as a replayed on-chain
// transfer would collide rather than produce a second transaction.
test('the simulated transaction hash is deterministic per authorization', () => {
  const auth = authorization();

  assert.equal(simulatedTransactionHash(auth), simulatedTransactionHash(auth));
  assert.notEqual(
    simulatedTransactionHash(auth),
    simulatedTransactionHash(authorization({ nonce: `0x${'ef'.repeat(32)}` })),
  );
  assert.match(simulatedTransactionHash(auth), /^0x[0-9a-f]{64}$/);
});
