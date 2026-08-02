import {
  HttpStatus,
  InjectionPayloads,
  Publishers,
  SecurityProbes,
} from '../../constants/testData';
import driverActions from '../../actions/driverActions';
import { publisherUrl, settlementUrl } from '../../constants/routes';

// OWASP A01: Broken Access Control.
//
// This dashboard publishes every publisher's earnings to anyone who asks, by
// design: it demonstrates attribution rather than serving tenants. So the
// checks here assert the boundaries that do exist, namely that an identifier
// cannot be used to reach something outside the data model, and they name the
// absent tenancy rather than pretending to test it.
describe('A01 Broken Access Control', () => {
  it('answers an unknown publisher with not-found rather than another publisher', () => {
    driverActions.publisher(SecurityProbes.UnknownPublisher).then((response) => {
      expect(response.status).to.equal(HttpStatus.NotFound);
      expect(JSON.stringify(response.body)).to.not.contain(Publishers.Demo);
    });
  });

  it('answers an unknown settlement with not-found rather than an empty chain', () => {
    cy.visit(settlementUrl(SecurityProbes.UnknownSettlement), { failOnStatusCode: false });
    cy.contains(String(HttpStatus.NotFound)).should('be.visible');
  });

  // A traversal sequence in a path parameter must stay a lookup key. Reaching
  // the filesystem through it would be the finding.
  it('refuses a path traversal in a publisher identifier', () => {
    for (const payload of [InjectionPayloads.PathTraversal, InjectionPayloads.EncodedTraversal]) {
      cy.request({
        url: publisherUrl(payload),
        failOnStatusCode: false,
      }).then((response) => {
        expect(response.status).to.not.equal(HttpStatus.Ok);
        expect(String(response.body)).to.not.contain('root:');
      });
    }
  });

  it('exposes no publisher data through a settlement identifier', () => {
    driverActions.publisher(SecurityProbes.UnknownSettlement).then((response) => {
      expect(response.status).to.equal(HttpStatus.NotFound);
    });
  });

  // Named rather than tested. Every publisher's figures are public here, and a
  // production deployment serving real publishers would need tenancy before
  // this endpoint could stay as it is. PRODUCTIONALIZING.md records it.
  it('serves any publisher to any caller, which production must scope to a tenant', () => {
    driverActions.publisher(Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
    });
    driverActions.publisher(Publishers.Alternate).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
    });
  });
});
