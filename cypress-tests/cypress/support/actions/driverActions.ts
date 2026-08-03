import { DashboardApiPaths, dashboardApiUrl, publisherApiUrl } from '../constants/routes';
import { RunControls } from '../constants/testData';
import type { DriverStats, PublisherSummaryRow } from '../types/interfaces';

// The dashboard proxies to the driver, which publishes no port of its own.
// Specs reach it the same way a browser does, so nothing here tests a route
// the application does not actually expose.
class DriverActions {
  status(): Cypress.Chainable<Cypress.Response<DriverStats>> {
    return cy.request<DriverStats>({
      url: dashboardApiUrl(DashboardApiPaths.DriverStatus),
      failOnStatusCode: false,
    });
  }

  runOnce(fraudRate: number = 0): Cypress.Chainable<Cypress.Response<DriverStats>> {
    return cy.request<DriverStats>({
      method: 'POST',
      url: dashboardApiUrl(DashboardApiPaths.DriverOnce),
      body: { fraud_rate: fraudRate },
      failOnStatusCode: false,
    });
  }

  runOneFraudAttempt(): Cypress.Chainable<Cypress.Response<DriverStats>> {
    return this.runOnce(RunControls.SingleShotFraudRate);
  }

  start(
    concurrency: number = RunControls.Concurrency,
    fraudRate = 0
  ): Cypress.Chainable<Cypress.Response<DriverStats>> {
    return cy.request<DriverStats>({
      method: 'POST',
      url: dashboardApiUrl(DashboardApiPaths.DriverStart),
      body: { concurrency, fraud_rate: fraudRate },
      failOnStatusCode: false,
    });
  }

  stop(): Cypress.Chainable<Cypress.Response<DriverStats>> {
    return cy.request<DriverStats>({
      method: 'POST',
      url: dashboardApiUrl(DashboardApiPaths.DriverStop),
      failOnStatusCode: false,
    });
  }

  /**
   * Arms or clears a fault in the mock facilitator.
   *
   * Every spec that arms one clears it in an afterEach, because a fault left
   * armed turns every later spec red for a reason none of them describe.
   */
  setFault(mode: string): Cypress.Chainable<Cypress.Response<{ mode: string }>> {
    return cy.request<{ mode: string }>({
      method: 'POST',
      url: dashboardApiUrl(DashboardApiPaths.FacilitatorFault),
      body: { mode },
      failOnStatusCode: false,
    });
  }

  publishers(): Cypress.Chainable<Cypress.Response<{ publishers: PublisherSummaryRow[] }>> {
    return cy.request<{ publishers: PublisherSummaryRow[] }>({
      url: dashboardApiUrl(DashboardApiPaths.Publishers),
      failOnStatusCode: false,
    });
  }

  publisher(publisherId: string): Cypress.Chainable<Cypress.Response<Record<string, unknown>>> {
    return cy.request<Record<string, unknown>>({
      url: publisherApiUrl(publisherId),
      failOnStatusCode: false,
    });
  }
}

export default new DriverActions();
