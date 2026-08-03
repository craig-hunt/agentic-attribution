// The generator produces these identifiers from a fixed seed, so a run against
// a freshly seeded catalog finds them every time. `make seed` with a different
// CANONICAL_PRODUCTS still produces publishers numbered from zero.
export const Publishers = {
  First: 'pub_000000',
  Demo: 'pub_000001',
  Alternate: 'pub_000007',
  // Never generated. The platform has to refuse an assertion naming it.
  Attacker: 'pub_999999',
} as const;

export const Queries = {
  Default: 'trail running shoes',
  Alternate: 'waterproof hiking pack',
  // Matches nothing in a catalog built from outdoor and kitchen vocabulary.
  Unmatchable: 'zzzz nonexistent product zzzz',
} as const;

export const SearchDefaults = {
  Size: 10,
} as const;

// Counts the dashboard shows on a catalog seeded at defaults. Asserted as
// lower bounds rather than equalities, because a live population keeps adding
// settlements while a spec runs.
export const CatalogCounts = {
  Publishers: 48,
  MinimumSearchResults: 1,
} as const;

export const RunControls = {
  // Below the dashboard's own ceiling of 24, and low enough that a laptop
  // running OpenSearch alongside stays responsive.
  Concurrency: 4,
  // A single click sends fraud every time when the toggle is on, so a spec
  // asserting one blocked attempt gets exactly one.
  SingleShotFraudRate: 1,
  // The dashboard clamps what a caller may ask the driver for. Mirrored here
  // so a spec asserts the documented ceiling rather than a number it invented.
  MaxConcurrency: 24,
  MaxFraudRate: 1,
  AbsurdConcurrency: 10_000,
  AbsurdFraudRate: 99,
} as const;

export const Timings = {
  // The search service publishes its own latency alongside the results, and
  // ADR-0002 puts hybrid retrieval well inside this. A regression that doubles
  // query time still passes a default assertion timeout, so the budget has to
  // be asserted explicitly.
  SearchLatencyBudgetMs: 1_000,
  // The dashboard polls on this interval, so a spec waiting for a live update
  // allows two cycles before calling it a failure.
  PollIntervalMs: 1_500,
  PollCycles: 2,
} as const;

export const Money = {
  Zero: '$0.00',
  ZeroCents: 0,
} as const;

// Reasons the settlement service answers with. A spec asserts the specific one
// rather than merely that something got refused, because a tampered signature
// caught by an expiry check would mean the wrong control fired.
// The merchant verifies an assertion before it forwards anything, so a
// tampered or expired one never reaches settlement. The two layers name the
// same refusal differently, which is worth knowing when reading logs: the
// TypeScript verifier in packages/types answers with these.
export const MerchantRejectionReasons = {
  MalformedPayment: 'malformed_payment',
  MalformedHeaders: 'malformed_headers',
  ProductMismatch: 'assertion_product_mismatch',
  PayeeMismatch: 'payee_mismatch',
  AmountMismatch: 'amount_mismatch',
} as const;

// Payloads that decode as JSON but carry the wrong shape. A cast cannot catch
// these, so the merchant validates before it dereferences.
export const MalformedPayments = {
  Empty: {},
  NoAuthorization: { x402Version: 1, scheme: 'exact', network: 'base-sepolia', signature: '0x' },
  EmptyAuthorization: { authorization: {}, signature: '0x' },
  NoSignature: {
    x402Version: 1,
    scheme: 'exact',
    network: 'base-sepolia',
    authorization: {
      from: '0x1',
      to: '0x2',
      value: '1',
      validAfter: '0',
      validBefore: '99999999999',
      nonce: '0x0',
    },
  },
} as const;

// The gateway's own refusals, answered before any service downstream sees the
// request.
export const GatewayRejectionReasons = {
  BodyTooLarge: 'body_too_large',
  AssertionMissing: 'assertion_missing',
  MalformedHeaders: 'malformed_headers',
} as const;

export const EdgeRejectionReasons = {
  SignatureInvalid: 'invalid_signature',
  Expired: 'expired',
  AssertionMissing: 'assertion_missing',
  ProductMismatch: 'assertion_product_mismatch',
  MalformedHeaders: 'malformed_headers',
} as const;

// The Go settlement service answers with these. Only a refusal the merchant
// let through reaches them, which in practice means replay and payment.
export const SettlementRejectionReasons = {
  SignatureInvalid: 'assertion_signature_invalid',
  Expired: 'assertion_expired',
  Reused: 'assertion_reused',
  PaymentInvalid: 'payment_invalid',
} as const;

