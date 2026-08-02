// Ways an attacker could try to redirect commission, expressed as mutations of
// a genuine assertion.
//
// None of these needs new server code. Every one of them already gets rejected
// by a verification path the platform has always had, and each rejection
// carries its own reason. What was missing was anyone performing the attack, so
// the property stayed a claim rather than something a viewer could watch hold.

import type { AttributionAssertion } from '@agentic-attribution/types';

export const FRAUD_MODES = [
  'tampered_publisher',
  'tampered_commission',
  'expired',
  'forged_signature',
  'unknown_publisher',
] as const;

export type FraudMode = (typeof FRAUD_MODES)[number];

// The reason the platform is expected to answer with. A mutation that gets
// rejected for a different reason means the demonstration is lying about which
// control caught it, so the runner checks rather than assumes.
export const EXPECTED_REJECTION: Record<FraudMode, string> = {
  tampered_publisher: 'assertion_signature_invalid',
  tampered_commission: 'assertion_signature_invalid',
  expired: 'assertion_expired',
  forged_signature: 'assertion_signature_invalid',
  unknown_publisher: 'assertion_signature_invalid',
};

const ATTACKER_PUBLISHER = 'pub_999999';
const INFLATED_COMMISSION_BPS = 9999;

// An Ed25519 signature encodes to 88 base64 characters, the last two of them
// padding. A forgery of the wrong length would fail a length check before
// verification ran, which would prove the wrong control caught it.
const SIGNATURE_PREFIX = 'ed25519:';
const SIGNATURE_BODY_LENGTH = 86;

const MILLIS_PER_HOUR = 3_600_000;

// The platform mints timestamps to the second. A fraud attempt has to match
// the genuine format everywhere except the field it attacks, otherwise the
// shape gives it away before the signature check ever runs.
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * MILLIS_PER_HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Rewrites a genuine assertion into an attempt the platform must refuse.
 *
 * Every mode leaves the signature bytes untouched except `forged_signature`,
 * because the point of most of these is that changing any signed field breaks
 * verification without the attacker ever touching the signature itself.
 */
export function applyFraud(
  assertion: AttributionAssertion,
  mode: FraudMode,
): AttributionAssertion {
  switch (mode) {
    // Redirecting the payout to an attacker-controlled publisher, the most
    // direct attack the design exists to stop.
    case 'tampered_publisher':
      return { ...assertion, publisher_id: ATTACKER_PUBLISHER };

    // Raising the signed rate after the platform set it. The rate travels
    // inside the signature precisely so a merchant cannot be talked into
    // honouring a number the platform never agreed to.
    case 'tampered_commission':
      return { ...assertion, commission_bps: INFLATED_COMMISSION_BPS };

    // A genuine assertion replayed long after its window closed. Expiry bounds
    // how long a captured assertion stays worth anything.
    case 'expired':
      return { ...assertion, issued_at: hoursAgo(3), expires_at: hoursAgo(2) };

    // A signature invented wholesale, testing that verification rejects rather
    // than merely comparing lengths or prefixes.
    case 'forged_signature':
      return {
        ...assertion,
        signature: SIGNATURE_PREFIX + 'A'.repeat(SIGNATURE_BODY_LENGTH) + '==',
      };

    // A publisher that does not exist, presented with a rate favourable to
    // whoever invented it.
    case 'unknown_publisher':
      return {
        ...assertion,
        publisher_id: ATTACKER_PUBLISHER,
        commission_bps: INFLATED_COMMISSION_BPS,
      };
  }
}

export function pickFraudMode(random: () => number = Math.random): FraudMode {
  const index = Math.floor(random() * FRAUD_MODES.length) % FRAUD_MODES.length;

  return FRAUD_MODES[index] as FraudMode;
}
