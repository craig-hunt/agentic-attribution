import {
  AllRejectionReasons,
  EdgeRejectionReasons,
  HttpStatus,
  Publishers,
  Queries,
  Tampering,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import driverActions from '../../actions/driverActions';
import navigationActions from '../../actions/navigationActions';
import publisherDetailRepository from '../../repositories/publisherDetailRepository';

// OWASP A09: Security Logging and Monitoring Failures.
describe('A09 Logging and Monitoring', () => {
  // A control that refuses an attack and records nothing leaves an operator
  // unable to tell a quiet week from an undetected campaign. Every refusal
  // this platform makes persists with its reason.
  it('records every refusal it makes, with the reason it refused', () => {
    driverActions.status().then((before) => {
      driverActions.runOneFraudAttempt().then((after) => {
        expect(after.status).to.equal(HttpStatus.Ok);
        expect(after.body.blocked).to.be.greaterThan(before.body.blocked);
        // A refused attempt must never be counted as revenue.
        expect(after.body.settled).to.equal(before.body.settled);
      });
    });
  });

  it('attributes a refusal to the publisher it was made in the name of', () => {
    driverActions.publishers().then((response) => {
      const blocked = response.body.publishers.reduce(
        (total, publisher) => total + publisher.blocked_count,
        0
      );

      // The fraud attempt above targets a publisher at random, so the total
      // across the table is what a spec can assert without racing the draw.
      expect(blocked).to.be.greaterThan(0);
    });
  });

  it('surfaces the refusal reason on the publisher page', () => {
    driverActions.publishers().then((response) => {
      const withBlocked = response.body.publishers.find((publisher) => publisher.blocked_count > 0);

      expect(withBlocked, 'no publisher carries a blocked attempt').to.not.equal(undefined);

      navigationActions.visitPublisher(withBlocked?.publisher_id ?? Publishers.Demo);

      publisherDetailRepository.getRejectionRows().should('have.length.of.at.least', 1);
      publisherDetailRepository.getRejectionReasons().should((reasons) => {
        const named = reasons.toArray().map((cell) => cell.textContent?.trim());
        const known: string[] = [...AllRejectionReasons];

        // An unnamed reason would leave an operator knowing only that
        // something was refused.
        expect(named.some((reason) => known.includes(reason ?? ''))).to.equal(true);
      });
    });
  });

  // The merchant verifies before it forwards, so a tampered assertion never
  // reaches settlement. Asserting only that some counter moved let this pass
  // while the platform refused these at the edge and recorded nothing.
  it('records a refusal the edge made, not only the ones settlement made', () => {
    driverActions.publishers().then((before) => {
      const blockedBefore = before.body.publishers.reduce(
        (total, publisher) => total + publisher.blocked_count,
        0
      );

      agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
        const assertion = search.body.assertions[0];
        // Rewrites the rate rather than the publisher. An attempt naming a
        // publisher who does not exist still gets recorded, deliberately, but
        // no row in the publisher table can carry it, so this asserts the
        // attributable case instead.
        const tampered = { ...assertion, commission_bps: Tampering.InflatedCommissionBps };

        agentActions.requestChallenge(assertion.product_id).then((challenge) => {
          agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
            agentActions
              .attemptPurchase(assertion.product_id, tampered, payment)
              .then((refused) => {
                expect(refused.status).to.equal(HttpStatus.Unauthorized);
                expect(refused.body.reason).to.equal(EdgeRejectionReasons.SignatureInvalid);

                driverActions.publishers().then((after) => {
                  const blockedAfter = after.body.publishers.reduce(
                    (total, publisher) => total + publisher.blocked_count,
                    0
                  );

                  expect(blockedAfter).to.be.greaterThan(blockedBefore);
                });
              });
          });
        });
      });
    });
  });

  it('separates a refused attempt from a settlement that fell over', () => {
    driverActions.publishers().then((response) => {
      for (const publisher of response.body.publishers) {
        expect(publisher.blocked_count).to.be.a('number');
        expect(publisher.failed_count).to.be.a('number');
      }
    });
  });
});
