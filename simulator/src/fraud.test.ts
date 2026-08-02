import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AttributionAssertion } from '@agentic-attribution/types';

import { applyFraud, pickFraudMode, EXPECTED_REJECTION, FRAUD_MODES } from './fraud.js';

const genuine: AttributionAssertion = {
  assertion_id: 'a1',
  publisher_id: 'pub_000001',
  product_id: 'prd_00000001',
  search_request_id: 'req_1',
  issued_at: '2026-08-02T12:00:00Z',
  expires_at: '2099-08-02T13:00:00Z',
  commission_bps: 450,
  signature: 'ed25519:originalsignature',
};

test('every mode changes the assertion it is handed', () => {
  for (const mode of FRAUD_MODES) {
    const tampered = applyFraud(genuine, mode);
    assert.notDeepEqual(tampered, genuine, `${mode} produced an identical assertion`);
  }
});

// A mutation applied in place would corrupt the caller's assertion, and the
// runner reuses the genuine one to report what the attempt targeted.
test('applying fraud leaves the original assertion untouched', () => {
  const snapshot = { ...genuine };

  for (const mode of FRAUD_MODES) {
    applyFraud(genuine, mode);
  }

  assert.deepEqual(genuine, snapshot);
});

test('tampering with the publisher redirects the payout and keeps the signature', () => {
  const tampered = applyFraud(genuine, 'tampered_publisher');

  assert.notEqual(tampered.publisher_id, genuine.publisher_id);
  // An empty identifier would get refused for being malformed rather than for
  // being unsigned, which proves a different control than the one on trial.
  assert.match(tampered.publisher_id, /^pub_\d+$/);
  // Leaving the signature alone is the whole point: verification has to fail
  // because a signed field moved, not because the signature looks wrong.
  assert.equal(tampered.signature, genuine.signature);
});

test('tampering with the commission raises the signed rate', () => {
  const tampered = applyFraud(genuine, 'tampered_commission');

  assert.ok(tampered.commission_bps > genuine.commission_bps);
  assert.equal(tampered.signature, genuine.signature);
});

test('the expired mode moves both timestamps into the past', () => {
  const tampered = applyFraud(genuine, 'expired');

  assert.ok(Date.parse(tampered.expires_at) < Date.now());
  assert.ok(Date.parse(tampered.issued_at) < Date.parse(tampered.expires_at));
  assert.notEqual(tampered.expires_at, genuine.expires_at);
});

// The platform mints timestamps to the second. Milliseconds would make a
// forgery distinguishable by shape rather than by signature.
test('backdated timestamps match the format the platform mints', () => {
  const tampered = applyFraud(genuine, 'expired');
  const secondsPrecisionUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  assert.match(tampered.issued_at, secondsPrecisionUtc);
  assert.match(tampered.expires_at, secondsPrecisionUtc);
});

test('the forged signature keeps the scheme prefix so verification runs rather than short-circuits', () => {
  const tampered = applyFraud(genuine, 'forged_signature');

  assert.ok(tampered.signature.startsWith('ed25519:'));
  assert.notEqual(tampered.signature, genuine.signature);
});

// A signature of the wrong length gets refused for being malformed, which is a
// different control than the one this mode exists to exercise.
test('the forged signature carries a full-length base64 body with its padding', () => {
  const tampered = applyFraud(genuine, 'forged_signature');
  const [scheme, body] = tampered.signature.split(':');

  assert.equal(scheme, 'ed25519');
  assert.equal(body?.length, 88);
  assert.ok(body?.endsWith('=='));
  assert.match(body ?? '', /^[A-Za-z0-9+/]{86}==$/);
});

test('the unknown publisher mode changes both the payee and the rate', () => {
  const tampered = applyFraud(genuine, 'unknown_publisher');

  assert.notEqual(tampered.publisher_id, genuine.publisher_id);
  assert.ok(tampered.commission_bps > genuine.commission_bps);
  // Everything the attacker did not touch has to survive, or the platform
  // refuses a malformed assertion rather than a fraudulent one.
  assert.equal(tampered.assertion_id, genuine.assertion_id);
  assert.equal(tampered.product_id, genuine.product_id);
  assert.equal(tampered.search_request_id, genuine.search_request_id);
  assert.equal(tampered.signature, genuine.signature);
});

test('every mode preserves the identifiers it does not attack', () => {
  for (const mode of FRAUD_MODES) {
    const tampered = applyFraud(genuine, mode);

    assert.equal(tampered.assertion_id, genuine.assertion_id, mode);
    assert.equal(tampered.product_id, genuine.product_id, mode);
    assert.equal(tampered.search_request_id, genuine.search_request_id, mode);
  }
});

test('every mode declares the rejection reason it expects', () => {
  for (const mode of FRAUD_MODES) {
    assert.ok(EXPECTED_REJECTION[mode], `${mode} declares no expected rejection`);
  }
});

test('mode selection stays inside the declared set', () => {
  assert.equal(pickFraudMode(() => 0), FRAUD_MODES[0]);
  assert.equal(pickFraudMode(() => 0.999999), FRAUD_MODES[FRAUD_MODES.length - 1]);
});

// Math.random() can return values that round to the array length, which would
// index past the end and hand the runner an undefined mode.
test('a random value at the boundary still yields a mode', () => {
  assert.ok(FRAUD_MODES.includes(pickFraudMode(() => 1)));
});
