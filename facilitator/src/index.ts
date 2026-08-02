import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  MAX_BODY_BYTES,
  NonceLedger,
  handle,
  type FacilitatorRequest,
} from './handler.js';

// A local stand-in for the Coinbase x402 facilitator, so `docker compose up`
// runs the whole chain with no account, no wallet, and no testnet faucet. It
// verifies EIP-3009 signatures exactly as the real facilitator does and
// simulates only the on-chain transfer. Point X402_FACILITATOR_URL at
// https://x402.org/facilitator to settle for real. See ADR-0007.
//
// This file carries the server and nothing else. Every decision lives in
// handler.ts, which a test can import without something starting to listen.

const DEFAULT_PORT = 8095;

const nonces = new NonceLedger();

async function readJson(req: IncomingMessage): Promise<FacilitatorRequest | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) {
        return null;
      }
      chunks.push(chunk as Buffer);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as FacilitatorRequest;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const body = req.method === 'POST' ? await readJson(req) : null;

    const response = await handle(req.method ?? 'GET', req.url ?? '/', body, {
      nonces,
      onSettled: (record) => {
        console.log(JSON.stringify({ level: 'info', msg: 'settled', ...record }));
      },
    });

    writeJson(res, response.status, response.body);
  })();
});

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const port = Number(process.env['FACILITATOR_PORT']?.trim() || String(DEFAULT_PORT));

server.listen(port, () => {
  console.log(
    JSON.stringify({
      level: 'warn',
      msg: 'mock facilitator listening; no value moves on chain',
      port,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
