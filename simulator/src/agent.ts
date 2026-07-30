import {
  EIP3009_PRIMARY_TYPE,
  EIP3009_TYPES,
  eip712Domain,
  toTypedMessage,
  type AttributionAssertion,
} from '@agentic-attribution/types';
import type { PrivateKeyAccount } from 'viem';

export const ASSERTION_HEADER = 'x-attribution-assertion';
export const PAYMENT_HEADER = 'payment-signature';

// Signed a minute in the past so a small clock skew between the agent and the
// verifier cannot reject an authorization that is genuinely current.
const VALID_AFTER_BACKDATE_SECONDS = 60n;

export interface MerchantOffer {
  listing_id: string;
  merchant_id: string;
  price_cents: number;
  in_stock: boolean;
  commission_bps: number;
}

export interface ProductResult {
  product_id: string;
  canonical_title: string;
  offers: MerchantOffer[];
}

export interface SearchResponse {
  search_request_id: string;
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

export interface Fulfillment {
  order_id: string;
  product_id: string;
  amount_cents: number;
  settlement_id: string;
  tx_hash: string;
  attributed_publisher_id: string;
  publisher_commission_cents: number;
}

export interface Selection {
  product: ProductResult;
  offer: MerchantOffer;
  assertion: AttributionAssertion;
}

export class AgentError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
    this.body = body;
  }
}

function encodeHeaderJson(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

/**
 * Picks the cheapest in-stock offer, then pairs it with the assertion minted
 * for that product. An assertion covers a product rather than a merchant, so
 * the agent stays free to choose among offers after the assertion is issued.
 * Returns null when nothing is buyable rather than throwing, since an empty
 * result is an ordinary outcome of a search.
 */
export function selectCheapestInStock(response: SearchResponse): Selection | null {
  const byProduct = new Map(response.assertions.map((a) => [a.product_id, a]));

  let best: Selection | null = null;

  for (const product of response.products) {
    const assertion = byProduct.get(product.product_id);
    if (!assertion) {
      continue;
    }

    for (const offer of product.offers) {
      if (!offer.in_stock) {
        continue;
      }

      if (!best || offer.price_cents < best.offer.price_cents) {
        best = { product, offer, assertion };
      }
    }
  }

  return best;
}

export function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export interface AgentOptions {
  gatewayUrl: string;
  account: PrivateKeyAccount;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
}

export class Agent {
  readonly #gatewayUrl: string;
  readonly #account: PrivateKeyAccount;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  constructor(options: AgentOptions) {
    this.#gatewayUrl = options.gatewayUrl.replace(/\/+$/, '');
    this.#account = options.account;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  get address(): string {
    return this.#account.address;
  }

  async search(query: string, publisherId: string, size = 10): Promise<SearchResponse> {
    const response = await this.#fetch(`${this.#gatewayUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, publisher_id: publisherId, size }),
    });

    if (!response.ok) {
      throw new AgentError('search failed', response.status, await response.text());
    }

    return (await response.json()) as SearchResponse;
  }

  /**
   * Sends the purchase with no payment and expects the 402. A 200 here would
   * mean the merchant sold something without asking for money, which is a
   * failure worth surfacing loudly rather than treating as a happy path.
   */
  async requestChallenge(productId: string): Promise<PaymentRequirements> {
    const response = await this.#fetch(`${this.#gatewayUrl}/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId }),
    });

    if (response.status !== 402) {
      throw new AgentError(
        `expected 402 Payment Required, got ${response.status}`,
        response.status,
        await response.text(),
      );
    }

    const body = (await response.json()) as PaymentRequiredBody;
    const requirements = body.accepts[0];

    if (!requirements) {
      throw new AgentError('402 carried no payment requirements', 402, body);
    }

    return requirements;
  }

  /**
   * Signs the EIP-3009 authorization. This is a real typed-data signature over
   * the real structure the USDC contract validates, in both mock and live
   * facilitator modes. Only the on-chain transfer differs between them.
   */
  async signAuthorization(requirements: PaymentRequirements): Promise<{
    x402Version: number;
    scheme: string;
    network: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: string;
  }> {
    const nowSeconds = BigInt(Math.floor(this.#now() / 1000));

    const authorization = {
      from: this.#account.address,
      to: requirements.payTo,
      value: requirements.maxAmountRequired,
      validAfter: String(nowSeconds - VALID_AFTER_BACKDATE_SECONDS),
      validBefore: String(nowSeconds + BigInt(requirements.maxTimeoutSeconds)),
      // A fresh nonce per authorization. The token contract records each one
      // and refuses a repeat, so reusing one would fail on chain rather than
      // transfer twice.
      nonce: randomNonce(),
    };

    const signature = await this.#account.signTypedData({
      domain: eip712Domain(requirements.network),
      types: EIP3009_TYPES,
      primaryType: EIP3009_PRIMARY_TYPE,
      message: toTypedMessage(authorization),
    });

    return {
      x402Version: 1,
      scheme: requirements.scheme,
      network: requirements.network,
      authorization,
      signature,
    };
  }

  async completePurchase(
    productId: string,
    assertion: AttributionAssertion,
    payment: unknown,
  ): Promise<Fulfillment> {
    const response = await this.#fetch(`${this.#gatewayUrl}/purchase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PAYMENT_HEADER]: encodeHeaderJson(payment),
        [ASSERTION_HEADER]: encodeHeaderJson(assertion),
      },
      body: JSON.stringify({ product_id: productId }),
    });

    if (!response.ok) {
      throw new AgentError('purchase rejected', response.status, await response.json());
    }

    return (await response.json()) as Fulfillment;
  }

  /**
   * The whole loop: search, choose, take the challenge, sign, pay. Returns the
   * assertion alongside the fulfillment so a caller can attempt a replay with
   * it, which is how the demo shows single-use enforcement working.
   */
  async purchase(
    query: string,
    publisherId: string,
  ): Promise<{ selection: Selection; fulfillment: Fulfillment }> {
    const results = await this.search(query, publisherId);
    const selection = selectCheapestInStock(results);

    if (!selection) {
      throw new AgentError(`no purchasable offer for "${query}"`, 404, results);
    }

    const requirements = await this.requestChallenge(selection.product.product_id);
    const payment = await this.signAuthorization(requirements);

    const fulfillment = await this.completePurchase(
      selection.product.product_id,
      selection.assertion,
      payment,
    );

    return { selection, fulfillment };
  }
}
