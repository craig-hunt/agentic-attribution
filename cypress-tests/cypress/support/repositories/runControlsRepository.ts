import { RunControlTestIds } from '../constants/selectors';

class RunControlsRepository {
  getPanel(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.Panel);
  }

  getRunOnceButton(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.RunOnce);
  }

  getStartButton(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.Start);
  }

  getStopButton(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.Stop);
  }

  getConcurrencyInput(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.Concurrency);
  }

  getFraudToggle(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.FraudToggle);
  }

  getEventLine(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.Event);
  }

  getMode(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.Mode);
  }

  getSettledCount(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.StatSettled);
  }

  getBlockedCount(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.StatBlocked);
  }

  getFailedCount(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.StatFailed);
  }

  getSettledFilter(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.FilterSettled);
  }

  getBlockedFilter(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.FilterBlocked);
  }

  getFailedFilter(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.FilterFailed);
  }

  getAllFilter(): Cypress.Chainable<JQuery<HTMLElement>> {
    return cy.getByTestId(RunControlTestIds.FilterAll);
  }
}

export default new RunControlsRepository();
