import { HttpStatus, Publishers, Queries, SecurityProbes } from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import driverActions from '../../actions/driverActions';
import { DashboardPaths, dashboardUrl } from '../../constants/routes';

// OWASP A02: Cryptographic Failures.
describe('A02 Cryptographic Failures', () => {
  // The platform signs assertions and never hands out the key that signs them.
  // Settlement holds only the public half, so nothing it can read lets it
  // forge one.
  it('leaks no key material or connection string in any response', () => {
    const probes = [dashboardUrl(DashboardPaths.Publishers), dashboardUrl(DashboardPaths.Health)];

    for (const url of probes) {
      cy.request({ url, failOnStatusCode: false }).then((response) => {
        const body = String(response.body);

        for (const forbidden of SecurityProbes.ForbiddenSubstrings) {
          expect(body).to.not.contain(forbidden);
        }
      });
    }

    driverActions.publisher(Publishers.Demo).then((response) => {
      const body = JSON.stringify(response.body);

      for (const forbidden of SecurityProbes.ForbiddenSubstrings) {
        expect(body).to.not.contain(forbidden);
      }
    });
  });

  it('signs every assertion it issues', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);

      for (const assertion of response.body.assertions) {
        // Scheme-prefixed and long enough to carry an Ed25519 signature. An
        // unsigned assertion would be indistinguishable from one an attacker
        // wrote.
        expect(assertion.signature).to.match(/^ed25519:.+/);
        expect(assertion.signature.length).to.be.greaterThan('ed25519:'.length);
      }
    });
  });

  // Binding the assertion to its search request is what stops one issued for a
  // cheap query being presented against an expensive purchase.
  it('binds every assertion to the search request that produced it', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((response) => {
      for (const assertion of response.body.assertions) {
        expect(assertion.search_request_id).to.equal(response.body.search_request_id);
      }
    });
  });

  it('gives every assertion a bounded lifetime', () => {
    agentActions.search(Queries.Alternate, Publishers.Demo).then((response) => {
      for (const assertion of response.body.assertions) {
        const issued = Date.parse(assertion.issued_at);
        const expires = Date.parse(assertion.expires_at);

        expect(expires).to.be.greaterThan(issued);
        // An assertion without an expiry would earn commission forever once
        // scraped from a response.
        expect(expires).to.be.greaterThan(Date.now());
      }
    });
  });
});
