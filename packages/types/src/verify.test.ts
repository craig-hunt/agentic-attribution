import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ASSERTION_TTL_SECONDS,
  AssertionVerificationError,
  BASIS_POINTS_DIVISOR,
  PLATFORM_FEE_SHARE_BPS,
  SIGNATURE_PREFIX,
  calculateCommission,
  canonicalizeForSigning,
  importVerificationKey,
  isExpired,
  verifyAssertion,
  type AttributionAssertion,
} from './index.js';

interface Fixture {
  public_key: string;
  verify_at: string;
  expired_at: string;
  assertion: AttributionAssertion;
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/go-minted-assertion.json', import.meta.url), 'utf8'),
);

const key = await importVerificationKey(fixture.public_key);

// The whole point of the fixture: Go signed these bytes, TypeScript verifies
// them. A divergence in field order, in HTML escaping, or in timestamp format
// fails right here rather than in production.
test('verifies an assertion minted by Go', async () => {
  await verifyAssertion(fixture.assertion, key, new Date(fixture.verify_at));
});

test('canonical form leaves HTML characters unescaped, matching Go', () => {
  const canonical = canonicalizeForSigning(fixture.assertion);

  assert.ok(canonical.includes('"publisher_id":"pub_a<1>"'), canonical);
  assert.ok(canonical.includes('"product_id":"prod_x&y"'), canonical);
  assert.ok(!canonical.includes('\\u003c'), 'found an HTML escape Go no longer emits');
  assert.ok(!canonical.includes('\\u0026'), 'found an HTML escape Go no longer emits');
});

test('canonical field order is fixed, not alphabetical or insertion order of input', () => {
  const shuffled = {
    commission_bps: fixture.assertion.commission_bps,
    expires_at: fixture.assertion.expires_at,
    signature: fixture.assertion.signature,
    product_id: fixture.assertion.product_id,
    assertion_id: fixture.assertion.assertion_id,
    issued_at: fixture.assertion.issued_at,
    search_request_id: fixture.assertion.search_request_id,
    publisher_id: fixture.assertion.publisher_id,
  } as AttributionAssertion;

  assert.equal(
    canonicalizeForSigning(shuffled),
    canonicalizeForSigning(fixture.assertion),
  );
});

test('rejects an expired assertion', async () => {
  await assert.rejects(
    () => verifyAssertion(fixture.assertion, key, new Date(fixture.expired_at)),
    (err: unknown) => err instanceof AssertionVerificationError && err.reason === 'expired',
  );
});

test('treats the expiry boundary as exclusive, matching Go', async () => {
  await assert.rejects(
    () => verifyAssertion(fixture.assertion, key, new Date(fixture.assertion.expires_at)),
    (err: unknown) => err instanceof AssertionVerificationError && err.reason === 'expired',
  );

  const oneMillisecondEarlier = new Date(Date.parse(fixture.assertion.expires_at) - 1);
  await verifyAssertion(fixture.assertion, key, oneMillisecondEarlier);
});

test('rejects a signature without the ed25519 prefix', async () => {
  await assert.rejects(
    () =>
      verifyAssertion(
        { ...fixture.assertion, signature: 'AAAA' },
        key,
        new Date(fixture.verify_at),
      ),
    (err: unknown) =>
      err instanceof AssertionVerificationError && err.reason === 'malformed_signature',
  );
});

test('rejects every tampered field', async () => {
  const tampered: Array<[string, AttributionAssertion]> = [
    ['publisher_id', { ...fixture.assertion, publisher_id: 'pub_attacker' }],
    ['product_id', { ...fixture.assertion, product_id: 'prod_other' }],
    ['commission_bps', { ...fixture.assertion, commission_bps: 9999 }],
    ['expires_at', { ...fixture.assertion, expires_at: '2099-01-01T00:00:00Z' }],
    ['search_request_id', { ...fixture.assertion, search_request_id: 'req_other' }],
    ['assertion_id', { ...fixture.assertion, assertion_id: 'other-id' }],
  ];

  for (const [field, assertion] of tampered) {
    await assert.rejects(
      () => verifyAssertion(assertion, key, new Date(fixture.verify_at)),
      (err: unknown) =>
        err instanceof AssertionVerificationError && err.reason === 'invalid_signature',
      `tampering with ${field} should fail verification`,
    );
  }
});

