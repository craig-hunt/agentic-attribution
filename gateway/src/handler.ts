import {
  AssertionVerificationError,
  importVerificationKey,
  verifyAssertion,
  type AttributionAssertion,
} from '@agentic-attribution/types';

// Nothing in this file imports a Node built-in or a platform SDK. It uses
// Request, Response, URL, fetch, and crypto.subtle, all of which Workers, Deno,
// Bun, Node 18+, and browsers implement. That restriction is what lets one
// module serve both the Docker demo and a Cloudflare deployment. See ADR-0007.
//
// A lint rule enforces the restriction rather than leaving it to discipline,
// because the first `import { Buffer }` added under deadline would break the
// portability claim silently and only at deploy time.

export interface GatewayEnv {
  SEARCH_URL: string;
  MERCHANT_URL: string;
  // Optional. The gateway refuses forged and expired assertions here, which
  // means those refusals never reach any service that could record them. Set
  // this and the edge journals what it stopped; leave it unset and the gateway
  // still refuses, silently.
  SETTLEMENT_URL?: string;
  ATTRIBUTION_PUBLIC_KEY: string;
}

export const ROUTE = {
  Search: '/search',
  Purchase: '/purchase',
  Health: '/healthz',
} as const;

export const ASSERTION_HEADER = 'x-attribution-assertion';
export const PAYMENT_HEADER = 'payment-signature';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

// Forwarded to the origin as-is. Hop-by-hop headers and the ones a proxy owns
// get dropped rather than passed through, so an origin never sees a Host or
// Content-Length describing a request it did not receive.
const STRIPPED_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection']);

const ORIGIN_TIMEOUT_MS = 30_000;

