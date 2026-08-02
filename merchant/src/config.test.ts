import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  ATOMIC_UNITS_PER_CENT,
  PAYMENT_TIMEOUT_SECONDS,
  SCHEME_EXACT,
  X402_VERSION,
  centsToAtomicUnits,
  loadConfig,
} from './config.js';

const REQUIRED = ['ATTRIBUTION_PUBLIC_KEY', 'MERCHANT_PAY_TO_ADDRESS'] as const;

const OPTIONAL = [
  'MERCHANT_ID',
  'MERCHANT_PORT',
  'POSTGRES_DSN',
  'SETTLEMENT_URL',
  'USDC_ASSET_ADDRESS',
  'CHAIN_NETWORK',
] as const;

const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) {
      saved.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  saved.clear();
});

function clearAll(): void {
  setEnv(Object.fromEntries([...REQUIRED, ...OPTIONAL].map((k) => [k, undefined])));
}

function withRequired(extra: Record<string, string | undefined> = {}): void {
  clearAll();
  setEnv({
    ATTRIBUTION_PUBLIC_KEY: 'cHVibGljLWtleQ==',
    MERCHANT_PAY_TO_ADDRESS: '0x1111111111111111111111111111111111111111',
    ...extra,
  });
}

// One cent is ten thousand atomic units at USDC's six decimals. Getting this
// wrong by that factor still settles, just for the wrong amount, which is why
// it lives behind a named constant rather than inline in a template literal.
test('cents convert to USDC atomic units', () => {
  assert.equal(ATOMIC_UNITS_PER_CENT, 10_000n);

  assert.equal(centsToAtomicUnits(0), '0');
  assert.equal(centsToAtomicUnits(1), '10000');
  assert.equal(centsToAtomicUnits(100), '1000000');
  assert.equal(centsToAtomicUnits(12_999), '129990000');

  // Beyond Number.MAX_SAFE_INTEGER once multiplied, so the arithmetic has to
  // stay in BigInt rather than dropping to a double.
  assert.equal(centsToAtomicUnits(1_000_000_000_000), '10000000000000000');
});

test('a non-integer or negative price is refused', () => {
  for (const bad of [1.5, -1, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => centsToAtomicUnits(bad),
      (error: unknown) => error instanceof Error && error.message.includes(String(bad)),
      `${bad} should be refused and named in the message`,
    );
  }
});

test('the x402 protocol constants are fixed', () => {
  assert.equal(X402_VERSION, 1);
  assert.equal(SCHEME_EXACT, 'exact');

  // A longer window widens the period in which a signed authorization sits
  // replayable in transit.
  assert.equal(PAYMENT_TIMEOUT_SECONDS, 120);
});

test('loadConfig fills every default when only the required variables are set', () => {
  withRequired();

  const config = loadConfig();

  assert.equal(config.merchantId, '');
  assert.equal(config.port, 8090);
  assert.equal(config.network, 'base-sepolia');
  assert.equal(config.settlementUrl, 'http://localhost:8082');
  assert.equal(config.assetAddress, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  assert.ok(config.postgresDsn.startsWith('postgres://'));
  assert.equal(config.payToAddress, '0x1111111111111111111111111111111111111111');
});

test('every optional variable overrides its default', () => {
  withRequired({
    MERCHANT_ID: 'merch_9999',
    MERCHANT_PORT: '9999',
    POSTGRES_DSN: 'postgres://elsewhere/db',
    SETTLEMENT_URL: 'http://settlement.internal:1234',
    USDC_ASSET_ADDRESS: '0x2222222222222222222222222222222222222222',
    CHAIN_NETWORK: 'base',
  });

  const config = loadConfig();

  assert.equal(config.merchantId, 'merch_9999');
  assert.equal(config.port, 9999);
  assert.equal(config.postgresDsn, 'postgres://elsewhere/db');
  assert.equal(config.settlementUrl, 'http://settlement.internal:1234');
  assert.equal(config.assetAddress, '0x2222222222222222222222222222222222222222');
  assert.equal(config.network, 'base');
});

// Whitespace survives a copy out of a terminal or a compose file far too
// easily, and a padded key fails base64 decoding with an error that says
// nothing about its cause.
test('surrounding whitespace is trimmed from every variable', () => {
  withRequired({
    ATTRIBUTION_PUBLIC_KEY: '  cHVibGljLWtleQ==\n',
    MERCHANT_ID: '\tmerch_0007  ',
    CHAIN_NETWORK: ' base-sepolia ',
  });

  const config = loadConfig();

  assert.equal(config.publicKey, 'cHVibGljLWtleQ==');
  assert.equal(config.merchantId, 'merch_0007');
  assert.equal(config.network, 'base-sepolia');
});

// An empty variable is absent rather than a valid empty value. Treating "" as
// set would start the merchant with no payee and fail at the first purchase.
test('an empty optional variable falls back to its default', () => {
  withRequired({ MERCHANT_ID: '', CHAIN_NETWORK: '   ' });

  const config = loadConfig();

  assert.equal(config.merchantId, '');
  assert.equal(config.network, 'base-sepolia');
});

test('a missing required variable names itself and points at the runbook', () => {
  for (const missing of REQUIRED) {
    withRequired({ [missing]: undefined });

    assert.throws(
      () => loadConfig(),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(missing) &&
        error.message.includes('RUNNING.md'),
      `${missing} should name itself and the documentation`,
    );
  }
});

test('an empty required variable is treated as missing', () => {
  withRequired({ MERCHANT_PAY_TO_ADDRESS: '   ' });

  assert.throws(() => loadConfig(), /MERCHANT_PAY_TO_ADDRESS/);
});
