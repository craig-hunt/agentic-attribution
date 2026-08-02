import {
  simulatedTransactionHash,
  verifyPayment,
  type WirePaymentPayload,
  type WirePaymentRequirements,
} from './verify.js';

// The routing and replay logic, separated from the server that hosts it.
//
// Keeping this out of index.ts is what makes it testable: a module that starts
// listening on import cannot be imported by a test, so its behaviour goes
// unexercised no matter how much of it matters. The gateway splits the same way
// and for the same reason.

export const MAX_BODY_BYTES = 64 * 1024;

export const ROUTE = {
  Verify: '/verify',
  Settle: '/settle',
  Health: '/healthz',
} as const;

export interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: WirePaymentPayload;
  paymentRequirements: WirePaymentRequirements;
}

export interface FacilitatorResponse {
  status: number;
  body: unknown;
}

export interface SettlementRecord {
  payer: string;
  to: string;
  value: string;
  transaction: string;
}

/**
 * Tracks the nonces this facilitator has already settled.
 *
 * Nonces are single-use on chain: the token contract records each one and
 * refuses a repeat, so a replayed authorization fails rather than transferring
 * twice. Reproducing that here matters because the demo shows two independent
 * replay defenses, the settlement service guarding the assertion and this
 * guarding the payment, and a mock that let a nonce through twice would
 * quietly remove one of them.
 */
export class NonceLedger {
  readonly #consumed = new Set<string>();

  claim(nonce: string): boolean {
    if (this.#consumed.has(nonce)) {
      return false;
    }

    this.#consumed.add(nonce);

    return true;
  }

  has(nonce: string): boolean {
    return this.#consumed.has(nonce);
  }

  get size(): number {
    return this.#consumed.size;
  }
}

export function nowSeconds(clock: () => number = Date.now): bigint {
  return BigInt(Math.floor(clock() / 1000));
}

export interface HandlerOptions {
  nonces: NonceLedger;
  clock?: () => number;
  onSettled?: (record: SettlementRecord) => void;
}

/**
 * Answers one facilitator call.
 *
 * A rejected payment comes back as a 200 carrying success:false, matching the
 * real facilitator. Only the facilitator itself failing produces a non-200, and
 * the settlement service treats those two cases very differently: one means the
 * payment will never work, the other means nobody knows yet.
 */
export async function handle(
  method: string,
  path: string,
  body: FacilitatorRequest | null,
  options: HandlerOptions,
): Promise<FacilitatorResponse> {
  if (method === 'GET' && path === ROUTE.Health) {
    return { status: 200, body: { status: 'ok', mode: 'mock' } };
  }

  if (method !== 'POST' || (path !== ROUTE.Verify && path !== ROUTE.Settle)) {
    return { status: 404, body: { error: 'not found' } };
  }

  if (body === null) {
    return { status: 400, body: { error: 'malformed request body' } };
  }

  const outcome = await verifyPayment(
    body.paymentPayload,
    body.paymentRequirements,
    nowSeconds(options.clock),
  );

  if (path === ROUTE.Verify) {
    return { status: 200, body: outcome };
  }

  if (!outcome.isValid) {
    return { status: 200, body: { success: false, errorReason: outcome.invalidReason } };
  }

  const authorization = body.paymentPayload.authorization;

  if (!options.nonces.claim(authorization.nonce)) {
    return { status: 200, body: { success: false, errorReason: 'nonce_already_used' } };
  }

  const transaction = simulatedTransactionHash(authorization);

  options.onSettled?.({
    payer: outcome.payer ?? '',
    to: authorization.to,
    value: authorization.value,
    transaction,
  });

  return {
    status: 200,
    body: {
      success: true,
      transaction,
      network: body.paymentPayload.network,
      payer: outcome.payer,
    },
  };
}
