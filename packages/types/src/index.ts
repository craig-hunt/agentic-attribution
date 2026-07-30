export const ASSERTION_TTL_SECONDS = 3600;

export const BASIS_POINTS_DIVISOR = 10_000;

export const PLATFORM_FEE_SHARE_BPS = 3000;

export const SIGNATURE_PREFIX = 'ed25519:';

export interface AttributionAssertion {
  assertion_id: string;
  publisher_id: string;
  product_id: string;
  search_request_id: string;
  issued_at: string;
  expires_at: string;
  commission_bps: number;
  signature: string;
}

export type UnsignedAssertion = Omit<AttributionAssertion, 'signature'>;

export interface MerchantOffer {
  listing_id: string;
  merchant_id: string;
  price_cents: number;
  in_stock: boolean;
  commission_bps: number;
  deep_link_url: string;
}

export interface ProductResult {
  product_id: string;
  canonical_title: string;
  brand: string;
  category_id: string;
  score: number;
  min_price_cents: number;
  max_commission_bps: number;
  offers: MerchantOffer[];
}

export interface SearchResponse {
  search_request_id: string;
  query: string;
  latency_ms: number;
  results: ProductResult[];
  assertions: AttributionAssertion[];
}

export const X402_HEADERS = {
  PaymentRequired: 'PAYMENT-REQUIRED',
  PaymentSignature: 'PAYMENT-SIGNATURE',
  PaymentResponse: 'PAYMENT-RESPONSE',
  AttributionAssertion: 'X-ATTRIBUTION-ASSERTION',
} as const;

export const X402_SCHEME = 'exact';

export interface PaymentRequirements {
  scheme: typeof X402_SCHEME;
  network: string;
  asset: string;
  amount: string;
  pay_to: string;
  max_timeout_seconds: number;
  resource: string;
  description: string;
}

export interface PaymentRequired {
  x402_version: number;
  accepts: PaymentRequirements[];
}

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  valid_after: string;
  valid_before: string;
  nonce: string;
}

export interface PaymentPayload {
  x402_version: number;
  scheme: typeof X402_SCHEME;
  network: string;
  authorization: Eip3009Authorization;
  signature: string;
}

export interface PaymentSettled {
  success: boolean;
  tx_hash: string;
  network: string;
  payer: string;
}

export interface CommissionSplit {
  commission_amount_cents: number;
  platform_fee_cents: number;
  publisher_amount_cents: number;
}

export function calculateCommission(
  grossAmountCents: number,
  commissionBps: number
): CommissionSplit {
  const commission = Math.floor((grossAmountCents * commissionBps) / BASIS_POINTS_DIVISOR);
  const platformFee = Math.floor((commission * PLATFORM_FEE_SHARE_BPS) / BASIS_POINTS_DIVISOR);

  return {
    commission_amount_cents: commission,
    platform_fee_cents: platformFee,
    publisher_amount_cents: commission - platformFee,
  };
}

export function isExpired(assertion: AttributionAssertion, now: Date = new Date()): boolean {
  return new Date(assertion.expires_at).getTime() <= now.getTime();
}

export function canonicalizeForSigning(assertion: UnsignedAssertion): string {
  const ordered: UnsignedAssertion = {
    assertion_id: assertion.assertion_id,
    publisher_id: assertion.publisher_id,
    product_id: assertion.product_id,
    search_request_id: assertion.search_request_id,
    issued_at: assertion.issued_at,
    expires_at: assertion.expires_at,
    commission_bps: assertion.commission_bps,
  };

  return JSON.stringify(ordered);
}

export {
  AssertionVerificationError,
  importVerificationKey,
  verifyAssertion,
  type VerificationFailure,
} from './verify.js';

export {
  BASE_SEPOLIA,
  EIP3009_PRIMARY_TYPE,
  EIP3009_TYPES,
  NETWORKS,
  eip712Domain,
  networkParameters,
  toTypedMessage,
  type Eip3009Message,
  type Eip712Domain,
  type NetworkParameters,
} from './eip3009.js';
