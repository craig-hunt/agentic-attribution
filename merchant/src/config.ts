// USDC carries 6 decimals, so one atomic unit is a millionth of a dollar and
// one cent is ten thousand of them. Prices live in the catalog as integer
// cents; x402 wants atomic units as a decimal string. Getting this wrong by a
// factor of ten thousand would still settle, which is exactly why it sits in a
// named constant with a test rather than inline in a template literal.
export const ATOMIC_UNITS_PER_CENT = 10_000n;

export const X402_VERSION = 1;
export const SCHEME_EXACT = 'exact';

// Base Sepolia USDC. Testnet only, per ADR-0004.
const DEFAULT_USDC_ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DEFAULT_NETWORK = 'base-sepolia';
const DEFAULT_SETTLEMENT_URL = 'http://localhost:8082';
const DEFAULT_POSTGRES_DSN =
  'postgres://agentic:agentic@localhost:5432/agentic?sslmode=disable';
const DEFAULT_PORT = 8090;
// Empty means the service sells whatever the catalog offers rather than
// pinning one seller. The generated catalog names merchants mer_000000
// upward, so any hard-coded default would name a merchant that never exists.
const DEFAULT_MERCHANT_ID = '';

// A merchant holds the payment window open only long enough for an agent to
// sign and return. Longer windows widen the period during which a signed
// authorization sits replayable in transit.
export const PAYMENT_TIMEOUT_SECONDS = 120;

export interface MerchantConfig {
  merchantId: string;
  port: number;
  postgresDsn: string;
  settlementUrl: string;
  publicKey: string;
  payToAddress: string;
  assetAddress: string;
  network: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} not set. See docs/RUNNING.md for the local environment.`);
  }

  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function loadConfig(): MerchantConfig {
  return {
    merchantId: optional('MERCHANT_ID', DEFAULT_MERCHANT_ID),
    port: Number(optional('MERCHANT_PORT', String(DEFAULT_PORT))),
    postgresDsn: optional('POSTGRES_DSN', DEFAULT_POSTGRES_DSN),
    settlementUrl: optional('SETTLEMENT_URL', DEFAULT_SETTLEMENT_URL),
    // The merchant verifies assertions and never mints them, so it holds only
    // the public half. Nothing it can read lets it forge attribution.
    publicKey: required('ATTRIBUTION_PUBLIC_KEY'),
    payToAddress: required('MERCHANT_PAY_TO_ADDRESS'),
    assetAddress: optional('USDC_ASSET_ADDRESS', DEFAULT_USDC_ASSET),
    network: optional('CHAIN_NETWORK', DEFAULT_NETWORK),
  };
}

export function centsToAtomicUnits(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`price must be a non-negative integer number of cents, got ${cents}`);
  }

  return (BigInt(cents) * ATOMIC_UNITS_PER_CENT).toString();
}
