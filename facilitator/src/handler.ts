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
  Fault: '/fault',
} as const;

/**
 * Faults this facilitator can be told to inject.
 *
 * A mock that only ever succeeds leaves the platform's failure handling
 * untested: settlements never reach a failed state, the ledger never proves it
 * writes nothing for one, and the dashboard's failed column stays zero forever
 * while its filter claims to work. Injecting a fault on demand exercises paths
 * a real facilitator would eventually produce anyway.
 *
 * Controlled at runtime rather than through configuration so a test can turn
 * one on, assert, and turn it off again without restarting a service that
 * other tests are using.
 */
export const FAULT = {
  None: 'none',
  VerifyRejects: 'verify_rejects',
  SettleFails: 'settle_fails',
  Unavailable: 'unavailable',
} as const;

export type FaultMode = (typeof FAULT)[keyof typeof FAULT];

export interface FaultState {
  mode: FaultMode;
}

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
  // Absent means fault injection stays unavailable and /fault answers 404,
  // which is what a deployment wanting no such control would leave it as.
  fault?: FaultState;
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
    // The fault key appears only where injection is configured, so a
    // deployment without it answers exactly what it always answered.
    return {
      status: 200,
      body: options.fault
        ? { status: 'ok', mode: 'mock', fault: options.fault.mode }
        : { status: 'ok', mode: 'mock' },
    };
  }

  // Reading and setting the injected fault. A GET answers what is armed, and a
  // POST arms or clears it.
  if (path === ROUTE.Fault) {
    if (!options.fault) {
      return { status: 404, body: { error: 'fault injection unavailable' } };
    }

    if (method === 'GET') {
      return { status: 200, body: { mode: options.fault.mode } };
    }

    if (method === 'POST') {
      const requested = (body as unknown as { mode?: string } | null)?.mode;
      const known = Object.values(FAULT).includes(requested as FaultMode);

      if (!known) {
        return {
          status: 400,
          body: { error: `unknown fault mode`, known: Object.values(FAULT) },
        };
      }

      options.fault.mode = requested as FaultMode;

      return { status: 200, body: { mode: options.fault.mode } };
    }

    return { status: 404, body: { error: 'not found' } };
  }

  // An armed fault answers before any verification runs, because a facilitator
  // that has fallen over does not get as far as checking a signature.
  if (options.fault && options.fault.mode !== FAULT.None) {
    if (options.fault.mode === FAULT.Unavailable) {
      return { status: 503, body: { error: 'facilitator unavailable', injected: true } };
    }

    if (options.fault.mode === FAULT.VerifyRejects && path === ROUTE.Verify) {
      return {
        status: 200,
        body: { isValid: false, invalidReason: 'injected_fault', injected: true },
      };
    }

    if (options.fault.mode === FAULT.SettleFails && path === ROUTE.Settle) {
      return {
        status: 200,
        body: { success: false, errorReason: 'injected_fault', injected: true },
      };
    }
  }

  if (method !== 'POST' || (path !== ROUTE.Verify && path !== ROUTE.Settle)) {
    return { status: 404, body: { error: 'not found' } };
  }

  // Validated before anything reads a field. A body missing its payload
  // reached a dereference and threw, and the throw terminated the process
  // rather than answering, which made one malformed request enough to stop
  // every settlement on the platform.
  const malformed = describeMalformedRequest(body);
  if (malformed !== null) {
    return { status: 400, body: { error: malformed, reason: 'malformed_request' } };
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

/**
 * Reports what is wrong with a facilitator request, or null when it carries
 * the fields every path here goes on to read.
 *
 * A caller reaching this endpoint is unauthenticated, so the check has to
 * happen before any field access rather than being left to the callers.
 */
function describeMalformedRequest(body: FacilitatorRequest | null): string | null {
  if (body === null || typeof body !== 'object') {
    return 'request body is not an object';
  }

  const payload = body.paymentPayload as unknown;
  if (typeof payload !== 'object' || payload === null) {
    return 'request carries no paymentPayload';
  }

  const requirements = body.paymentRequirements as unknown;
  if (typeof requirements !== 'object' || requirements === null) {
    return 'request carries no paymentRequirements';
  }

  const authorization = (payload as { authorization?: unknown }).authorization;
  if (typeof authorization !== 'object' || authorization === null) {
    return 'paymentPayload carries no authorization';
  }

  return null;
}
