import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { handle, type GatewayEnv } from './handler.js';

const HTTP_PAYLOAD_TOO_LARGE = 413;

// Distinguished from every other failure so the catch answers a client error
// rather than a server one. The handler already returns 413 for the same
// condition; without this the Node adapter answered 502 and that path was
// unreachable in this deployment.
class RequestTooLargeError extends Error {}


// The only file in this package that imports a Node built-in. Everything the
// gateway actually does lives in handler.ts against Web standards, and this
// adapter exists solely to let node:http speak Request and Response. Deploying
// to Cloudflare uses wrangler.toml and never loads this file. See ADR-0007.

const DEFAULT_PORT = 8080;
const MAX_BODY_BYTES = 256 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} not set. See docs/RUNNING.md for the local environment.`);
  }

  return value;
}

const env: GatewayEnv = {
  SEARCH_URL: envOr('SEARCH_URL', 'http://localhost:8081'),
  MERCHANT_URL: envOr('MERCHANT_URL', 'http://localhost:8090'),
  SETTLEMENT_URL: envOr('SETTLEMENT_URL', 'http://localhost:8082'),
  ATTRIBUTION_PUBLIC_KEY: requiredEnv('ATTRIBUTION_PUBLIC_KEY'),
};

const port = Number(envOr('GATEWAY_PORT', String(DEFAULT_PORT)));

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }


  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    total += (chunk as Buffer).length;

    if (total > MAX_BODY_BYTES) {
      throw new RequestTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }

    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

function toRequest(req: IncomingMessage, body: Buffer | undefined): Request {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  // node:http gives a path rather than an absolute URL, and the Request
  // constructor requires one. The host comes from the Host header so a request
  // arriving through a proxy keeps the authority the caller addressed.
  const host = req.headers.host ?? `localhost:${port}`;
  const url = new URL(req.url ?? '/', `http://${host}`);

  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });

  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  // Streaming rather than buffering. A search response carrying a hundred
  // products with their offers is large enough that holding it whole in the
  // proxy adds latency for no benefit.
  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    res.write(value);
  }

  res.end();
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const body = await readBody(req);
      const response = await handle(toRequest(req, body), env);

      await writeResponse(response, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      // A caller sending too much data made a bad request rather than finding
      // a broken gateway. Answering 502 tells them the platform failed and
      // invites the retry that would send the same oversized body again.
      const tooLarge = error instanceof RequestTooLargeError;
      const status = tooLarge ? HTTP_PAYLOAD_TOO_LARGE : 502;
      const reason = tooLarge ? 'body_too_large' : 'gateway_error';

      console.error(JSON.stringify({ level: 'error', msg: 'gateway request failed', error: message }));

      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: message, reason }));
    }
  })();
});

server.listen(port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'gateway listening',
      port,
      search_url: env.SEARCH_URL,
      merchant_url: env.MERCHANT_URL,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down' }));

    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close(() => process.exit(0));
  });
}
