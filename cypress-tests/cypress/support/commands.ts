import { TestIdAttribute } from './constants/selectors';

Cypress.Commands.add('getByTestId', (testId: string) => {
  return cy.get(`[${TestIdAttribute}="${testId}"]`);
});

// Scopes a lookup to an element already in hand, which the dashboard needs
// because one page renders forty-eight rows carrying identical hook names.
Cypress.Commands.add(
  'findByTestId',
  { prevSubject: 'element' },
  (subject: JQuery<HTMLElement>, testId: string) => {
    return cy.wrap(subject).find(`[${TestIdAttribute}="${testId}"]`);
  }
);
