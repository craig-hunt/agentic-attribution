import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  AssertionVerificationError,
  calculateCommission,
  canonicalizeForSigning,
  importVerificationKey,
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
