import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { importVerificationKey } from '@agentic-attribution/types';

import { Catalog } from './catalog.js';
import { loadConfig } from './config.js';
import { HTTP_STATUS, PurchaseHandler, type PurchaseRequest } from './handler.js';
import { SettlementClient } from './settlement.js';

const MAX_BODY_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    total += (chunk as Buffer).length;

    if (total > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }

    chunks.push(chunk as Buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const config = loadConfig();
const catalog = new Catalog(config.postgresDsn, config.merchantId);
const settlement = new SettlementClient(config.settlementUrl);

// Imported once at startup. importKey costs more than a verify does, so doing
// it per request would put avoidable work on the payment path.
const verificationKey = await importVerificationKey(config.publicKey);
const handler = new PurchaseHandler(config, catalog, settlement, verificationKey);

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/healthz') {
      writeJson(res, HTTP_STATUS.Ok, { status: 'ok', merchant_id: config.merchantId });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/purchase') {
      writeJson(res, HTTP_STATUS.NotFound, { error: 'not found' });
      return;
    }

    try {
      const body = await readJsonBody<PurchaseRequest>(req);
      const result = await handler.handle(body, req.headers as Record<string, string | undefined>);

      writeJson(res, result.status, result.body, result.headers);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      console.error(JSON.stringify({ level: 'error', msg: 'purchase failed', error: message }));
      writeJson(res, HTTP_STATUS.BadGateway, { error: message, reason: 'merchant_error' });
    }
  })();
});

server.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'merchant listening',
      port: config.port,
      merchant_id: config.merchantId,
      network: config.network,
      settlement_url: config.settlementUrl,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down' }));

    // The pool closes after the server stops accepting, so a purchase already
    // reading its listing finishes rather than failing on a dead connection.
    const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close(() => {
      void catalog.close().then(() => process.exit(0));
    });
  });
}
