import {
  HttpStatus,
  MalformedPayments,
  MerchantRejectionReasons,
  Publishers,
  Queries,
  SecurityProbes,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import driverActions from '../../actions/driverActions';

// A payload that decodes as JSON while carrying the wrong shape passed every
// type check and every unit suite, then dereferenced into nothing at runtime.
// The merchant answered 502 with a JavaScript error message, which told a
// caller the implementation language and suggested the merchant broke rather
// than the request did. These specs exist so that never returns.
describe('Malformed payloads earn a validated refusal', () => {
  it('refuses every malformed payment shape with a reason naming the payload', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];

      for (const [label, payload] of Object.entries(MalformedPayments)) {
        agentActions
          .attemptPurchaseWithRawPayment(assertion.product_id, assertion, payload)
          .then((response) => {
            expect(response.status, `${label} status`).to.equal(HttpStatus.BadRequest);
            expect(response.body.reason, `${label} reason`).to.equal(
              MerchantRejectionReasons.MalformedPayment
            );
          });
      }
    });
  });

  // A 5xx tells a caller the platform broke and invites a retry. A malformed
  // request never deserves one.
  it('never answers a malformed payment with a server error', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];

      for (const payload of Object.values(MalformedPayments)) {
        agentActions
          .attemptPurchaseWithRawPayment(assertion.product_id, assertion, payload)
          .then((response) => {
            expect(response.status).to.be.lessThan(500);
          });
      }
    });
  });

  it('leaks no runtime error or implementation detail while refusing', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];

      agentActions
        .attemptPurchaseWithRawPayment(
          assertion.product_id,
          assertion,
          MalformedPayments.EmptyAuthorization
        )
        .then((response) => {
          const body = JSON.stringify(response.body);

          expect(body).to.not.contain('Cannot read properties');
          expect(body).to.not.contain('undefined');
          for (const marker of SecurityProbes.StackTraceMarkers) {
            expect(body).to.not.contain(marker);
          }
        });
    });
  });

  // Every refusal the platform makes has to leave a trace, whichever layer
  // makes it. The edge refuses forged assertions and the merchant refuses
  // malformed payments, and neither reaches settlement.
  it('records a malformed payment refusal', () => {
    driverActions.publishers().then((before) => {
      const blockedBefore = before.body.publishers.reduce(
        (total, publisher) => total + publisher.blocked_count,
        0
      );

      agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
        const assertion = search.body.assertions[0];

        agentActions
          .attemptPurchaseWithRawPayment(
            assertion.product_id,
            assertion,
            MalformedPayments.EmptyAuthorization
          )
          .then(() => {
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
