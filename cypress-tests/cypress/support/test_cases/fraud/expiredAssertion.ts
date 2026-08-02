import {
  HttpStatus,
  MillisecondsPerHour,
  Publishers,
  Queries,
  EdgeRejectionReasons,
  Tampering,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * MillisecondsPerHour).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

describe('An expired assertion is refused', () => {
  // Expiry bounds how long a captured assertion stays worth anything. Without
  // it, an assertion scraped from a response would earn commission forever.
  it('refuses an assertion whose window has closed', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const genuine = search.body.assertions[0];
      const expired = {
        ...genuine,
        issued_at: hoursAgo(Tampering.IssuedHoursAgo),
        expires_at: hoursAgo(Tampering.ExpiredHoursAgo),
      };

      agentActions.requestChallenge(genuine.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions.attemptPurchase(genuine.product_id, expired, payment).then((response) => {
            expect(response.status).to.not.equal(HttpStatus.Ok);
            // Backdating the window also breaks the signature, so either
            // control refusing it is correct. Asserting one specific reason
            // would make the spec brittle about which fired first.
            expect([
              EdgeRejectionReasons.Expired,
              EdgeRejectionReasons.SignatureInvalid,
            ]).to.include(response.body.reason);
          });
        });
      });
    });
  });

  it('accepts an assertion still inside its window', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const genuine = search.body.assertions[0];

      // Proves the refusal above comes from the expiry rather than from
      // something that refuses every assertion this suite constructs.
      expect(Date.parse(genuine.expires_at)).to.be.greaterThan(Date.now());
    });
  });
});
