import { PublisherListTestIds, RowAttributes } from '../constants/selectors';

class PublisherListRepository {
  getHeading(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.Heading);
  }

  getTable(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.Table);
  }

  getRows(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.Row);
  }

  // The dashboard writes the publisher onto its own row, so a spec reaches one
  // row among forty-eight without counting positions a re-sort would move.
  getRowFor(publisherId: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.get(`[${RowAttributes.Publisher}="${publisherId}"]`);
  }

  getEarnedFor(publisherId: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.getRowFor(publisherId).findByTestId(PublisherListTestIds.Earned);
  }

  getSettlementsFor(publisherId: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.getRowFor(publisherId).findByTestId(PublisherListTestIds.Settlements);
  }

  getBlockedFor(publisherId: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.getRowFor(publisherId).findByTestId(PublisherListTestIds.Blocked);
  }

  getFailedFor(publisherId: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.getRowFor(publisherId).findByTestId(PublisherListTestIds.Failed);
  }

  getLinkFor(publisherId: string): Cypress.Chainable<JQuery<HTMLElement>> {
    return this.getRowFor(publisherId).findByTestId(PublisherListTestIds.Link);
  }

  getEarnedColumn(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.Earned);
  }

  getBlockedColumn(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.Blocked);
  }

  getEarnedHeader(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.SortEarned);
  }

  getNameHeader(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.SortName);
  }

  getBlockedHeader(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.SortBlocked);
  }

  getFilterEmptyNotice(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(PublisherListTestIds.FilterEmpty);
  }
}

export default new PublisherListRepository();
