import type { AttributionAssertion } from '@agentic-attribution/types';

// The x402 wire format is camelCase and fixed by the spec. Domain types
// elsewhere in this repo use snake_case, and keeping the two shapes apart means
// a spec revision touches this file alone. The Go settlement service holds the
// mirror image of these structs for the same reason.

export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  authorization: Eip3009Authorization;
  signature: string;
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
  error?: string;
}

export const X402_HEADER = {
  PaymentRequired: 'payment-required',
  PaymentSignature: 'payment-signature',
  PaymentResponse: 'payment-response',
  AttributionAssertion: 'x-attribution-assertion',
} as const;

// Headers carry JSON as base64 so a payload with quotes, commas, or non-ASCII
// characters survives header encoding intact. Header values are latin-1 by
// specification, and a raw JSON assertion carrying a UTF-8 product name would
// arrive corrupted.
export function encodeHeaderJson(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

export function decodeHeaderJson<T>(encoded: string): T {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function decodeAssertionHeader(encoded: string): AttributionAssertion {
  return decodeHeaderJson<AttributionAssertion>(encoded);
}

export class MalformedPaymentError extends Error {
  readonly reason = 'malformed_payment';
}

const AUTHORIZATION_FIELDS = [
  'from',
  'to',
  'value',
  'validAfter',
  'validBefore',
  'nonce',
] as const;

/**
 * Decodes and validates a payment payload.
 *
 * A cast alone is a claim TypeScript cannot keep at runtime. Without checking,
 * a caller sending `{}` reaches a dereference of payment.authorization.value
 * and the merchant answers 502 carrying a JavaScript runtime message, which
 * tells an attacker the implementation language and hands an agent a status
 * suggesting the merchant broke rather than the request did.
 */
export function decodePaymentHeader(encoded: string): PaymentPayload {
  const decoded = decodeHeaderJson<Partial<PaymentPayload>>(encoded);

  if (typeof decoded !== 'object' || decoded === null) {
    throw new MalformedPaymentError('payment payload is not an object');
  }

  const authorization = decoded.authorization as Record<string, unknown> | undefined;
  if (typeof authorization !== 'object' || authorization === null) {
    throw new MalformedPaymentError('payment payload carries no authorization');
  }

  for (const field of AUTHORIZATION_FIELDS) {
    if (typeof authorization[field] !== 'string') {
      throw new MalformedPaymentError(`authorization.${field} is missing or not a string`);
    }
  }

  if (typeof decoded.signature !== 'string' || decoded.signature === '') {
    throw new MalformedPaymentError('payment payload carries no signature');
  }

  return decoded as PaymentPayload;
}
