import { PublisherDetailTestIds, RowAttributes } from '../constants/selectors';

class PublisherDetailRepository {
  getName(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.Name);
  }

  getEarned(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SummaryEarned);
  }

  getGross(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SummaryGross);
  }

  getSettlementCount(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SummarySettlements);
  }

  getBlockedCount(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SummaryBlocked);
  }

  getAssertionsConsumed(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SummaryAssertions);
  }

  getSettlementRows(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SettlementRow);
  }

  getSettlementRowFor(settlementId: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get(`[${RowAttributes.Settlement}="${settlementId}"]`);
  }

  getSettlementsEmptyNotice(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SettlementsEmpty);
  }

  getFirstSettlementChainLink(): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.getSettlementRows()
      .first()
      .findByTestId(PublisherDetailTestIds.SettlementChainLink);
  }

  getSettlementGrossColumn(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.SettlementGross);
  }

  getRejectionRows(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.RejectionRow);
  }

  getRejectionReasons(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.RejectionReason);
  }

  getRejectionsEmptyNotice(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.RejectionsEmpty);
  }

  getRejectionsWrap(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherDetailTestIds.RejectionsWrap);
  }
}

export default new PublisherDetailRepository();