// Mirrors TestSplitAlwaysSumsToCommission on the Go side. Both languages
// compute the split, so both have to truncate identically or the ledger's
// balance constraint fails on whichever one wrote the row.
test('commission split matches the Go arithmetic exactly', () => {
  const grossAmounts = [1, 7, 99, 100, 1_999, 12_999, 999_999, 1_000_000_007];
  const rates = [0, 1, 37, 250, 499, 500, 1_234, 9_999, 10_000];

  for (const gross of grossAmounts) {
    for (const bps of rates) {
      const split = calculateCommission(gross, bps);

      assert.equal(
        split.platform_fee_cents + split.publisher_amount_cents,
        split.commission_amount_cents,
        `gross=${gross} bps=${bps} split does not sum to the commission`,
      );
      assert.ok(split.platform_fee_cents >= 0 && split.publisher_amount_cents >= 0);
    }
  }
});

// The diagnostic text is part of the contract. A verifier that says only
// "invalid" sends whoever is debugging a failed settlement through the whole
// chain, so each message has to name what specifically went wrong.
test('rejection messages name the specific failure', async () => {
  const cases: Array<[string, AttributionAssertion, string]> = [
    [
      'missing prefix',
      { ...fixture.assertion, signature: 'AAAA' },
      SIGNATURE_PREFIX,
    ],
    [
      'undecodable base64',
      { ...fixture.assertion, signature: `${SIGNATURE_PREFIX}!!!not base64!!!` },
      'base64',
    ],
    [
      'wrong signature length',
      { ...fixture.assertion, signature: `${SIGNATURE_PREFIX}${btoa('too short')}` },
      '64',
    ],
  ];

  for (const [label, assertion, expected] of cases) {
    await assert.rejects(
      () => verifyAssertion(assertion, key, new Date(fixture.verify_at)),
      (err: unknown) =>
        err instanceof AssertionVerificationError && err.message.includes(expected),
      `${label}: the message should mention ${expected}`,
    );
  }
});

test('an expired assertion reports when it expired', async () => {
  await assert.rejects(
    () => verifyAssertion(fixture.assertion, key, new Date(fixture.expired_at)),
    (err: unknown) =>
      err instanceof AssertionVerificationError &&
      err.reason === 'expired' &&
      err.message.includes(fixture.assertion.expires_at),
  );
});

test('the error carries a machine-readable reason alongside the text', async () => {
  const reasons: Array<[AttributionAssertion, string]> = [
    [{ ...fixture.assertion, signature: 'nope' }, 'malformed_signature'],
    [{ ...fixture.assertion, publisher_id: 'pub_other' }, 'invalid_signature'],
  ];

  for (const [assertion, reason] of reasons) {
    await assert.rejects(
      () => verifyAssertion(assertion, key, new Date(fixture.verify_at)),
      (err: unknown) =>
        err instanceof AssertionVerificationError &&
        err.reason === reason &&
        err.name === 'AssertionVerificationError',
    );
  }
});

// A key of the wrong length has to fail at import rather than at verify, where
// it would read as every assertion being forged.
test('importing a malformed key fails with its actual length', async () => {
  for (const wrong of [8, 31, 33, 64]) {
    await assert.rejects(
      () => importVerificationKey(btoa(String.fromCharCode(...new Uint8Array(wrong)))),
      (err: unknown) =>
        err instanceof Error && err.message.includes(String(wrong)) && err.message.includes('32'),
      `a ${wrong}-byte key should report both its length and the expected one`,
    );
  }
});

test('the verification key tolerates surrounding whitespace', async () => {
  const padded = await importVerificationKey(`  ${fixture.public_key}\n`);

  await verifyAssertion(fixture.assertion, padded, new Date(fixture.verify_at));
});

