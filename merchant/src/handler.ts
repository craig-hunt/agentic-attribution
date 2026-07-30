import {
  AssertionVerificationError,
  verifyAssertion,
  type AttributionAssertion,
} from '@agentic-attribution/types';

import { PAYMENT_TIMEOUT_SECONDS, SCHEME_EXACT, X402_VERSION, centsToAtomicUnits, type MerchantConfig } from './config.js';
import type { Catalog, Listing } from './catalog.js';
import type { SettlementClient } from './settlement.js';
import {
  X402_HEADER,
  decodeAssertionHeader,
  decodePaymentHeader,
  encodeHeaderJson,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
} from './x402.js';

export const HTTP_STATUS = {
  Ok: 200,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  NotFound: 404,
  Conflict: 409,
  Unprocessable: 422,
  BadGateway: 502,
} as const;

export interface PurchaseRequest {
  product_id: string;
}

export interface Fulfillment {
  order_id: string;
  product_id: string;
  listing_title: string;
  amount_cents: number;
  currency: string;
  settlement_id: string;
  tx_hash: string;
  network: string;
  attributed_publisher_id: string;
  publisher_commission_cents: number;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class PurchaseHandler {
  readonly #config: MerchantConfig;
  readonly #catalog: Catalog;
  readonly #settlement: SettlementClient;
  readonly #verificationKey: CryptoKey;

  constructor(
    config: MerchantConfig,
    catalog: Catalog,
    settlement: SettlementClient,
    verificationKey: CryptoKey,
  ) {
    this.#config = config;
    this.#catalog = catalog;
    this.#settlement = settlement;
    this.#verificationKey = verificationKey;
  }

  #requirementsFor(listing: Listing): PaymentRequirements {
    return {
      scheme: SCHEME_EXACT,
      network: this.#config.network,
      asset: this.#config.assetAddress,
      maxAmountRequired: centsToAtomicUnits(listing.priceCents),
      payTo: this.#config.payToAddress,
      maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
      resource: `/purchase/${listing.productId}`,
      description: listing.listingTitle,
    };
  }

  async handle(
    body: PurchaseRequest,
    headers: Record<string, string | undefined>,
    now: Date = new Date(),
  ): Promise<HandlerResponse> {
    if (!body?.product_id) {
      return { status: HTTP_STATUS.BadRequest, body: { error: 'product_id required' } };
    }

    const listing = await this.#catalog.findListing(body.product_id);
    if (!listing) {
      return {
        status: HTTP_STATUS.NotFound,
        body: { error: `no listing for ${body.product_id} at ${this.#config.merchantId}` },
      };
    }
    if (!listing.inStock) {
      return { status: HTTP_STATUS.Unprocessable, body: { error: 'listing out of stock' } };
    }

    const requirements = this.#requirementsFor(listing);
    const paymentHeader = headers[X402_HEADER.PaymentSignature];

    // No payment on the request is the ordinary first half of the exchange
    // rather than an error. The 402 carries everything the agent needs to
    // construct and sign an authorization without another round trip.
    if (!paymentHeader) {
      const challenge: PaymentRequiredBody = {
        x402Version: X402_VERSION,
        accepts: [requirements],
      };

      return {
        status: HTTP_STATUS.PaymentRequired,
        body: challenge,
        headers: { [X402_HEADER.PaymentRequired]: encodeHeaderJson(challenge) },
      };
    }

    const assertionHeader = headers[X402_HEADER.AttributionAssertion];
    if (!assertionHeader) {
      return {
        status: HTTP_STATUS.BadRequest,
        body: {
          error: `payment supplied without ${X402_HEADER.AttributionAssertion}`,
          reason: 'assertion_missing',
        },
      };
    }

    let assertion: AttributionAssertion;
    let payment: PaymentPayload;
    try {
      assertion = decodeAssertionHeader(assertionHeader);
      payment = decodePaymentHeader(paymentHeader);
    } catch {
      return {
        status: HTTP_STATUS.BadRequest,
        body: { error: 'headers are not base64-encoded JSON', reason: 'malformed_headers' },
      };
    }

    // The merchant verifies locally to fail fast on a forged or stale
    // assertion, and the settlement service verifies again before it moves
    // money. The second check is the authoritative one: settlement cannot
    // trust a merchant's word that it looked, and the merchant should not pay
    // for a network round trip to learn what a local signature check answers
    // in microseconds.
    try {
      await verifyAssertion(assertion, this.#verificationKey, now);
    } catch (error) {
      if (error instanceof AssertionVerificationError) {
        return {
          status: HTTP_STATUS.Unauthorized,
          body: { error: error.message, reason: error.reason },
        };
      }
      throw error;
    }

    // An assertion names the product it was issued against. Accepting one
    // minted for a different product would let a buyer attach a high-commission
    // assertion to an unrelated purchase.
    if (assertion.product_id !== listing.productId) {
      return {
        status: HTTP_STATUS.Unprocessable,
        body: {
          error: `assertion covers ${assertion.product_id}, purchase covers ${listing.productId}`,
          reason: 'assertion_product_mismatch',
        },
      };
    }

    const expectedAmount = centsToAtomicUnits(listing.priceCents);
    if (payment.authorization.value !== expectedAmount) {
      return {
        status: HTTP_STATUS.Unprocessable,
        body: {
          error: `authorization pays ${payment.authorization.value}, listing requires ${expectedAmount}`,
          reason: 'amount_mismatch',
        },
      };
    }

    if (payment.authorization.to.toLowerCase() !== this.#config.payToAddress.toLowerCase()) {
      return {
        status: HTTP_STATUS.Unprocessable,
        body: { error: 'authorization pays a different address', reason: 'payee_mismatch' },
      };
    }

    const outcome = await this.#settlement.settle({
      assertion,
      merchant_id: this.#config.merchantId,
      gross_amount_cents: listing.priceCents,
      currency: listing.currency,
      payment_payload: payment,
      payment_requirements: requirements,
    });

    if (!outcome.ok) {
      // The settlement service already mapped its failure to a status a caller
      // can act on, so passing it through beats re-deriving it here and risking
      // the two services disagreeing about what a replay looks like.
      return { status: outcome.status, body: outcome.rejection };
    }

    const fulfillment: Fulfillment = {
      order_id: outcome.result.settlement_id,
      product_id: listing.productId,
      listing_title: listing.listingTitle,
      amount_cents: listing.priceCents,
      currency: listing.currency,
      settlement_id: outcome.result.settlement_id,
      tx_hash: outcome.result.tx_hash,
      network: outcome.result.network,
      attributed_publisher_id: assertion.publisher_id,
      publisher_commission_cents: outcome.result.publisher_amount_cents,
    };

    return {
      status: HTTP_STATUS.Ok,
      body: fulfillment,
      headers: { [X402_HEADER.PaymentResponse]: encodeHeaderJson(outcome.result) },
    };
  }
}
