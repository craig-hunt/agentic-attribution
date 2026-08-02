import { ChainTestIds } from '../constants/selectors';

class ChainRepository {
  getSettlementId(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.SettlementId);
  }

  getSteps(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.Steps);
  }

  getQuery(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.Query);
  }

  getSearchRequestId(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.SearchRequestId);
  }

  getAssertionId(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.AssertionId);
  }

  getProductTitle(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.ProductTitle);
  }

  getMerchantName(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.MerchantName);
  }

  getGross(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.Gross);
  }

  getNetwork(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.Network);
  }

  getTransactionHash(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.TxHash);
  }

  getCommissionRate(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.CommissionRate);
  }

  getCommissionAmount(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.CommissionAmount);
  }

  getPublisherAmount(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.PublisherAmount);
  }

  getStatus(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.Status);
  }

  getPublisherLink(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.PublisherLink);
  }

  getLedgerRows(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.LedgerRow);
  }

  getLedgerAccounts(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.LedgerAccount);
  }

  getLedgerAmounts(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.LedgerAmount);
  }

  getLedgerBalance(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(ChainTestIds.LedgerBalance);
  }
}

export default new ChainRepository();
