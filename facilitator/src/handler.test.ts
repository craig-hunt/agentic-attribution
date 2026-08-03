import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BASE_SEPOLIA,
  EIP3009_PRIMARY_TYPE,
  EIP3009_TYPES,
  eip712Domain,
  toTypedMessage,
} from '@agentic-attribution/types';
import { privateKeyToAccount } from 'viem/accounts';

import type { VerifyOutcome } from './verify.js';

import {
  NonceLedger,
  ROUTE,
  handle,
  nowSeconds,
  type FacilitatorRequest,
  type SettlementRecord,
  FAULT,
  type FaultState,
} from './handler.js';
import type { WireAuthorization } from './verify.js';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const NETWORK = 'base-sepolia';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const VALUE = '129990000';
const NOW_MS = 1_800_000_000_000;

const clock = () => NOW_MS;

function authorization(overrides: Partial<WireAuthorization> = {}): WireAuthorization {
  const seconds = BigInt(Math.floor(NOW_MS / 1000));

  return {
    from: account.address,
    to: PAY_TO,
    value: VALUE,
    validAfter: String(seconds - 60n),
    validBefore: String(seconds + 600n),
    nonce: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

async function request(auth: WireAuthorization = authorization()): Promise<FacilitatorRequest> {
  const signature = await account.signTypedData({
    domain: eip712Domain(NETWORK),
    types: EIP3009_TYPES,
    primaryType: EIP3009_PRIMARY_TYPE,
    message: toTypedMessage(auth),
  });

  return {
    x402Version: 1,
    paymentPayload: {
      x402Version: 1,
      scheme: 'exact',
      network: NETWORK,
      authorization: auth,
      signature,
    },
    // The requirements stay at the merchant's stated terms rather than
    // echoing the authorization. Deriving them from the payload would make
    // every mismatch test agree with itself and pass for the wrong reason.
    paymentRequirements: {
      scheme: 'exact',
      network: NETWORK,
      asset: BASE_SEPOLIA.usdcAddress,
      maxAmountRequired: VALUE,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      resource: '/purchase/prd_1',
      description: 'Test Listing',
    },
  };
}

function options(nonces = new NonceLedger(), settled: SettlementRecord[] = []) {
  return { nonces, clock, onSettled: (record: SettlementRecord) => settled.push(record) };
}

test('health answers without touching verification', async () => {
  const response = await handle('GET', ROUTE.Health, null, options());

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', mode: 'mock' });
});

test('unknown routes and methods are refused', async () => {
  const cases: Array<[string, string]> = [
    ['GET', ROUTE.Verify],
    ['GET', ROUTE.Settle],
    ['POST', ROUTE.Health],
    ['POST', '/nope'],
    ['DELETE', ROUTE.Settle],
  ];

  for (const [method, path] of cases) {
    const response = await handle(method, path, null, options());

    assert.equal(response.status, 404, `${method} ${path} should be refused`);
  }
});

test('a malformed body is refused before verification', async () => {
  const response = await handle('POST', ROUTE.Settle, null, options());

  assert.equal(response.status, 400);
});

test('verify reports validity without settling anything', async () => {
  const nonces = new NonceLedger();
  const settled: SettlementRecord[] = [];

  const response = await handle('POST', ROUTE.Verify, await request(), options(nonces, settled));

  assert.equal(response.status, 200);
  assert.equal((response.body as { isValid: boolean }).isValid, true);

  // Verify moves no value, so it must not consume the nonce. Consuming it here
  // would make a caller's pre-flight check burn the payment it was checking.
  assert.equal(nonces.size, 0);
  assert.equal(settled.length, 0);
});

test('settle confirms and records the transfer', async () => {
  const nonces = new NonceLedger();
  const settled: SettlementRecord[] = [];

  const response = await handle('POST', ROUTE.Settle, await request(), options(nonces, settled));

  assert.equal(response.status, 200);

  const body = response.body as { success: boolean; transaction: string; payer: string };
  assert.equal(body.success, true);
  assert.match(body.transaction, /^0x[0-9a-f]{64}$/);
  assert.equal(body.payer?.toLowerCase(), account.address.toLowerCase());

  assert.equal(nonces.size, 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0]?.value, VALUE);
});

// The token contract records each nonce and refuses a repeat, so a replayed
// authorization fails rather than transferring twice. A mock that let it
// through would remove one of the demo's two replay defenses.
test('a replayed nonce is refused on the second settle', async () => {
  const nonces = new NonceLedger();
  const payload = await request();

  const first = await handle('POST', ROUTE.Settle, payload, options(nonces));
  assert.equal((first.body as { success: boolean }).success, true);

  const second = await handle('POST', ROUTE.Settle, payload, options(nonces));
  const body = second.body as { success: boolean; errorReason: string };

  assert.equal(second.status, 200);
  assert.equal(body.success, false);
  assert.equal(body.errorReason, 'nonce_already_used');
  assert.equal(nonces.size, 1, 'the replay must not record a second nonce');
});

// A rejected payment is a 200 carrying success:false, matching the real
// facilitator. A non-200 means the facilitator itself failed, and settlement
// treats those two very differently.
test('a rejected payment answers 200 with success false', async () => {
  const underpaying = await request(authorization({ value: '1' }));

  const response = await handle('POST', ROUTE.Settle, underpaying, options());
  const body = response.body as { success: boolean; errorReason: string };

  assert.equal(response.status, 200);
  assert.equal(body.success, false);
  assert.equal(body.errorReason, 'insufficient_amount');
});

test('a rejected payment consumes no nonce', async () => {
  const nonces = new NonceLedger();
  const misdirected = await request(
    authorization({ to: '0x9999999999999999999999999999999999999999' }),
  );

  await handle('POST', ROUTE.Settle, misdirected, options(nonces));

  // Burning the nonce on a rejection would make a corrected retry impossible.
  assert.equal(nonces.size, 0);
});

test('verify surfaces the specific invalid reason', async () => {
  const expired = await request(
    authorization({ validBefore: String(BigInt(Math.floor(NOW_MS / 1000)) - 1n) }),
  );

  const response = await handle('POST', ROUTE.Verify, expired, options());
  const body = response.body as { isValid: boolean; invalidReason: string };

  assert.equal(body.isValid, false);
  assert.equal(body.invalidReason, 'authorization_expired');
});

test('the nonce ledger claims once and reports membership', () => {
  const ledger = new NonceLedger();

  assert.equal(ledger.has('0xabc'), false);
  assert.equal(ledger.claim('0xabc'), true);
  assert.equal(ledger.has('0xabc'), true);
  assert.equal(ledger.claim('0xabc'), false);
  assert.equal(ledger.size, 1);

  assert.equal(ledger.claim('0xdef'), true);
  assert.equal(ledger.size, 2);
});

// Seconds rather than milliseconds. EIP-3009 validity windows are Unix
// seconds, and passing milliseconds would put every authorization roughly
// fifty thousand years in the future.
test('the clock converts milliseconds to seconds', () => {
  assert.equal(nowSeconds(() => 1_800_000_000_000), 1_800_000_000n);
  assert.equal(nowSeconds(() => 1_800_000_000_999), 1_800_000_000n);
  assert.equal(nowSeconds(() => 0), 0n);
});

// A mock that only ever succeeds leaves every failure path untested: no
// settlement ever reaches a failed state, the ledger never proves it writes
// nothing for one, and the dashboard's failed column stays zero while its
// filter claims to work.
test('fault injection stays unavailable unless a deployment opts in', async () => {
  const response = await handle('GET', ROUTE.Fault, null, { nonces: new NonceLedger() });

  assert.equal(response.status, 404);
});

test('an armed fault reports itself on the health endpoint', async () => {
  const fault: FaultState = { mode: FAULT.None };

  await handle('POST', ROUTE.Fault, { mode: FAULT.SettleFails } as never, {
    nonces: new NonceLedger(),
    fault,
  });

  const health = await handle('GET', ROUTE.Health, null, { nonces: new NonceLedger(), fault });

  assert.equal((health.body as { fault: string }).fault, FAULT.SettleFails);
});

test('an unknown fault mode gets refused rather than silently armed', async () => {
  const fault: FaultState = { mode: FAULT.None };

  const response = await handle('POST', ROUTE.Fault, { mode: 'explode' } as never, {
    nonces: new NonceLedger(),
    fault,
  });

  assert.equal(response.status, 400);
  // A mode that failed to arm must leave the previous one in place rather than
  // clearing it, or a typo would quietly disable an injection under test.
  assert.equal(fault.mode, FAULT.None);
});

test('the unavailable fault answers 503 on both verify and settle', async () => {
  const fault: FaultState = { mode: FAULT.Unavailable };

  for (const route of [ROUTE.Verify, ROUTE.Settle]) {
    const response = await handle('POST', route, {} as never, {
      nonces: new NonceLedger(),
      fault,
    });

    assert.equal(response.status, 503, `${route} should report unavailable`);
  }
});

test('the verify fault rejects verification while leaving settlement alone', async () => {
  const fault: FaultState = { mode: FAULT.VerifyRejects };

  const verify = await handle('POST', ROUTE.Verify, {} as never, {
    nonces: new NonceLedger(),
    fault,
  });

  assert.equal(verify.status, 200);
  assert.equal((verify.body as { isValid: boolean }).isValid, false);
});

test('the settle fault reports failure rather than throwing', async () => {
  const fault: FaultState = { mode: FAULT.SettleFails };

  const response = await handle('POST', ROUTE.Settle, {} as never, {
    nonces: new NonceLedger(),
    fault,
  });

  assert.equal(response.status, 200);
  assert.equal((response.body as { success: boolean }).success, false);
});

test('clearing the fault restores ordinary behaviour', async () => {
  const fault: FaultState = { mode: FAULT.Unavailable };

  await handle('POST', ROUTE.Fault, { mode: FAULT.None } as never, {
    nonces: new NonceLedger(),
    fault,
  });

  const health = await handle('GET', ROUTE.Health, null, { nonces: new NonceLedger(), fault });

  assert.equal(health.status, 200);
  assert.equal((health.body as { fault: string }).fault, FAULT.None);
});

// The control carries no authentication, and neither does anything else on
// this platform, so a caller reaching it could set `unavailable` and stop
// every settlement. Absent options.fault it must not exist at all: answering
// with a disabled state would still tell a caller the control is there.
test('every fault route stays absent unless a deployment opts in', async () => {
  for (const method of ['GET', 'POST']) {
    const response = await handle(method, ROUTE.Fault, { mode: FAULT.Unavailable } as never, {
      nonces: new NonceLedger(),
    });

    assert.equal(response.status, 404, `${method} /fault should not exist`);

    // The body matters as much as the status. One naming the control would
    // tell a caller it exists and is merely disabled, which is what gating it
    // was meant to withhold.
    assert.deepEqual(response.body, { error: 'not found' });
  }
});

// Each of these reaches verification outside a try/catch: two through
// sameAddress and one through BigInt. Checking that paymentRequirements was an
// object and stopping there left all three to throw and surface as a 500.
test('requirement fields verification dereferences are refused', async () => {
  const cases: Array<[string, unknown]> = [
    ['asset', undefined],
    ['asset', 42],
    ['payTo', undefined],
    ['maxAmountRequired', undefined],
    ['maxAmountRequired', 'not-a-number'],
    ['maxAmountRequired', '12.5'],
  ];

  for (const [field, value] of cases) {
    const body = await request();
    (body.paymentRequirements as unknown as Record<string, unknown>)[field] = value;

    const response = await handle('POST', ROUTE.Verify, body, options());

    assert.equal(response.status, 400, `${field}=${String(value)} should be refused`);
    assert.equal(
      (response.body as { reason: string }).reason,
      'malformed_request',
      `${field}=${String(value)} should be named a malformed request`,
    );
  }
});

test('verification stays unaffected while injection is off', async () => {
  // Drives a genuine signed request rather than an empty body. An empty one
  // is refused by request validation before injection is ever consulted, so it
  // would pass whether the control was removed or merely hidden.
  const response = await handle('POST', ROUTE.Verify, await request(), {
    nonces: new NonceLedger(),
    clock,
  });

  assert.equal(response.status, 200);
  assert.equal((response.body as VerifyOutcome).isValid, true);
});

// A malformed body reached a dereference and threw, and the throw terminated
// the process rather than answering. Nothing authenticates this endpoint, so
// one curl command stopped every settlement on the platform.
test('a malformed request earns a 400 rather than throwing', async () => {
  const bodies: unknown[] = [
    null,
    {},
    { paymentPayload: null, paymentRequirements: {} },
    { paymentPayload: {}, paymentRequirements: null },
    { paymentPayload: {}, paymentRequirements: {} },
    { paymentPayload: { authorization: null }, paymentRequirements: {} },
  ];

  for (const route of [ROUTE.Verify, ROUTE.Settle]) {
    for (const body of bodies) {
      const response = await handle('POST', route, body as never, { nonces: new NonceLedger() });

      assert.equal(
        response.status,
        400,
        `${route} with ${JSON.stringify(body)} should refuse rather than throw`,
      );
      assert.equal((response.body as { reason: string }).reason, 'malformed_request');
    }
  }
});

test('a malformed request leaks no runtime error', async () => {
  const response = await handle('POST', ROUTE.Verify, {} as never, { nonces: new NonceLedger() });
  const message = (response.body as { error: string }).error;

  assert.ok(!message.includes('Cannot read properties'), `leaked a runtime error: ${message}`);
});
