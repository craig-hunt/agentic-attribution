import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
// Node built-in, so a test enforces it rather than trusting discipline. Walking
// the import graph rather than a directory listing matters twice over: a nested
// module would escape a flat scan, and handler.ts imports from
// @agentic-attribution/types, whose sources live outside this package entirely.
// A node:crypto import added there would break the deployed Worker while a
// gateway-only scan stayed green.
const WORKSPACE_SOURCES: Record<string, URL> = {
  '@agentic-attribution/types': new URL('../../packages/types/src/index.ts', import.meta.url),
};

function resolveImport(specifier: string, fromFile: URL): URL | null {
  const workspace = WORKSPACE_SOURCES[specifier];
  if (workspace) {
    return workspace;
  }

  if (!specifier.startsWith('.')) {
    // A bare specifier that is not a workspace package resolves into
    // node_modules, which no Workers-bound module should reach for anyway and
    // which this test deliberately leaves to the bundler to reject.
    return null;
  }

  // Source files import with a .js extension under NodeNext resolution while
  // the files on disk carry .ts.
  return new URL(specifier.replace(/\.js$/, '.ts'), fromFile);
}

function collectImportGraph(entry: URL): Map<string, string> {
  const sources = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || sources.has(current.pathname)) {
      continue;
    }

    let source: string;
    try {
      source = readFileSync(current, 'utf8');
    } catch {
      continue;
    }

    sources.set(current.pathname, source);

    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }

      const resolved = resolveImport(specifier, current);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }

  return sources;
}

test('nothing reachable from handler.ts imports a Node built-in', () => {
  const graph = collectImportGraph(new URL('./handler.ts', import.meta.url));

  // Guards against a walker that silently resolves nothing and passes by
  // scanning an empty set. handler.ts plus the shared package is the floor.
  assert.ok(
    graph.size >= 2,
    `import graph resolved only ${graph.size} file(s); the walker is not following imports`,
  );

  const reachesSharedPackage = [...graph.keys()].some((path) => path.includes('/packages/types/'));
  assert.ok(reachesSharedPackage, 'the walker never reached @agentic-attribution/types');

  const offenders = [...graph.entries()]
    .filter(([, source]) => /from\s+['"]node:/.test(source) || /require\(['"]node:/.test(source))
    .map(([path]) => path);

  assert.deepEqual(
    offenders,
    [],
    'these files are reachable from handler.ts and import a Node built-in, so the Worker build would fail',
  );
});

// node.ts is the deliberate exception: bridging node:http is its entire
// purpose. Asserting that it does import a built-in keeps the exemption honest,
// because a node.ts that stopped needing Node would mean the adapter is dead
// code rather than that the rule got stricter.
test('the Node adapter is the only file permitted to import node built-ins', () => {
  const adapter = readFileSync(new URL('./node.ts', import.meta.url), 'utf8');

  assert.match(adapter, /from\s+['"]node:http['"]/);
  assert.equal(
    collectImportGraph(new URL('./handler.ts', import.meta.url)).has(
      new URL('./node.ts', import.meta.url).pathname,
    ),
    false,
    'handler.ts must not reach node.ts, or the adapter would ship to Workers',
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

// The Node adapter caps body size, but Workers invokes handler.ts with no
// adapter in front of it, so the limit has to live here or the deployed isolate
// has none at all.
test('an oversized body is refused before any origin is contacted', async () => {
  const captured: Captured = {};
  const oversized = 'x'.repeat(300 * 1024);

  const response = await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, { method: 'POST', body: oversized }),
      env,
    ),
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json() as { reason: string }).reason, 'body_too_large');
  assert.equal(captured.url, undefined, 'an oversized body must never reach an origin');
});

// Content-Length can be absent under chunked encoding and can simply lie, so
// the header check is an optimization rather than the enforcement mechanism.
test('an oversized body is refused even when Content-Length understates it', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, {
        method: 'POST',
        headers: { 'content-length': '10' },
        body: 'x'.repeat(300 * 1024),
      }),
      env,
    ),
  );

  assert.equal(response.status, 413);
  assert.equal(captured.url, undefined);
});

test('a body at the limit still passes through', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, {
        method: 'POST',
        body: 'x'.repeat(1024),
      }),
      env,
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.body?.length, 1024);
});
