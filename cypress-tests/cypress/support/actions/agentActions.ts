import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { GatewayPaths, gatewayUrl } from '../constants/routes';
import { BaseSepolia, Eip3009, SearchDefaults, X402, X402Headers } from '../constants/testData';
import type {
  AttributionAssertion,
  PaymentRequiredBody,
  PaymentRequirements,
  SearchResponse,
  X402Payment,
} from '../types/interfaces';

// Drives the protocol directly rather than through the dashboard, because the
// flows this exercises have no visible surface: an assertion refused at the
// edge never reaches a page. Every request goes through the gateway, so the
// edge sees exactly what a real agent sends.
class AgentActions {
  search(
    query: string,
    publisherId: string,
    size: number = SearchDefaults.Size
  ): Cypress.Chainable<Cypress.Response<SearchResponse>> {
    return cy.request<SearchResponse>({
      method: 'POST',
      url: gatewayUrl(GatewayPaths.Search),
      body: { query, publisher_id: publisherId, size },
      failOnStatusCode: false,
    });
  }

  requestChallenge(productId: string): Cypress.Chainable<Cypress.Response<PaymentRequiredBody>> {
    return cy.request<PaymentRequiredBody>({
      method: 'POST',
      url: gatewayUrl(GatewayPaths.Purchase),
      body: { product_id: productId },
      failOnStatusCode: false,
    });
  }

  // A fresh key per attempt. Nothing here holds funds, and a key committed to
  // a repository is a key somebody eventually funds by accident.
  signAuthorization(requirements: PaymentRequirements): Cypress.Chainable<X402Payment> {
    const account = privateKeyToAccount(generatePrivateKey());
    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + X402.ValidityWindowSeconds;
    const nonce = this.#randomNonce();

    const authorization = {
      from: account.address,
      to: requirements.payTo as `0x${string}`,
      value: BigInt(requirements.maxAmountRequired),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    };

    return cy
      .wrap(
        account.signTypedData({
          domain: {
            name: BaseSepolia.DomainName,
            version: BaseSepolia.DomainVersion,
            chainId: BaseSepolia.ChainId,
            verifyingContract: BaseSepolia.UsdcAddress as `0x${string}`,
          },
          types: Eip3009.Types,
          primaryType: Eip3009.PrimaryType,
          message: authorization,
        }),
        { log: false }
      )
      .then((signature): X402Payment => ({
        x402Version: X402.Version,
        scheme: X402.Scheme,
        network: requirements.network,
        authorization: {
          from: account.address,
          to: requirements.payTo,
          value: requirements.maxAmountRequired,
          validAfter: String(validAfter),
          validBefore: String(validBefore),
          nonce,
        },
        signature: signature as string,
      }));
  }

  attemptPurchase(
    productId: string,
    assertion: AttributionAssertion,
    payment: X402Payment
  ): Cypress.Chainable<Cypress.Response<Record<string, unknown>>> {
    return cy.request<Record<string, unknown>>({
      method: 'POST',
      url: gatewayUrl(GatewayPaths.Purchase),
      body: { product_id: productId },
      headers: {
        [X402Headers.PaymentSignature]: this.#encodeHeader(payment),
        [X402Headers.AttributionAssertion]: this.#encodeHeader(assertion),
      },
      failOnStatusCode: false,
    });
  }

  #encodeHeader(value: unknown): string {
    return btoa(JSON.stringify(value));
  }

  #randomNonce(): `0x${string}` {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);

    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
}

export default new AgentActions();
