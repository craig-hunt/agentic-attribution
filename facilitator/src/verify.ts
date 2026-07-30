import {
  EIP3009_PRIMARY_TYPE,
  EIP3009_TYPES,
  eip712Domain,
  toTypedMessage,
} from '@agentic-attribution/types';
import { keccak256, toHex, verifyTypedData } from 'viem';

// This mock stands in for the on-chain transfer, never for the signature check.
// A test double that accepts payloads the real thing would reject is worse than
// no double at all, because it teaches the system a false contract and the
// divergence surfaces only against mainnet. See ADR-0007.

export interface WireAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface WirePaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  authorization: WireAuthorization;
  signature: string;
}

export interface WirePaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
}

export type InvalidReason =
  | 'unsupported_scheme'
  | 'network_mismatch'
  | 'asset_mismatch'
  | 'payee_mismatch'
  | 'insufficient_amount'
  | 'authorization_not_yet_valid'
  | 'authorization_expired'
  | 'invalid_signature'
  | 'malformed_payload';

export interface VerifyOutcome {
  isValid: boolean;
  invalidReason?: InvalidReason;
  payer?: string;
}

const SCHEME_EXACT = 'exact';

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export async function verifyPayment(
  payload: WirePaymentPayload,
  requirements: WirePaymentRequirements,
  nowSeconds: bigint,
): Promise<VerifyOutcome> {
  if (payload.scheme !== SCHEME_EXACT || requirements.scheme !== SCHEME_EXACT) {
    return { isValid: false, invalidReason: 'unsupported_scheme' };
  }

  if (payload.network !== requirements.network) {
    return { isValid: false, invalidReason: 'network_mismatch' };
  }

  let message: ReturnType<typeof toTypedMessage>;
  let domain: ReturnType<typeof eip712Domain>;
  try {
    message = toTypedMessage(payload.authorization);
    domain = eip712Domain(payload.network);
  } catch {
    return { isValid: false, invalidReason: 'malformed_payload' };
  }

  // The signature commits to verifyingContract, so a payload naming a different
  // asset than the domain it was signed under would fail recovery anyway. This
  // check turns that into a specific reason rather than a generic one.
  if (!sameAddress(requirements.asset, domain.verifyingContract)) {
    return { isValid: false, invalidReason: 'asset_mismatch' };
  }

  if (!sameAddress(payload.authorization.to, requirements.payTo)) {
    return { isValid: false, invalidReason: 'payee_mismatch' };
  }

  // The scheme is named "exact", and the requirement is a maximum, so anything
  // other than exactly the required amount fails. Accepting a larger value
  // would let a caller overpay into a settlement recorded at the smaller figure.
  if (message.value !== BigInt(requirements.maxAmountRequired)) {
    return { isValid: false, invalidReason: 'insufficient_amount' };
  }

  if (nowSeconds < message.validAfter) {
    return { isValid: false, invalidReason: 'authorization_not_yet_valid' };
  }

  if (nowSeconds >= message.validBefore) {
    return { isValid: false, invalidReason: 'authorization_expired' };
  }

  let signatureValid: boolean;
  try {
    signatureValid = await verifyTypedData({
      address: message.from,
      domain,
      types: EIP3009_TYPES,
      primaryType: EIP3009_PRIMARY_TYPE,
      message,
      signature: payload.signature as `0x${string}`,
    });
  } catch {
    return { isValid: false, invalidReason: 'malformed_payload' };
  }

  if (!signatureValid) {
    return { isValid: false, invalidReason: 'invalid_signature' };
  }

  return { isValid: true, payer: message.from };
}

/**
 * Produces the transaction hash the simulated settlement reports. Deriving it
 * from the authorization rather than from a random value keeps the mock
 * deterministic and makes the nonce's single-use property visible: the same
 * authorization always yields the same hash, exactly as a replayed on-chain
 * transfer would collide.
 */
export function simulatedTransactionHash(authorization: WireAuthorization): string {
  return keccak256(
    toHex(
      [
        authorization.from,
        authorization.to,
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce,
      ].join('|'),
    ),
  );
}
