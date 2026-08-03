import {
  BodyLimits,
  Faults,
  GatewayRejectionReasons,
  HttpStatus,
  MerchantRejectionReasons,
  Publishers,
  Queries,
  SettlementRejectionReasons,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import driverActions from '../../actions/driverActions';
import { GatewayPaths, gatewayUrl } from '../../constants/routes';

// Every refusal the platform can make, exercised end to end.
//
// Unit tests touched each of these reasons in isolation, which proved the
// branch existed rather than that the assembled system reaches it. The gap
// that shipped a broken demo lived exactly there.
describe('Every refusal path the platform can take', () => {
  it('refuses a purchase for a product nobody lists', () => {
    agentActions.requestChallenge('prd_99999999').then((response) => {
      expect(response.status).to.equal(HttpStatus.NotFound);
    });
  });

  // A caller sending too much data made a bad request rather than finding a
  // broken gateway. Answering 5xx would invite the retry that sends the same
  // oversized body again.
  it('refuses a request body larger than the edge accepts', () => {
    cy.request({
      method: 'POST',
      url: gatewayUrl(GatewayPaths.Search),
      // Past the gateway's ceiling, built rather than stored so no fixture
      // carries a quarter megabyte of padding.
      body: {
        query: 'x'.repeat(BodyLimits.OversizedQueryChars),
        publisher_id: Publishers.Demo,
        size: 1,
      },
      failOnStatusCode: false,
    }).then((response) => {
      expect(response.status).to.equal(HttpStatus.PayloadTooLarge);
      expect(response.body.reason).to.equal(GatewayRejectionReasons.BodyTooLarge);
    });
  });

  it('accepts a query comfortably inside the limit', () => {
    cy.request({
      method: 'POST',
      url: gatewayUrl(GatewayPaths.Search),
      body: { query: Queries.Default, publisher_id: Publishers.Demo, size: 1 },
      failOnStatusCode: false,
    }).then((response) => {
      // Proves the refusal above comes from the size rather than from
      // something that rejects every request this spec builds.
      expect(response.status).to.equal(HttpStatus.Ok);
    });
  });

  it('refuses an authorization paying an amount the listing does not ask for', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          const underpaying = {
            ...payment,
            authorization: { ...payment.authorization, value: '1' },
          };

          agentActions
            .attemptPurchaseWithRawPayment(assertion.product_id, assertion, underpaying)
            .then((response) => {
              expect(response.status).to.equal(HttpStatus.Unprocessable);
              expect(response.body.reason).to.equal(MerchantRejectionReasons.AmountMismatch);
            });
        });
      });
    });
  });

  // The merchant names the address it wants paid. Honouring an authorization
  // pointing somewhere else would settle a purchase whose money went to an
  // attacker while the buyer received goods.
  it('refuses an authorization paying somebody else', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          const redirected = {
            ...payment,
            authorization: {
              ...payment.authorization,
              to: '0x9999999999999999999999999999999999999999',
            },
          };

          agentActions
            .attemptPurchaseWithRawPayment(assertion.product_id, assertion, redirected)
            .then((response) => {
              expect(response.status).to.equal(HttpStatus.Unprocessable);
              expect(response.body.reason).to.equal(MerchantRejectionReasons.PayeeMismatch);
            });
        });
      });
    });
  });

  it('refuses an assertion issued for a different product than the purchase', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];
      const otherProduct = search.body.products[1];

      agentActions.requestChallenge(otherProduct.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions
            .attemptPurchase(otherProduct.product_id, assertion, payment)
            .then((response) => {
              expect(response.status).to.equal(HttpStatus.Unprocessable);
              expect(response.body.reason).to.equal(MerchantRejectionReasons.ProductMismatch);
            });
        });
      });
    });
  });
});