// Every reason either layer can answer with, for a spec asserting that a
// refusal names something an operator can act on rather than nothing.
export const AllRejectionReasons = [
  ...Object.values(GatewayRejectionReasons),
  ...Object.values(EdgeRejectionReasons),
  ...Object.values(MerchantRejectionReasons),
  ...Object.values(SettlementRejectionReasons),
] as const;

// Faults the mock facilitator can be told to inject, so the platform's failure
// handling gets exercised rather than assumed.
export const Faults = {
  None: 'none',
  VerifyRejects: 'verify_rejects',
  SettleFails: 'settle_fails',
  Unavailable: 'unavailable',
} as const;

// The gateway accepts 256KB. A spec has to exceed that rather than guess at a
// figure that merely looks large.
export const BodyLimits = {
  GatewayMaxBytes: 262_144,
  OversizedQueryChars: 300_000,
} as const;

export const HttpStatus = {
  Ok: 200,
  BadRequest: 400,
  PayloadTooLarge: 413,
  Unprocessable: 422,
  BadGateway: 502,
  PaymentRequired: 402,
  Unauthorized: 401,
  Conflict: 409,
  NotFound: 404,
} as const;

export const SettlementStatus = {
  Confirmed: 'confirmed',
} as const;

export const LedgerAccounts = {
  MerchantPayable: 'merchant_payable',
  PlatformRevenue: 'platform_revenue',
  PublisherPayable: 'publisher_payable',
} as const;

export const LedgerCounts = {
  // A merchant debit offsetting a platform credit and a publisher credit.
  EntriesPerSettlement: 3,
} as const;

// Basis points convert to a percentage the page renders to two decimals.
export const BasisPoints = {
  PerPercent: 100,
  Divisor: 10_000,
} as const;

// Fields a tampered assertion rewrites, and what it rewrites them to.
export const Tampering = {
  InflatedCommissionBps: 9_999,
  ForgedSignaturePrefix: 'ed25519:',
  ForgedSignatureBody: 'A'.repeat(86),
  ForgedSignaturePadding: '==',
  ExpiredHoursAgo: 2,
  IssuedHoursAgo: 3,
} as const;

export const MillisecondsPerHour = 3_600_000;

// The EIP-712 domain, declared here rather than imported from packages/types.
// A suite sharing its protocol definitions with the code under test stops
// noticing when that code drifts, which is the same reason cmd/fixture mints a
// Go-signed vector for the TypeScript suite to verify independently.
export const BaseSepolia = {
  Network: 'base-sepolia',
  ChainId: 84_532,
  UsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  DomainName: 'USDC',
  DomainVersion: '2',
} as const;

export const Eip3009 = {
  PrimaryType: 'TransferWithAuthorization',
  Types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
} as const;

export const X402Headers = {
  PaymentSignature: 'payment-signature',
  AttributionAssertion: 'x-attribution-assertion',
} as const;

export const X402 = {
  Version: 1,
  Scheme: 'exact',
  // Wide enough that a slow suite never signs an authorization that expires
  // before the facilitator sees it.
  ValidityWindowSeconds: 600,
} as const;

// Payloads for the OWASP checks. Named so a spec reads as the attack it
// performs rather than as a wall of escaped punctuation.
export const InjectionPayloads = {
  SqlComment: "pub_000001'--",
  SqlTautology: "' OR '1'='1",
  SqlUnion: "' UNION SELECT null,null,null--",
  SqlDrop: "'; DROP TABLE settlements;--",
  ScriptTag: '<script>window.__xss=1</script>',
  ImageOnError: '<img src=x onerror="window.__xss=1">',
  PathTraversal: '../../../etc/passwd',
  EncodedTraversal: '..%2f..%2f..%2fetc%2fpasswd',
  NullByte: 'pub_000001%00',
} as const;

export const SecurityProbes = {
  // Reached by an identifier that is well-formed but belongs to nobody.
  UnknownPublisher: 'pub_000042424242',
  UnknownSettlement: '00000000-0000-0000-0000-000000000000',
  // Strings that must never appear in any response body.
  ForbiddenSubstrings: [
    'ATTRIBUTION_PRIVATE_KEY',
    'POSTGRES_DSN',
    'BEGIN PRIVATE KEY',
    'password=',
  ],
  // Framework and language traces a verbose error would leak.
  StackTraceMarkers: ['Stack trace:', '#0 /', 'goroutine ', '.php on line', 'node_modules'],
} as const;

export const XssProbe = {
  // The dashboard escapes on output. If it stopped, this global would be set
  // by markup that arrived as data.
  GlobalFlag: '__xss',
} as const;
