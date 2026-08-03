export const EnvKeys = {
  DashboardBaseUrl: 'CYPRESS_DASHBOARD_BASE_URL',
  GatewayBaseUrl: 'CYPRESS_GATEWAY_BASE_URL',
  SettlementBaseUrl: 'CYPRESS_SETTLEMENT_BASE_URL',
} as const;

export const DashboardPaths = {
  Publishers: '/',
  Publisher: '/publishers',
  Settlement: '/settlements',
  Health: '/healthz',
} as const;

// Proxied through the dashboard rather than exposed on the host. The driver
// publishes no port of its own, so this is the only route a browser has to it.
export const DashboardApiPaths = {
  Publishers: '/api/publishers',
  Publisher: '/api/publishers',
  DriverStatus: '/api/driver/status',
  DriverStart: '/api/driver/start',
  DriverStop: '/api/driver/stop',
  DriverOnce: '/api/driver/once',
  FacilitatorFault: '/api/facilitator/fault',
} as const;

export const GatewayPaths = {
  Search: '/search',
  Purchase: '/purchase',
} as const;

export const SettlementPaths = {
  Publishers: '/publishers',
  Settlements: '/settlements',
  Chain: '/chain',
} as const;

export function dashboardUrl(path: string): string {
  return `${Cypress.env(EnvKeys.DashboardBaseUrl)}${path}`;
}

export function publisherUrl(publisherId: string): string {
  return dashboardUrl(`${DashboardPaths.Publisher}/${encodeURIComponent(publisherId)}`);
}

export function settlementUrl(settlementId: string): string {
  return dashboardUrl(`${DashboardPaths.Settlement}/${encodeURIComponent(settlementId)}`);
}

export function dashboardApiUrl(path: string): string {
  return `${Cypress.env(EnvKeys.DashboardBaseUrl)}${path}`;
}

export function publisherApiUrl(publisherId: string): string {
  return dashboardApiUrl(`${DashboardApiPaths.Publisher}/${encodeURIComponent(publisherId)}`);
}

export function gatewayUrl(path: string): string {
  return `${Cypress.env(EnvKeys.GatewayBaseUrl)}${path}`;
}

export function settlementApiUrl(path: string): string {
  return `${Cypress.env(EnvKeys.SettlementBaseUrl)}${path}`;
}

export function settlementChainUrl(settlementId: string): string {
  const path = `${SettlementPaths.Settlements}/${encodeURIComponent(settlementId)}${SettlementPaths.Chain}`;

  return settlementApiUrl(path);
}
