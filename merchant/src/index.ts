import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { importVerificationKey } from '@agentic-attribution/types';

import { Catalog } from './catalog.js';
import { loadConfig } from './config.js';
import { HTTP_STATUS, PurchaseHandler, type PurchaseRequest } from './handler.js';
import { SettlementClient } from './settlement.js';
import { X402_HEADER } from './x402.js';

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

// An attempt naming no publisher still deserves a row. Recording it under a
// sentinel keeps the count honest rather than dropping the evidence.
const UNKNOWN_PUBLISHER = 'unknown';

/**
 * Reports a refusal the merchant made, so the platform records attacks it
 * stopped rather than only the ones that reached settlement.
 *
 * A 402 carries no refusal. It opens the payment exchange, and counting it as
 * blocked would report every ordinary purchase as an attack.
 */
async function reportRefusal(
  result: { status: number; body: unknown },
  headers: Record<string, string | undefined>
): Promise<void> {
  if (result.status < HTTP_STATUS.BadRequest || result.status === HTTP_STATUS.PaymentRequired) {
    return;
  }

  const body = result.body as { reason?: string; error?: string } | undefined;
  const reason = body?.reason;
  if (!reason) {
    return;
  }

  // The publisher named on the attempt, which for a tampered assertion is
  // whoever the attacker tried to redirect payment to. That is the row worth
  // keeping: an attempt naming a publisher who does not exist is itself the
  // signal, which is why the table carries no foreign key.
  const assertion = decodeAssertionForReporting(headers);

  await settlement.reportRejection({
    publisher_id: assertion?.publisher_id ?? UNKNOWN_PUBLISHER,
    assertion_id: assertion?.assertion_id ?? '',
    merchant_id: config.merchantId,
    reason,
    detail: body?.error ?? '',
  });
}

// Best effort by design. The header already failed verification, so parsing it
// is an attempt to attribute the refusal rather than a trusted read.
function decodeAssertionForReporting(
  headers: Record<string, string | undefined>
): { publisher_id?: string; assertion_id?: string } | null {
  const raw = headers[X402_HEADER.AttributionAssertion];
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString()) as {
      publisher_id?: string;
      assertion_id?: string;
    };
  } catch {
    return null;
  }
}

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
      const headers = req.headers as Record<string, string | undefined>;
      const result = await handler.handle(body, headers);

      writeJson(res, result.status, result.body, result.headers);

      // Journalled from one place rather than at every return inside the
      // handler, so a refusal added later reports without anyone remembering
      // to wire it. Not awaited: the response has already gone out, and the
      // record must never delay or alter it.
      void reportRefusal(result, headers);
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
