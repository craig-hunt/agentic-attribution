import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  FAULT,
  MAX_BODY_BYTES,
  type FaultState,
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

/**
 * Fault injection stays off unless a deployment asks for it.
 *
 * The control has no authentication in front of it, and neither does anything
 * else here, so leaving it reachable by default would hand any caller a way to
 * set `unavailable` and stop every settlement on the platform. A regression
 * suite needs it; a demonstration someone is merely running does not.
 *
 * Off means /fault answers 404 rather than answering with a disabled state,
 * because a control that exists and refuses still tells a caller it is there.
 *
 * Injected faults live for the lifetime of the process. A test arms one,
 * asserts, and clears it, which needs no restart and disturbs nothing else.
 */
const faultInjectionEnabled =
  process.env['FACILITATOR_FAULT_INJECTION']?.trim().toLowerCase() === 'true';

const fault: FaultState | undefined = faultInjectionEnabled
  ? { mode: FAULT.None }
  : undefined;

const server = createServer((req, res) => {
  void (async () => {
    // Every failure gets caught here. An unhandled rejection inside this
    // async function terminates the process, so a single malformed request
    // would stop the facilitator and with it every settlement on the
    // platform. Nothing authenticates this endpoint, which makes that one
    // curl command away.
    try {
      const body = req.method === 'POST' ? await readJson(req) : null;

      const response = await handle(req.method ?? 'GET', req.url ?? '/', body, {
        nonces,
        // Passing undefined leaves /fault answering 404, which is the whole
        // mechanism rather than a detail of it.
        ...(fault ? { fault } : {}),
        onSettled: (record) => {
          console.log(JSON.stringify({ level: 'info', msg: 'settled', ...record }));
        },
      });

      writeJson(res, response.status, response.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      console.error(
        JSON.stringify({ level: 'error', msg: 'facilitator request failed', error: message }),
      );

      if (!res.headersSent) {
        writeJson(res, 500, { error: 'facilitator error', reason: 'facilitator_error' });
      }
    }
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
      fault_injection: faultInjectionEnabled,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
