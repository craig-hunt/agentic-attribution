// EIP-3009 TransferWithAuthorization. The signer and the verifier must agree on
// every byte of this structure, so it lives in the shared package rather than
// in either one. A domain mismatch produces a signature that recovers to the
// wrong address, which reads as "wrong wallet" and sends you hunting in the
// wrong place entirely.

export const EIP3009_PRIMARY_TYPE = 'TransferWithAuthorization';

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface Eip3009Message {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
}

export interface NetworkParameters {
  chainId: number;
  usdcAddress: `0x${string}`;
  // Circle's deployed USDC uses "USDC" as the EIP-712 domain name and version
  // "2". Both differ across chains and across token deployments, so neither
  // gets hardcoded at the call site.
  domainName: string;
  domainVersion: string;
}

export const BASE_SEPOLIA: NetworkParameters = {
  chainId: 84_532,
  usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  domainName: 'USDC',
  domainVersion: '2',
};

export const NETWORKS: Record<string, NetworkParameters> = {
  'base-sepolia': BASE_SEPOLIA,
};

export function networkParameters(network: string): NetworkParameters {
  const parameters = NETWORKS[network];

  if (!parameters) {
    throw new Error(
      `unknown network ${network}; known networks are ${Object.keys(NETWORKS).join(', ')}`,
    );
  }

  return parameters;
}

export function eip712Domain(network: string): Eip712Domain {
  const parameters = networkParameters(network);

  return {
    name: parameters.domainName,
    version: parameters.domainVersion,
    chainId: parameters.chainId,
    verifyingContract: parameters.usdcAddress,
  };
}

/**
 * Converts the string-typed wire authorization into the bigint-typed message
 * the signer and verifier hash. x402 carries these as decimal strings because
 * JSON has no integer type wide enough for uint256, and losing that distinction
 * to a float would corrupt the hash silently.
 */
export function toTypedMessage(authorization: {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}): Eip3009Message {
  return {
    from: authorization.from as `0x${string}`,
    to: authorization.to as `0x${string}`,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce as `0x${string}`,
  };
}
