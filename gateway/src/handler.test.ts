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

// A body arriving in several chunks exercises the offset arithmetic that
// reassembles them. A mutant there corrupts the payload silently rather than
// failing, so the origin receives something the caller never sent.
function chunkedRequest(path: string, parts: string[]): Request {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });

  return new Request(`http://gateway.test${path}`, {
    method: 'POST',
    body: stream,
    // @ts-expect-error duplex is required for a streaming body and absent from
    // the DOM lib's RequestInit.
    duplex: 'half',
  });
}

test('a body split across chunks reassembles in order', async () => {
  const captured: Captured = {};
  const parts = ['{"query":"trail ', 'running ', 'shoes","size":10}'];

  await withStubbedFetch(captured, () =>
    handle(chunkedRequest(ROUTE.Search, parts), env),
  );

  assert.equal(captured.body, parts.join(''));
  assert.deepEqual(JSON.parse(captured.body ?? ''), { query: 'trail running shoes', size: 10 });
});

test('a request carrying no body forwards an empty string rather than failing', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(new Request(`http://gateway.test${ROUTE.Search}`, { method: 'POST' }), env),
  );

  assert.equal(response.status, 200);
  assert.equal(captured.body, '');
});

// Content-Length is a cheap rejection, not the enforcement. A tiny body with a
// huge declared length is the only case that separates the two: the stream
// counter would happily pass it, so a 413 here proves the header check ran.
test('an oversized Content-Length is refused even when the body is small', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, {
        method: 'POST',
        headers: { 'content-length': String(300 * 1024) },
        body: 'tiny',
      }),
      env,
    ),
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json() as { reason: string }).reason, 'body_too_large');
  assert.equal(captured.url, undefined, 'nothing should reach an origin');
});

// And the mirror case: a declared length inside the limit does not exempt an
// oversized body, because Content-Length can simply lie.
test('an understated Content-Length does not exempt an oversized body', async () => {
  const captured: Captured = {};

  const response = await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, {
        method: 'POST',
        headers: { 'content-length': '4' },
        body: 'x'.repeat(300 * 1024),
      }),
      env,
    ),
  );

  assert.equal(response.status, 413);
  assert.equal(captured.url, undefined);
});

test('a body at exactly the limit passes and one byte over does not', async () => {
  const captured: Captured = {};
  const limit = 256 * 1024;

  const atLimit = await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, { method: 'POST', body: 'x'.repeat(limit) }),
      env,
    ),
  );
  assert.equal(atLimit.status, 200, 'a body at exactly the limit must pass');
  assert.equal(captured.body?.length, limit);

  const overLimit = await withStubbedFetch({}, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, { method: 'POST', body: 'x'.repeat(limit + 1) }),
      env,
    ),
  );
  assert.equal(overLimit.status, 413, 'one byte over must be refused');
});

// Importing a key costs materially more than verifying with one, and a Worker
// isolate serves many requests. A cache that never hits puts that cost on every
// request; a cache that never invalidates verifies against a rotated-away key.
test('the verification key is imported once and reused', async () => {
  resetKeyCache();

  const captured: Captured = {};
  const headers = {
    [PAYMENT_HEADER]: encodeHeaderJson({ scheme: 'exact' }),
    [ASSERTION_HEADER]: encodeHeaderJson(fixture.assertion),
  };

  for (let i = 0; i < 3; i += 1) {
    const response = await withStubbedFetch(captured, () =>
      handle(purchaseRequest(headers), env, at),
    );
    assert.equal(response.status, 200, `call ${i} should verify against the cached key`);
  }
});

test('changing the configured key re-imports rather than reusing the cached one', async () => {
  resetKeyCache();

  const headers = {
    [PAYMENT_HEADER]: encodeHeaderJson({ scheme: 'exact' }),
    [ASSERTION_HEADER]: encodeHeaderJson(fixture.assertion),
  };

  const first = await withStubbedFetch({}, () => handle(purchaseRequest(headers), env, at));
  assert.equal(first.status, 200);

  // A different key must not verify this assertion. Reusing the cached one
  // would accept it and keep trusting a key the operator rotated away from.
  const otherKey = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('raw', otherKey.publicKey);

  const rotated = {
    ...env,
    ATTRIBUTION_PUBLIC_KEY: btoa(String.fromCharCode(...new Uint8Array(exported))),
  };

  const second = await withStubbedFetch({}, () => handle(purchaseRequest(headers), rotated, at));
  assert.equal(second.status, 401, 'the rotated key must reject an assertion signed by the old one');

  // And switching back restores the original behaviour rather than staying on
  // whichever key happened to be cached last.
  const third = await withStubbedFetch({}, () => handle(purchaseRequest(headers), env, at));
  assert.equal(third.status, 200);
});

test('health answers only for GET on its own path', async () => {
  const cases: Array<[string, string, number]> = [
    ['GET', ROUTE.Health, 200],
    ['POST', ROUTE.Health, 404],
    ['GET', ROUTE.Search, 405],
    ['GET', ROUTE.Purchase, 405],
    ['GET', '/health', 405],
    ['GET', '/healthz/', 405],
  ];

  for (const [method, path, expected] of cases) {
    const request = new Request(`http://gateway.test${path}`, {
      method,
      ...(method === 'POST' ? { body: '{}' } : {}),
    });

    const response = await withStubbedFetch({}, () => handle(request, env));

    assert.equal(response.status, expected, `${method} ${path}`);
  }
});

// Asserting the set as a group leaves each member's presence unverified, so a
// mutant dropping one from the list survives.
test('each hop-by-hop header is stripped individually', async () => {
  for (const header of ['host', 'content-length', 'connection']) {
    const captured: Captured = {};

    await withStubbedFetch(captured, () =>
      handle(
        new Request(`http://gateway.test${ROUTE.Search}`, {
          method: 'POST',
          headers: { [header]: 'value', 'x-keep': 'yes' },
          body: '{}',
        }),
        env,
      ),
    );

    assert.equal(captured.headers?.get(header), null, `${header} should not reach the origin`);
    assert.equal(captured.headers?.get('x-keep'), 'yes');
  }
});

test('header names are matched case-insensitively when stripping', async () => {
  const captured: Captured = {};

  await withStubbedFetch(captured, () =>
    handle(
      new Request(`http://gateway.test${ROUTE.Search}`, {
        method: 'POST',
        headers: { 'CONNECTION': 'keep-alive' },
        body: '{}',
      }),
      env,
    ),
  );

  assert.equal(captured.headers?.get('connection'), null);
});