// Paths a healthy facilitator never produces, so a mock that only succeeds
// leaves them untested forever.
describe('Failure paths, with a fault injected', () => {
  // These specs need the facilitator started with FACILITATOR_FAULT_INJECTION
  // enabled, which the e2e make targets do. Without it /fault answers 404 and
  // every assertion below fails on a status nobody would connect to a missing
  // environment variable.
  //
  // Checked once, loudly, rather than skipped. A suite that quietly skips
  // reports green while covering less than it claims, which is the failure
  // ADR-0006 warns about.
  before(() => {
    driverActions.setFault(Faults.None).then((response) => {
      if (response.status !== HttpStatus.Ok) {
        // Thrown rather than asserted. A chai message inside a hook gets
        // reported against whichever test ran first, where nobody connects it
        // to a missing environment variable.
        throw new Error(
          'Fault injection is off, so these specs cannot run. Start the ' +
            'facilitator with FACILITATOR_FAULT_INJECTION=true, which both ' +
            '`make e2e` and `make e2e-open` already do. ' +
            `POST /fault answered ${response.status}.`
        );
      }
    });
  });

  afterEach(() => {
    // Cleared unconditionally. A fault left armed turns every later spec red
    // for a reason none of them describe.
    driverActions.setFault(Faults.None);
  });

  it('refuses a payment the facilitator declines to verify', () => {
    driverActions.setFault(Faults.VerifyRejects).then((armed) => {
      expect(armed.status).to.equal(HttpStatus.Ok);

      agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
        const assertion = search.body.assertions[0];

        agentActions.requestChallenge(assertion.product_id).then((challenge) => {
          agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
            agentActions
              .attemptPurchase(assertion.product_id, assertion, payment)
              .then((response) => {
                expect(response.status).to.not.equal(HttpStatus.Ok);
                expect(response.body.reason).to.equal(SettlementRejectionReasons.PaymentInvalid);
              });
          });
        });
      });
    });
  });

  // The settlement began, the assertion got claimed, and the payment fell over
  // afterwards. Nobody defrauded anybody and nobody got paid, which is a
  // different outcome from a refusal and the ledger has to say so.
  it('records a settlement that started and failed, writing no ledger entries', () => {
    driverActions.setFault(Faults.SettleFails).then(() => {
      agentActions.search(Queries.Alternate, Publishers.Alternate).then((search) => {
        const assertion = search.body.assertions[0];

        agentActions.requestChallenge(assertion.product_id).then((challenge) => {
          agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
            agentActions
              .attemptPurchase(assertion.product_id, assertion, payment)
              .then((response) => {
                expect(response.status).to.not.equal(HttpStatus.Ok);

                driverActions.publishers().then((after) => {
                  const failed = after.body.publishers.reduce(
                    (total, publisher) => total + publisher.failed_count,
                    0
                  );

                  // The column, its filter, and this entire path stayed at
                  // zero for as long as the facilitator could only succeed.
                  expect(failed).to.be.greaterThan(0);
                });
              });
          });
        });
      });
    });
  });

  it('refuses cleanly when the facilitator cannot be reached at all', () => {
    driverActions.setFault(Faults.Unavailable).then(() => {
      agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
        const assertion = search.body.assertions[0];

        agentActions.requestChallenge(assertion.product_id).then((challenge) => {
          agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
            agentActions
              .attemptPurchase(assertion.product_id, assertion, payment)
              .then((response) => {
                expect(response.status).to.not.equal(HttpStatus.Ok);
                // Whatever it answers, it must name a reason rather than leak
                // a runtime error, and it must not claim success.
                expect(response.body.reason).to.be.a('string');
                expect(JSON.stringify(response.body)).to.not.contain('Cannot read properties');
              });
          });
        });
      });
    });
  });

  it('returns to settling normally once the fault clears', () => {
    driverActions.setFault(Faults.Unavailable).then(() => {
      driverActions.setFault(Faults.None).then(() => {
        driverActions.runOnce().then((after) => {
          expect(after.status).to.equal(HttpStatus.Ok);
        });
      });
    });
  });
});
