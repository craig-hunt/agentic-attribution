// Shapes the platform answers with. Declared here rather than imported from
// packages/types, because a suite that shares its types with the code under
// test stops noticing when that code changes shape.

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

export interface MerchantOffer {
  listing_id: string;
  merchant_id: string;
  listing_title: string;
  price_cents: number;
  in_stock: boolean;
  commission_bps: number;
  deep_link_url: string;
}

export interface ProductResult {
  product_id: string;
  canonical_title: string;
  offers: MerchantOffer[];
}

export interface SearchResponse {
  search_request_id: string;
  query_text?: string;
  latency_ms?: number;
  opensearch_took_ms?: number;
  products: ProductResult[];
  assertions: AttributionAssertion[];
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
}

export interface PaymentRequiredBody {
  x402Version: number;
  accepts: PaymentRequirements[];
}

export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402Payment {
  x402Version: number;
  scheme: string;
  network: string;
  authorization: X402Authorization;
  signature: string;
}

export interface RejectionBody {
  error?: string;
  reason?: string;
}

export interface PublisherSummaryRow {
  publisher_id: string;
  name: string;
  payout_currency: string;
  settlement_count: number;
  earned_cents: number;
  blocked_count: number;
  failed_count: number;
}

export interface DriverStats {
  running: boolean;
  started: number;
  settled: number;
  blocked: number;
  failed: number;
  concurrency: number;
  fraudRate: number;
  lastEvent: string;
}

export interface LedgerEntry {
  account: string;
  account_id: string;
  entry_type: string;
  amount_cents: number;
  currency: string;
}

export interface AttributionChain {
  settlement_id: string;
  query_text: string;
  search_request_id: string;
  assertion_id: string;
  assertion_consumed_at: string | null;
  publisher_id: string;
  product_id: string;
  merchant_name: string;
  gross_amount_cents: number;
  commission_bps: number;
  commission_amount_cents: number;
  platform_fee_cents: number;
  publisher_amount_cents: number;
  status: string;
  tx_hash: string | null;
  ledger_entries: LedgerEntry[];
}
