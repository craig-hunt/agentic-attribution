import {
  SIGNATURE_PREFIX,
  canonicalizeForSigning,
  type AttributionAssertion,
} from './index.js';

// One verifier, three runtimes. WebCrypto exists in Node, in Cloudflare
// Workers, and in browsers, while node:crypto exists in none of the other two.
// The edge worker and the merchant therefore run identical verification code,
// which matters because a second implementation is a second place for the
// canonical byte order to drift away from Go.
const ED25519 = 'Ed25519';
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

export type VerificationFailure =
  | 'malformed_signature'
  | 'invalid_signature'
  | 'expired';

export class AssertionVerificationError extends Error {
  readonly reason: VerificationFailure;

  constructor(reason: VerificationFailure, message: string) {
    super(message);
    this.name = 'AssertionVerificationError';
    this.reason = reason;
  }
}

// The buffer is allocated explicitly so the result types as
// Uint8Array<ArrayBuffer> rather than Uint8Array<ArrayBufferLike>. WebCrypto's
// BufferSource excludes SharedArrayBuffer, and the shorthand constructor widens
// to the union that includes it.
function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// TextEncoder types its result over ArrayBufferLike for the same reason, so the
// signing payload gets the same treatment. The copy costs a few hundred bytes
// per verification, which does not register against an Ed25519 verify.
function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);

  return bytes;
}

/**
 * Imports the base64 raw public key that ATTRIBUTION_PUBLIC_KEY carries.
 * Import once at startup and reuse; importKey costs more than verify does.
 */
export async function importVerificationKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key.trim());

  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(
      `public key holds ${raw.length} bytes, expected ${ED25519_PUBLIC_KEY_BYTES}`,
    );
  }

  return crypto.subtle.importKey('raw', raw, { name: ED25519 }, false, ['verify']);
}

/**
 * Checks the signature and the expiry, mirroring the Go verifier exactly.
 * Replay detection lives in the settlement service, which owns the durable
 * record of consumed assertions; nothing at the edge can answer that question.
 */
export async function verifyAssertion(
  assertion: AttributionAssertion,
  key: CryptoKey,
  now: Date = new Date(),
): Promise<void> {
  if (!assertion.signature.startsWith(SIGNATURE_PREFIX)) {
    throw new AssertionVerificationError(
      'malformed_signature',
      `signature missing the ${SIGNATURE_PREFIX} prefix`,
    );
  }

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64ToBytes(assertion.signature.slice(SIGNATURE_PREFIX.length));
  } catch {
    throw new AssertionVerificationError(
      'malformed_signature',
      'signature is not valid base64',
    );
  }

  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new AssertionVerificationError(
      'malformed_signature',
      `signature holds ${signature.length} bytes, expected ${ED25519_SIGNATURE_BYTES}`,
    );
  }

  const payload = utf8Bytes(canonicalizeForSigning(assertion));
  const valid = await crypto.subtle.verify({ name: ED25519 }, key, signature, payload);

  if (!valid) {
    throw new AssertionVerificationError(
      'invalid_signature',
      'signature does not verify against the public key',
    );
  }

  // Expiry is checked after the signature deliberately. expires_at sits inside
  // the signed payload, so trusting it before verifying the signature would let
  // a caller move the deadline on an assertion nobody signed.
  const expires = Date.parse(assertion.expires_at);

  if (Number.isNaN(expires)) {
    throw new AssertionVerificationError(
      'malformed_signature',
      `expires_at is not a parseable timestamp: ${assertion.expires_at}`,
    );
  }

  if (now.getTime() >= expires) {
    throw new AssertionVerificationError(
      'expired',
      `assertion expired at ${assertion.expires_at}`,
    );
  }
}
