import { HttpStatus, Publishers, SecurityProbes } from '../../constants/testData';
import driverActions from '../../actions/driverActions';
import { DashboardPaths, dashboardUrl, publisherUrl } from '../../constants/routes';

// OWASP A05: Security Misconfiguration.
describe('A05 Security Misconfiguration', () => {
  // A stack trace tells an attacker the framework, the file layout, and often
  // the query. The dashboard renders its own error page instead.
  it('renders a handled error page rather than a stack trace', () => {
    cy.visit(publisherUrl(SecurityProbes.UnknownPublisher), { failOnStatusCode: false });

    cy.get('body').then((body) => {
      const text = body.text();

      for (const marker of SecurityProbes.StackTraceMarkers) {
        expect(text).to.not.contain(marker);
      }
    });
  });

  it('answers an unknown route with its own not-found page', () => {
    cy.visit(dashboardUrl('/no-such-page'), { failOnStatusCode: false });

    cy.get('body').should('contain.text', String(HttpStatus.NotFound));
    cy.get('body').should('not.contain.text', 'Fatal error');
  });

  it('leaks no upstream detail when an identifier fails to resolve', () => {
    driverActions.publisher(SecurityProbes.UnknownPublisher).then((response) => {
      const body = JSON.stringify(response.body).toLowerCase();

      // A reason a caller can act on, without the SQL that produced it.
      expect(body).to.not.contain('select ');
      expect(body).to.not.contain('pgx');
      expect(body).to.not.contain('sqlstate');
    });
  });

  it('serves no directory listing from the document root', () => {
    cy.request({ url: dashboardUrl('/templates/'), failOnStatusCode: false }).then((response) => {
      expect(response.status).to.not.equal(HttpStatus.Ok);
    });
    cy.request({ url: dashboardUrl('/src/'), failOnStatusCode: false }).then((response) => {
      expect(response.status).to.not.equal(HttpStatus.Ok);
    });
  });

  it('serves application source as something other than readable PHP', () => {
    cy.request({
      url: dashboardUrl('/../src/SettlementClient.php'),
      failOnStatusCode: false,
    }).then((response) => {
      expect(String(response.body)).to.not.contain('<?php');
    });
  });

  it('answers its health endpoint without describing its internals', () => {
    cy.request(dashboardUrl(DashboardPaths.Health)).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);

      const body = JSON.stringify(response.body);
      for (const forbidden of SecurityProbes.ForbiddenSubstrings) {
        expect(body).to.not.contain(forbidden);
      }
    });
  });

  it('sends JSON with a JSON content type rather than guessing', () => {
    driverActions.publisher(Publishers.Demo).then((response) => {
      expect(response.headers['content-type']).to.contain('application/json');
    });
  });
});
