// Start/stop control over a live agent population, so the demonstration runs
// from a browser rather than from a terminal.
//
// The endpoints carry no authentication, which is acceptable for a service
// that binds inside the compose network on a local machine and unacceptable
// anywhere else. Nothing publishes this port beyond the host, and exposing it
// would hand an anonymous caller a load generator pointed at the platform.
// Deploying this anywhere real needs authentication first.

import { createServer } from 'node:http';

import { Runner } from './runner.js';

const DEFAULT_PORT = 8096;
const DEFAULT_GATEWAY = 'http://gateway:8080';
const DEFAULT_SETTLEMENT = 'http://settlement:8082';

// A fixed pool. Query embedding caches on the text hash, so reusing a small
// set keeps inference off the hot path and lets throughput reflect the rest of
// the system rather than the model.
const QUERIES = [
  'trail running shoes',
  'waterproof hiking pack',
  'cast iron skillet',
  'insulated water bottle',
  'merino wool socks',
  'ultralight tent',
  'noise cancelling headphones',
  'espresso grinder',
];

const port = Number(process.env.DRIVER_PORT?.trim() || DEFAULT_PORT);
const gatewayUrl = process.env.GATEWAY_URL?.trim() || DEFAULT_GATEWAY;
const settlementUrl = process.env.SETTLEMENT_URL?.trim() || DEFAULT_SETTLEMENT;

const runner = new Runner({ gatewayUrl, queries: QUERIES });

/**
 * Publishers come from the settlement service rather than a hard-coded list,
 * because a generated catalog names them and a list here would drift out of
 * step with whatever got seeded.
 */
async function loadPublishers(): Promise<string[]> {
  const response = await fetch(`${settlementUrl}/publishers`);
  if (!response.ok) {
    throw new Error(`GET /publishers returned ${response.status}`);
  }

  const body = (await response.json()) as { publishers: Array<{ publisher_id: string }> };

  return body.publishers.map((publisher) => publisher.publisher_id);
}

let publishersLoaded = false;

async function ensurePublishers(): Promise<void> {
  if (publishersLoaded) {
    return;
  }

  const ids = await loadPublishers();
  if (ids.length === 0) {
    throw new Error('no publishers in the catalog; run make seed first');
  }

  runner.setPublishers(ids);
  publishersLoaded = true;
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);

  if (request.method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    json(response, 200, runner.stats);
    return;
  }

  if (request.method === 'POST' && (url.pathname === '/start' || url.pathname === '/once')) {
    const body = await readBody(request);

    try {
      await ensurePublishers();
    } catch (error) {
      json(response, 503, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    // Built key by key because exactOptionalPropertyTypes rejects an explicit
    // undefined, and an absent field has to mean "leave it as it was" so a
    // caller can change fraud rate without resetting concurrency.
    const patch: { concurrency?: number; fraudRate?: number } = {};
    const concurrency = numberOr(body.concurrency);
    const fraudRate = numberOr(body.fraud_rate);
    if (concurrency !== undefined) {
      patch.concurrency = concurrency;
    }
    if (fraudRate !== undefined) {
      patch.fraudRate = fraudRate;
    }

    if (url.pathname === '/once') {
      runner.configure(patch);
      // Awaited so the caller's next status poll already reflects the result,
      // which matters when someone clicks once and expects a row to appear.
      await runner.runOnce();
      json(response, 200, runner.stats);
      return;
    }

    runner.start(patch);
    json(response, 200, runner.stats);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/stop') {
    runner.stop();
    json(response, 200, runner.stats);
    return;
  }

  json(response, 404, { error: 'not found' });
});

function numberOr(value: unknown): number | undefined {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

server.listen(port, () => {
  console.log(`driver listening on :${port}, gateway ${gatewayUrl}`);
});
