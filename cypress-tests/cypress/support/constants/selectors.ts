export const TestIdAttribute = 'data-testid';

// Every element the suite reaches, named once. The application renders these
// from both PHP and from the script that rebuilds rows on each poll, and a
// PHPUnit test asserts both paths emit the same set, so a rename fails there
// before it reaches a spec here.

export const LayoutTestIds = {
  SiteHeader: 'site-header',
  HomeLink: 'home-link',
  PageContent: 'page-content',
} as const;

export const RunControlTestIds = {
  Panel: 'run-controls',
  RunOnce: 'run-once',
  Start: 'run-start',
  Stop: 'run-stop',
  Concurrency: 'concurrency',
  FraudToggle: 'fraud-toggle',
  Event: 'run-event',
  Mode: 'run-mode',
  StatSettled: 'stat-settled',
  StatBlocked: 'stat-blocked',
  StatFailed: 'stat-failed',
  FilterSettled: 'filter-settled',
  FilterBlocked: 'filter-blocked',
  FilterFailed: 'filter-failed',
  FilterAll: 'filter-all',
} as const;

export const PublisherListTestIds = {
  Heading: 'publishers-heading',
  Table: 'publishers-table',
  Rows: 'publisher-rows',
  Row: 'publisher-row',
  Link: 'publisher-link',
  Id: 'publisher-id',
  Settlements: 'publisher-settlements',
  Earned: 'publisher-earned',
  Blocked: 'publisher-blocked',
  Failed: 'publisher-failed',
  CatalogEmpty: 'catalog-empty',
  NoSettlementsHint: 'no-settlements-hint',
  FilterEmpty: 'filter-empty',
  SortName: 'sort-name',
  SortPublisherId: 'sort-publisher-id',
  SortSettlements: 'sort-settlements',
  SortEarned: 'sort-earned',
  SortBlocked: 'sort-blocked',
  SortFailed: 'sort-failed',
} as const;

export const PublisherDetailTestIds = {
  Name: 'publisher-name',
  Id: 'publisher-id',
  SummaryEarned: 'summary-earned',
  SummaryGross: 'summary-gross',
  SummarySettlements: 'summary-settlements',
  SummaryAvgCommission: 'summary-avg-commission',
  SummarySearches: 'summary-searches',
  SummaryAssertions: 'summary-assertions',
  SummaryBlocked: 'summary-blocked',
  SettlementsWrap: 'settlements-wrap',
  SettlementsEmpty: 'settlements-empty',
  SettlementRows: 'settlement-rows',
  SettlementRow: 'settlement-row',
  SettlementProduct: 'settlement-product',
  SettlementMerchant: 'settlement-merchant',
  SettlementGross: 'settlement-gross',
  SettlementRate: 'settlement-rate',
  SettlementEarned: 'settlement-earned',
  SettlementStatus: 'settlement-status',
  SettlementChainLink: 'settlement-chain-link',
  RejectionsWrap: 'rejections-wrap',
  RejectionsEmpty: 'rejections-empty',
  RejectionRows: 'rejection-rows',
  RejectionRow: 'rejection-row',
  RejectionReason: 'rejection-reason',
  RejectionAssertion: 'rejection-assertion',
  RejectionMerchant: 'rejection-merchant',
  RejectionWhen: 'rejection-when',
  SortProduct: 'sort-product',
  SortGross: 'sort-gross',
  SortSettlementEarned: 'sort-settlement-earned',
  SortReason: 'sort-reason',
} as const;

export const ChainTestIds = {
  Heading: 'chain-heading',
  SettlementId: 'chain-settlement-id',
  PublisherLink: 'chain-publisher-link',
  Steps: 'chain-steps',
  StepSearch: 'chain-step-search',
  StepAssertion: 'chain-step-assertion',
  StepProduct: 'chain-step-product',
  StepPayment: 'chain-step-payment',
  StepSplit: 'chain-step-split',
  Query: 'chain-query',
  SearchRequestId: 'chain-search-request-id',
  AssertionId: 'chain-assertion-id',
  ProductTitle: 'chain-product-title',
  ProductId: 'chain-product-id',
  MerchantName: 'chain-merchant-name',
  Gross: 'chain-gross',
  Network: 'chain-network',
  TxHash: 'chain-tx-hash',
  CommissionRate: 'chain-commission-rate',
  CommissionAmount: 'chain-commission-amount',
  PublisherAmount: 'chain-publisher-amount',
  Status: 'chain-status',
  LedgerTable: 'ledger-table',
  LedgerRows: 'ledger-rows',
  LedgerRow: 'ledger-row',
  LedgerAccount: 'ledger-account',
  LedgerParty: 'ledger-party',
  LedgerType: 'ledger-type',
  LedgerAmount: 'ledger-amount',
  LedgerBalance: 'ledger-balance',
  LedgerEmpty: 'ledger-empty',
} as const;

export const ErrorTestIds = {
  Status: 'error-status',
  Message: 'error-message',
  HomeLink: 'error-home-link',
} as const;

// The application marks a row it just rewrote so a reader can see which
// publisher moved. A spec waits on it rather than on a fixed delay.
export const StateClasses = {
  ChangedRow: 'changed',
  ActiveChip: 'on',
  SortAscending: 'asc',
  SortDescending: 'desc',
} as const;

// Read rather than clicked. The dashboard writes the publisher a row belongs
// to onto the row itself, which lets a spec find one row among forty-eight
// without counting positions that a re-sort would invalidate.
export const RowAttributes = {
  Publisher: 'data-publisher',
  Settlement: 'data-settlement',
} as const;
