import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import type { AttributionAssertion } from '@agentic-attribution/types';

import {
  ASSERTION_HEADER,
  PAYMENT_HEADER,
  ROUTE,
  handle,
  resetKeyCache,
  type GatewayEnv,
} from './handler.js';

interface Fixture {
  public_key: string;
  verify_at: string;
  expired_at: string;
  assertion: AttributionAssertion;
}

const fixture: Fixture = JSON.parse(
  readFileSync(
    new URL('../../packages/types/src/__fixtures__/go-minted-assertion.json', import.meta.url),
    'utf8',
  ),
);

const SEARCH_URL = 'http://search.test';
const MERCHANT_URL = 'http://merchant.test';

const env: GatewayEnv = {
  SEARCH_URL,
  MERCHANT_URL,
  ATTRIBUTION_PUBLIC_KEY: fixture.public_key,
};

interface Captured {
  url?: string;
  method?: string;
  headers?: Headers;
  body?: string;
}

// The gateway's job is to reject or forward, so the tests assert on what
// reached the origin as much as on what came back to the caller.
function stubFetch(
  captured: Captured,
  response: Response = new Response('{"ok":true}', { status: 200 }),
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = typeof input === 'string' ? input : input.toString();
    captured.method = init?.method;
    captured.headers = new Headers(init?.headers);
    captured.body = typeof init?.body === 'string' ? init.body : undefined;

    return response;
  }) as typeof globalThis.fetch;
}

function encodeHeaderJson(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

function purchaseRequest(headers: Record<string, string> = {}): Request {
  return new Request(`http://gateway.test${ROUTE.Purchase}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ product_id: fixture.assertion.product_id }),
  });
}

// Pinned to a moment inside the fixture's one-hour window. Reading the wall
// clock would make these tests pass before 13:00Z on the fixture's date and
// fail forever after, which is the worst kind of flake.
const at = new Date(fixture.verify_at);

const originalFetch = globalThis.fetch;

function withStubbedFetch<T>(captured: Captured, fn: () => Promise<T>, response?: Response): Promise<T> {
  globalThis.fetch = response ? stubFetch(captured, response) : stubFetch(captured);

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

// The portability claim in ADR-0007 rests entirely on handler.ts importing no
// Node built-in. Discipline alone would not survive the first deadline, so a
// test enforces it. node.ts is exempt: bridging node:http is its whole purpose.
test('handler.ts and its dependencies import no Node built-in', () => {
  const sourceDir = new URL('.', import.meta.url);
  const exempt = new Set(['node.ts']);

  const offenders: string[] = [];

  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || exempt.has(file)) {
      continue;
    }

    const source = readFileSync(new URL(file, sourceDir), 'utf8');

    if (/from\s+['"]node:/.test(source) || /require\(['"]node:/.test(source)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these files import a Node built-in and would fail to deploy to Workers',
  );
});

test('health check answers without touching an origin', async () => {
  const response = await handle(
    new Request(`http://gateway.test${ROUTE.Health}`, { method: 'GET' }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('search forwards to the search origin', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, {
        method: 'POST',
        body: JSON.stringify({ query: 'running shoes' }),
      }),
      env,
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.url, `${SEARCH_URL}${ROUTE.Search}`);
  assert.equal(captured.body, JSON.stringify({ query: 'running shoes' }));
});

// The first half of the 402 exchange carries no assertion to check, so
// forwarding it unverified is correct rather than a gap.
test('a purchase without payment forwards unverified to the merchant', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(
    captured,
    () => handle(purchaseRequest(), env),
    new Response(JSON.stringify({ x402Version: 1, accepts: [] }), { status: 402 }),
  );

  assert.equal(response.status, 402);
  assert.equal(captured.url, `${MERCHANT_URL}${ROUTE.Purchase}`);
});

test('a valid assertion with payment reaches the merchant intact', async () => {
  resetKeyCache();
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(
      purchaseRequest({
        [PAYMENT_HEADER]: encodeHeaderJson({ scheme: 'exact' }),
        [ASSERTION_HEADER]: encodeHeaderJson(fixture.assertion),
      }),
      env,
      at,
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.url, `${MERCHANT_URL}${ROUTE.Purchase}`);
  assert.equal(
    captured.headers?.get(ASSERTION_HEADER),
    encodeHeaderJson(fixture.assertion),
    'the assertion must reach the merchant unchanged so it can verify independently',
  );
});

test('a tampered assertion dies at the edge without reaching any origin', async () => {
  resetKeyCache();
  const captured: Captured = {};
  const forged = { ...fixture.assertion, commission_bps: 9_999 };

  const response = await withStubbedFetch(captured, () =>
    handle(
      purchaseRequest({
        [PAYMENT_HEADER]: encodeHeaderJson({ scheme: 'exact' }),
        [ASSERTION_HEADER]: encodeHeaderJson(forged),
      }),
      env,
      at,
    ),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json() as { reason: string }).reason, 'invalid_signature');
  assert.equal(captured.url, undefined, 'no origin should have been contacted');
});

test('payment without an assertion is rejected at the edge', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(purchaseRequest({ [PAYMENT_HEADER]: encodeHeaderJson({ scheme: 'exact' }) }), env),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { reason: string }).reason, 'assertion_missing');
  assert.equal(captured.url, undefined);
});

test('a malformed assertion header is rejected without throwing', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(
      purchaseRequest({
        [PAYMENT_HEADER]: encodeHeaderJson({ scheme: 'exact' }),
        [ASSERTION_HEADER]: 'not-base64-json',
      }),
      env,
    ),
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { reason: string }).reason, 'malformed_headers');
  assert.equal(captured.url, undefined);
});

// The gateway forwards an origin's verdict rather than reinterpreting it. Two
// components deciding what a 409 means is two chances to disagree.
test('an origin rejection passes through with its status intact', async () => {
  resetKeyCache();
  const captured: Captured = {};

  const response = await withStubbedFetch(
    captured,
    () =>
      handle(
        purchaseRequest({
          [PAYMENT_HEADER]: encodeHeaderJson({ scheme: 'exact' }),
          [ASSERTION_HEADER]: encodeHeaderJson(fixture.assertion),
        }),
        env,
        at,
      ),
    new Response(JSON.stringify({ reason: 'assertion_reused' }), { status: 409 }),
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { reason: string }).reason, 'assertion_reused');
});

test('an unknown path returns 404 without contacting an origin', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(new Request('http://gateway.test/nope', { method: 'POST', body: '{}' }), env),
  );

  assert.equal(response.status, 404);
  assert.equal(captured.url, undefined);
});

test('hop-by-hop headers are not forwarded to the origin', async () => {
  const captured: Captured = {};

  await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, {
        method: 'POST',
        headers: { connection: 'keep-alive', 'x-keep-me': 'yes' },
        body: '{}',
      }),
      env,
    ),
  );

  assert.equal(captured.headers?.get('connection'), null);
  assert.equal(captured.headers?.get('host'), null);
  assert.equal(captured.headers?.get('x-keep-me'), 'yes');
});