// Enforced here rather than in the Node adapter alone. Workers invokes this
// module directly with no adapter in front of it, so a limit that lived only in
// node.ts would protect the local demo and leave the deployed isolate open to
// memory exhaustion from an oversized POST. A search body carries a query and a
// publisher ID; a purchase body carries a product ID. Neither approaches this.
const MAX_BODY_BYTES = 256 * 1024;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function decodeHeaderJson<T>(encoded: string): T {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Reads the body with a hard ceiling, returning null when the caller exceeds
 * it. Content-Length gets checked first as a cheap rejection, then the stream
 * is counted as it arrives, because Content-Length can be absent under chunked
 * encoding and can simply lie. Trusting the header alone would leave the limit
 * advisory.
 */
async function readBoundedText(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return null;
  }

  if (!request.body) {
    return '';
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > MAX_BODY_BYTES) {
      // Cancelling releases the connection rather than draining a body the
      // gateway has already decided to refuse.
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(joined);
}

function forwardableHeaders(source: Headers): Headers {
  const headers = new Headers();

  source.forEach((value, name) => {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  });

  return headers;
}

async function proxy(request: Request, targetUrl: string, body: string): Promise<Response> {
  const response = await fetch(targetUrl, {
    method: request.method,
    headers: forwardableHeaders(request.headers),
    body,
    signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
  });

  // The origin's status and body pass through untouched. The gateway rejects or
  // forwards; it never rewrites an origin's verdict, because two components
  // deciding what a 409 means is two chances to disagree.
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

// The verification key is imported once per isolate rather than per request.
// importKey costs materially more than a verify, and on Workers an isolate
// serves many requests, so hoisting it turns a per-request cost into a
// per-isolate one.
let cachedKey: CryptoKey | null = null;
let cachedKeyMaterial: string | null = null;

async function verificationKey(env: GatewayEnv): Promise<CryptoKey> {
  if (cachedKey && cachedKeyMaterial === env.ATTRIBUTION_PUBLIC_KEY) {
    return cachedKey;
  }

  cachedKey = await importVerificationKey(env.ATTRIBUTION_PUBLIC_KEY);
  cachedKeyMaterial = env.ATTRIBUTION_PUBLIC_KEY;

  return cachedKey;
}

export function resetKeyCache(): void {
  cachedKey = null;
  cachedKeyMaterial = null;
}

// `now` stays third and optional so tests can pin time against a fixture with a
// fixed expiry. The default export below forwards exactly two arguments, which
// keeps this safe: Workers invokes fetch as (request, env, ctx), and letting a
// caller's execution context land in a Date parameter would be a real bug.
export async function handle(
  request: Request,
  env: GatewayEnv,
  now: Date = new Date(),
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === ROUTE.Health) {
    return json({ status: 'ok' }, 200);
  }

  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const body = await readBoundedText(request);
  if (body === null) {
    return json(
      { error: `request body exceeds ${MAX_BODY_BYTES} bytes`, reason: 'body_too_large' },
      413,
    );
  }

  if (url.pathname === ROUTE.Search) {
    return proxy(request, `${env.SEARCH_URL}${ROUTE.Search}`, body);
  }

  if (url.pathname !== ROUTE.Purchase) {
    return json({ error: 'not found' }, 404);
  }

  const assertionHeader = request.headers.get(ASSERTION_HEADER);
  const paymentHeader = request.headers.get(PAYMENT_HEADER);

  // A purchase carrying no payment is the first half of the 402 exchange and
  // has no assertion to check yet. Forwarding it unverified is correct: the
  // merchant answers with a challenge and touches nothing expensive.
  if (!paymentHeader) {
    return proxy(request, `${env.MERCHANT_URL}${ROUTE.Purchase}`, body);
  }

  // A payment presented without an assertion is an attempt to buy while
  // claiming nothing, which the platform refuses and therefore records.
  if (!assertionHeader) {
    reportRejection(env, {
      publisher_id: UNKNOWN_PUBLISHER,
      assertion_id: '',
      merchant_id: '',
      reason: 'assertion_missing',
      detail: 'payment supplied without an assertion',
    });

    return json({ error: 'payment supplied without an assertion', reason: 'assertion_missing' }, 400);
  }


  let assertion: AttributionAssertion;
  try {
    assertion = decodeHeaderJson<AttributionAssertion>(assertionHeader);
  } catch {
    reportRejection(env, {
      publisher_id: UNKNOWN_PUBLISHER,
      assertion_id: '',
      merchant_id: '',
      reason: 'malformed_headers',
      detail: 'assertion header is not base64 JSON',
    });

    return json({ error: 'assertion header is not base64 JSON', reason: 'malformed_headers' }, 400);
  }

  // Verifying here is the entire reason this layer exists. A forged or expired
  // assertion dies on edge compute rather than consuming a database connection,
  // and the merchant and the settlement service both verify again downstream
  // because neither can trust that a proxy in front of it actually looked.
  try {
    await verifyAssertion(assertion, await verificationKey(env), now);
  } catch (error) {
    if (error instanceof AssertionVerificationError) {
      reportRejection(env, {
        publisher_id: assertion.publisher_id || UNKNOWN_PUBLISHER,
        assertion_id: assertion.assertion_id ?? '',
        merchant_id: '',
        reason: error.reason,
        detail: error.message,
      });

      return json({ error: error.message, reason: error.reason }, 401);
    }
    throw error;
  }

  return proxy(request, `${env.MERCHANT_URL}${ROUTE.Purchase}`, body);
}

export default {
  // Two arguments deliberately. Workers calls fetch(request, env, ctx) and
  // handle's third parameter is a clock, so forwarding blindly would pass an
  // execution context where a Date belongs.
  fetch: (request: Request, env: GatewayEnv): Promise<Response> => handle(request, env),
};

// An attempt naming no publisher still deserves a row, so a sentinel keeps the
// count honest rather than dropping the evidence.
const UNKNOWN_PUBLISHER = 'unknown';

export interface RejectionReport {
  publisher_id: string;
  assertion_id: string;
  merchant_id: string;
  reason: string;
  detail: string;
}

/**
 * Journals a refusal the edge made, so a platform that stops an attack records
 * that it happened.
 *
 * Deliberately unawaited and never throwing. The gateway has already decided
 * to refuse, and neither a slow settlement service nor an unreachable one may
 * delay that refusal or turn it into an error the caller could retry against.
 */
function reportRejection(env: GatewayEnv, report: RejectionReport): void {
  if (!env.SETTLEMENT_URL) {
    return;
  }

  void fetch(`${env.SETTLEMENT_URL.replace(/\/+$/, '')}/rejections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  }).catch(() => {
    // A journal that cannot be written must not change what the edge answers.
  });
}