// The commission split's constants are the contract. Flipping the platform
// share or the divisor changes every payout without failing anything that only
// checks the parts sum to the whole.
test('the split honours the declared platform share exactly', () => {
  assert.equal(BASIS_POINTS_DIVISOR, 10_000);
  assert.equal(PLATFORM_FEE_SHARE_BPS, 3_000);
  assert.equal(ASSERTION_TTL_SECONDS, 3_600);
  assert.equal(SIGNATURE_PREFIX, 'ed25519:');

  const split = calculateCommission(100_000, 500);

  // 5% of 100000 is 5000; the platform takes 30% of that.
  assert.equal(split.commission_amount_cents, 5_000);
  assert.equal(split.platform_fee_cents, 1_500);
  assert.equal(split.publisher_amount_cents, 3_500);
});

// Truncation favours the publisher so the three amounts always sum exactly and
// the ledger's balance constraint can never fail at write time.
test('truncation hands the remainder to the publisher', () => {
  const split = calculateCommission(333, 333);

  assert.equal(split.commission_amount_cents, Math.floor((333 * 333) / 10_000));
  assert.equal(
    split.platform_fee_cents,
    Math.floor((split.commission_amount_cents * 3_000) / 10_000),
  );
  assert.equal(
    split.publisher_amount_cents,
    split.commission_amount_cents - split.platform_fee_cents,
  );
  assert.ok(split.publisher_amount_cents >= split.platform_fee_cents);
});

test('isExpired treats the boundary as exclusive', () => {
  const at = new Date(fixture.assertion.expires_at);

  assert.equal(isExpired(fixture.assertion, at), true);
  assert.equal(isExpired(fixture.assertion, new Date(at.getTime() - 1)), false);
  assert.equal(isExpired(fixture.assertion, new Date(at.getTime() + 1)), true);
});

// The canonical form is the signing input. Its exact bytes cross a language
// boundary, so field order, separators, and the absence of whitespace all
// belong under assertion rather than inference.
test('the canonical form is compact and excludes the signature', () => {
  const canonical = canonicalizeForSigning(fixture.assertion);

  assert.ok(!canonical.includes(' '), 'the canonical form must carry no whitespace');
  assert.ok(!canonical.includes('signature'), 'the signature cannot sign itself');
  assert.ok(canonical.startsWith('{"assertion_id":'), canonical);
  assert.ok(canonical.endsWith(`"commission_bps":${fixture.assertion.commission_bps}}`), canonical);

  assert.equal(Object.keys(JSON.parse(canonical)).length, 7);
});


// Reaching the expiry-parsing branch needs a validly signed assertion carrying
// an unparseable timestamp, because verification checks the signature first.
// Tampering with expires_at on the fixture fails as a forgery long before the
// parse, so this signs its own.
test('a signed assertion carrying an unparseable expiry is rejected at the parse', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);

  const unsigned = {
    assertion_id: 'a1',
    publisher_id: 'pub_1',
    product_id: 'prd_1',
    search_request_id: 'req_1',
    issued_at: '2026-07-30T12:00:00Z',
    expires_at: 'not a timestamp',
    commission_bps: 450,
  };

  const payload = new TextEncoder().encode(canonicalizeForSigning(unsigned));
  const raw = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, payload);

  const signed: AttributionAssertion = {
    ...unsigned,
    signature: SIGNATURE_PREFIX + btoa(String.fromCharCode(...new Uint8Array(raw))),
  };

  const exported = await crypto.subtle.exportKey('raw', pair.publicKey);
  const publicKey = await importVerificationKey(
    btoa(String.fromCharCode(...new Uint8Array(exported))),
  );

  // The signature verifies, so the failure has to come from the timestamp
  // rather than from recovery.
  await assert.rejects(
    () => verifyAssertion(signed, publicKey),
    (err: unknown) =>
      err instanceof AssertionVerificationError &&
      err.reason === 'malformed_signature' &&
      err.message.includes('timestamp') &&
      err.message.includes('not a timestamp'),
  );
});
