import type { AttributionAssertion } from '@agentic-attribution/types';

import type { PaymentPayload, PaymentRequirements } from './x402.js';

export interface SettlementResult {
  settlement_id: string;
  status: string;
  tx_hash: string;
  network: string;
  payer: string;
  commission_bps: number;
  commission_amount_cents: number;
  platform_fee_cents: number;
  publisher_amount_cents: number;
}

export interface SettlementRejection {
  error: string;
  reason: string;
}

export type SettlementOutcome =
  | { ok: true; result: SettlementResult }
  | { ok: false; status: number; rejection: SettlementRejection };

export interface SettlementRequest {
  assertion: AttributionAssertion;
  merchant_id: string;
  gross_amount_cents: number;
  currency: string;
  payment_payload: PaymentPayload;
  payment_requirements: PaymentRequirements;
}

// Long enough to cover a facilitator round trip plus the on-chain wait the
// settlement service tolerates, and short enough that a wedged settlement
// service does not hold the agent's connection open indefinitely.
const SETTLEMENT_TIMEOUT_MS = 45_000;

export interface RejectionReport {
  publisher_id: string;
  assertion_id: string;
  merchant_id: string;
  reason: string;
  detail: string;
}

export class SettlementClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Journals a refusal this merchant made before settlement ever saw it.
   *
   * The assertion gets verified here, so a tampered or expired one never
   * reaches /settle and the platform would otherwise refuse an attack and
   * record nothing. Reporting closes that gap without moving the schema
   * outside the service that owns it.
   *
   * Deliberately returns nothing and throws nothing. The merchant has already
   * decided to refuse, and a failure to journal that decision must never turn
   * a clean refusal into an error the caller could retry against.
   */
  async reportRejection(rejection: RejectionReport): Promise<void> {
    try {
      await fetch(`${this.#baseUrl}/rejections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rejection),
        signal: AbortSignal.timeout(SETTLEMENT_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      console.error(
        JSON.stringify({ level: 'error', msg: 'report rejection failed', error: message })
      );
    }
  }

  // Failures come back as data rather than as thrown errors. The merchant has
  // to translate a settlement rejection into an HTTP status for the agent, and
  // a rejected payment is an ordinary outcome rather than an exception.
  async settle(request: SettlementRequest): Promise<SettlementOutcome> {
    const response = await fetch(`${this.#baseUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(SETTLEMENT_TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true, result: (await response.json()) as SettlementResult };
    }

    let rejection: SettlementRejection;
    try {
      rejection = (await response.json()) as SettlementRejection;
    } catch {
      rejection = {
        error: `settlement service returned ${response.status}`,
        reason: 'settlement_unavailable',
      };
    }

    return { ok: false, status: response.status, rejection };
  }
}
