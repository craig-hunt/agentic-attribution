import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  simulatedTransactionHash,
  verifyPayment,
  type WirePaymentPayload,
  type WirePaymentRequirements,
} from './verify.js';

// A local stand-in for the Coinbase x402 facilitator, so `docker compose up`
// runs the whole chain with no account, no wallet, and no testnet faucet. It
// verifies EIP-3009 signatures exactly as the real facilitator does and
// simulates only the on-chain transfer. Point X402_FACILITATOR_URL at
// https://x402.org/facilitator to settle for real. See ADR-0007.

const DEFAULT_PORT = 8095;
const MAX_BODY_BYTES = 64 * 1024;

interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: WirePaymentPayload;
  paymentRequirements: WirePaymentRequirements;
}

// Nonces are single-use on chain: the token contract records each one and
// rejects a repeat. Holding them in memory reproduces that here, which matters
// because the settlement service's replay defense guards the assertion while
// this guards the payment, and the demo should show both refusing a replay.
const consumedNonces = new Set<string>();

async function readJson<T>(req: IncomingMessage): Promise<T> {
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/healthz') {
      writeJson(res, 200, { status: 'ok', mode: 'mock' });
      return;
    }

    if (req.method !== 'POST' || (req.url !== '/verify' && req.url !== '/settle')) {
      writeJson(res, 404, { error: 'not found' });
      return;
    }

    let body: FacilitatorRequest;
    try {
      body = await readJson<FacilitatorRequest>(req);
    } catch {
      writeJson(res, 400, { error: 'malformed request body' });
      return;
    }

    const outcome = await verifyPayment(
      body.paymentPayload,
      body.paymentRequirements,
      nowSeconds(),
    );

    if (req.url === '/verify') {
      writeJson(res, 200, outcome);
      return;
    }

    if (!outcome.isValid) {
      // A rejected payment is a 200 carrying success:false, matching the real
      // facilitator. A non-200 means the facilitator itself failed, and the
      // settlement service treats those two cases very differently.
      writeJson(res, 200, { success: false, errorReason: outcome.invalidReason });
      return;
    }

    const nonce = body.paymentPayload.authorization.nonce;
    if (consumedNonces.has(nonce)) {
      writeJson(res, 200, { success: false, errorReason: 'nonce_already_used' });
      return;
    }
    consumedNonces.add(nonce);

    const transaction = simulatedTransactionHash(body.paymentPayload.authorization);

    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'settled',
        payer: outcome.payer,
        to: body.paymentPayload.authorization.to,
        value: body.paymentPayload.authorization.value,
        transaction,
      }),
    );

    writeJson(res, 200, {
      success: true,
      transaction,
      network: body.paymentPayload.network,
      payer: outcome.payer,
    });
  })();
});

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
