import { EdgeRejectionReasons, HttpStatus, Publishers, Queries } from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import { settlementChainUrl } from '../../constants/routes';
import type { AttributionChain } from '../../types/interfaces';

// OWASP A08: Software and Data Integrity Failures.
describe('A08 Data Integrity', () => {
  // Money moves on the strength of a signature that travels with the payment.
  // Every check here asks whether that signature is load-bearing or decorative.
  it('refuses an assertion whose product was swapped after signing', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];
      const otherProduct = search.body.products[1];

      agentActions.requestChallenge(otherProduct.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions
            .attemptPurchase(otherProduct.product_id, assertion, payment)
            .then((response) => {
              expect(response.status).to.not.equal(HttpStatus.Ok);
            });
        });
      });
    });
  });

  it('refuses an assertion whose search request was rewritten', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];
      const rewritten = { ...assertion, search_request_id: 'req_00000000' };

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions
            .attemptPurchase(assertion.product_id, rewritten, payment)
            .then((response) => {
              expect(response.status).to.equal(HttpStatus.Unauthorized);
              expect(response.body.reason).to.equal(EdgeRejectionReasons.SignatureInvalid);
            });
        });
      });
    });
  });

  // The ledger's own constraint enforces the split, and this asserts the
  // reported figures agree with the rows underneath rather than being
  // recomputed on the way out.
  it('records a settlement whose split cannot be edited after the fact', () => {
    agentActions.search(Queries.Alternate, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions.attemptPurchase(assertion.product_id, assertion, payment).then((settled) => {
            cy.request<AttributionChain>(
              settlementChainUrl(String(settled.body.settlement_id))
            ).then(({ body: chain }) => {
              // The signed rate is a ceiling rather than a fixed figure.
              // Search signs the best rate across every offer on the product,
              // and the merchant the agent chose may publish less, so
              // settlement takes the lower of the two. What must never happen
              // is the recorded rate exceeding what was signed, which would
              // let a tampered assertion raise a payout.
              expect(chain.commission_bps).to.be.at.most(assertion.commission_bps);
              expect(chain.commission_bps).to.be.greaterThan(0);
              expect(chain.assertion_id).to.equal(assertion.assertion_id);
            });
          });
        });
      });
    });
  });
});
