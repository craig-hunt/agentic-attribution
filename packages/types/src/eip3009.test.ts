import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BASE_SEPOLIA,
  EIP3009_PRIMARY_TYPE,
  EIP3009_TYPES,
  NETWORKS,
  eip712Domain,
  networkParameters,
  toTypedMessage,
} from './index.js';

// The signer and the verifier hash this structure independently. A field
// renamed, reordered, or retyped here produces a signature that recovers to
// the wrong address, which reads as "wrong wallet" and sends whoever is
// debugging it somewhere unrelated to the cause.
test('the typed-data structure matches EIP-3009 exactly', () => {
  assert.equal(EIP3009_PRIMARY_TYPE, 'TransferWithAuthorization');

  assert.deepEqual(EIP3009_TYPES.TransferWithAuthorization, [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ]);
});

// Circle's USDC deployment fixes every one of these. A wrong chain id or a
// wrong verifying contract still produces a valid-looking signature that the
// token contract refuses.
test('Base Sepolia parameters match the deployed USDC contract', () => {
  assert.equal(BASE_SEPOLIA.chainId, 84_532);
  assert.equal(BASE_SEPOLIA.usdcAddress, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  assert.equal(BASE_SEPOLIA.domainName, 'USDC');
  assert.equal(BASE_SEPOLIA.domainVersion, '2');
});

test('the domain is built from the network parameters', () => {
  const domain = eip712Domain('base-sepolia');

  assert.deepEqual(domain, {
    name: 'USDC',
    version: '2',
    chainId: 84_532,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  });
});

test('networkParameters resolves a known network', () => {
  assert.equal(networkParameters('base-sepolia'), BASE_SEPOLIA);
  assert.equal(NETWORKS['base-sepolia'], BASE_SEPOLIA);
});

// An unknown network has to fail loudly and name what it does know. Falling
// back to a default would sign against the wrong chain, and the failure would
// surface as a rejected transfer with no explanation.
test('an unknown network throws and lists what it recognises', () => {
  for (const unknown of ['base', 'mainnet', 'ethereum', '', 'BASE-SEPOLIA']) {
    assert.throws(
      () => networkParameters(unknown),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(unknown) &&
        error.message.includes('base-sepolia'),
      `networkParameters(${JSON.stringify(unknown)}) should throw and name the known networks`,
    );
  }

  assert.throws(() => eip712Domain('base'), /unknown network/);
});

// x402 carries these as decimal strings because JSON has no integer type wide
// enough for uint256. Parsing to Number would silently lose precision above
// 2^53 and corrupt the hash; BigInt is the only safe target.
test('the wire authorization converts to bigints', () => {
  const message = toTypedMessage({
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '129990000',
    validAfter: '0',
    validBefore: '1800000600',
    nonce: `0x${'ab'.repeat(32)}`,
  });

  assert.equal(message.from, '0x1111111111111111111111111111111111111111');
  assert.equal(message.to, '0x2222222222222222222222222222222222222222');
  assert.equal(message.value, 129_990_000n);
  assert.equal(message.validAfter, 0n);
  assert.equal(message.validBefore, 1_800_000_600n);
  assert.equal(message.nonce, `0x${'ab'.repeat(32)}`);

  for (const field of ['value', 'validAfter', 'validBefore'] as const) {
    assert.equal(typeof message[field], 'bigint', `${field} must convert to a bigint`);
  }
});

test('values beyond Number.MAX_SAFE_INTEGER survive intact', () => {
  const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

  const message = toTypedMessage({
    from: '0x1',
    to: '0x2',
    value: huge,
    validAfter: '0',
    validBefore: '9007199254740993',
    nonce: '0x0',
  });

  assert.equal(message.value.toString(), huge);

  // 2^53 + 1, the first integer a double cannot represent. Number() would
  // round it down and hash a different authorization than the one signed.
  assert.equal(message.validBefore.toString(), '9007199254740993');
});

// BigInt is permissive in ways that matter here. An empty string returns 0n
// rather than throwing, so a missing amount would become a signed
// authorization to transfer nothing, and the failure would surface downstream
// at the facilitator's amount check rather than where the field went missing.
test('an unusable amount throws rather than converting quietly', () => {
  for (const bad of ['', '   ', 'not-a-number', '12.5', ' 1 2 ', '-1']) {
    assert.throws(
      () =>
        toTypedMessage({
          from: '0x1',
          to: '0x2',
          value: bad,
          validAfter: '0',
          validBefore: '1',
          nonce: '0x0',
        }),
      `value ${JSON.stringify(bad)} should throw rather than convert`,
    );
  }
});

// A value the type cannot hold encodes to typed data no contract will agree
// with. Every caller here sees a signature that looks valid, and the mismatch
// surfaces on-chain as failed recovery or a revert, pointing nowhere near the
// field that overflowed.
test('a value above the uint256 ceiling throws rather than encoding', () => {
  const maxUint256 = 2n ** 256n - 1n;

  for (const field of ['value', 'validAfter', 'validBefore'] as const) {
    const authorization = {
      from: '0x1',
      to: '0x2',
      value: '1',
      validAfter: '0',
      validBefore: '1',
      nonce: '0x0',
    };

    assert.throws(
      () => toTypedMessage({ ...authorization, [field]: (maxUint256 + 1n).toString() }),
      new RegExp(`${field} exceeds uint256`),
      `${field} accepted a value the type cannot hold`,
    );
  }
});

// The ceiling itself stays valid. Rejecting it would refuse an authorization
// the contract accepts, which is the opposite failure and just as wrong.
test('the largest representable value still converts', () => {
  const maxUint256 = 2n ** 256n - 1n;

  const message = toTypedMessage({
    from: '0x1',
    to: '0x2',
    value: maxUint256.toString(),
    validAfter: '0',
    validBefore: '1',
    nonce: '0x0',
  });

  assert.equal(message.value, maxUint256);
});

// Hex passes through on purpose. x402 specifies decimal strings, and a
// counterparty sending hex means a wide-enough integer either way, so
// rejecting it would break interop for no safety gain.
test('hexadecimal amounts convert rather than throwing', () => {
  const message = toTypedMessage({
    from: '0x1',
    to: '0x2',
    value: '0x1f',
    validAfter: '0',
    validBefore: '1',
    nonce: '0x0',
  });

  assert.equal(message.value, 31n);
});

// The error has to name which field failed. "Cannot convert to a BigInt" with
// no field name sends a reader through six call sites.
test('the error names the field that failed', () => {
  assert.throws(
    () =>
      toTypedMessage({
        from: '0x1',
        to: '0x2',
        value: '100',
        validAfter: 'garbage',
        validBefore: '1',
        nonce: '0x0',
      }),
    (error: unknown) => error instanceof TypeError && error.message.includes('validAfter'),
  );
});

test('zero converts without becoming falsy-adjacent nonsense', () => {
  const message = toTypedMessage({
    from: '0x1',
    to: '0x2',
    value: '0',
    validAfter: '0',
    validBefore: '0',
    nonce: '0x0',
  });

  assert.equal(message.value, 0n);
  assert.equal(message.validAfter, 0n);
  assert.equal(message.validBefore, 0n);
});
