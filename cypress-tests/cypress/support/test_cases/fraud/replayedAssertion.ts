import {
  HttpStatus,
  Publishers,
  Queries,
  SettlementRejectionReasons,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import { settlementChainUrl } from '../../constants/routes';
import type { AttributionChain } from '../../types/interfaces';

describe('A replayed assertion is refused on its second use', () => {
  // The single-use guarantee is the property the whole design exists to
  // provide, and a guarantee nobody exercises is a claim rather than a
  // property. This spec signs a genuine authorization because the reuse check
  // sits behind facilitator verification: a junk payment would be refused for
  // the wrong reason and prove nothing about replay.
  it('settles once, then refuses the same assertion with a conflict', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];
      const productId = assertion.product_id;

      agentActions.requestChallenge(productId).then((firstChallenge) => {
        agentActions.signAuthorization(firstChallenge.body.accepts[0]).then((firstPayment) => {
          agentActions.attemptPurchase(productId, assertion, firstPayment).then((settled) => {
            expect(settled.status).to.equal(HttpStatus.Ok);
            expect(settled.body.settlement_id).to.be.a('string');

            // A fresh authorization for the replay, so the refusal comes
            // from the consumed assertion rather than from a reused nonce.
            agentActions.requestChallenge(productId).then((secondChallenge) => {
              agentActions
                .signAuthorization(secondChallenge.body.accepts[0])
                .then((secondPayment) => {
                  agentActions
                    .attemptPurchase(productId, assertion, secondPayment)
                    .then((replay) => {
                      expect(replay.status).to.equal(HttpStatus.Conflict);
                      expect(replay.body.reason).to.equal(SettlementRejectionReasons.Reused);
                    });
                });
            });
          });
        });
      });
    });
  });

  it('stamps the moment an assertion was consumed', () => {
    agentActions.search(Queries.Alternate, Publishers.Alternate).then((search) => {
      const assertion = search.body.assertions[0];

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions.attemptPurchase(assertion.product_id, assertion, payment).then((settled) => {
            expect(settled.status).to.equal(HttpStatus.Ok);

            cy.request<AttributionChain>(
              settlementChainUrl(String(settled.body.settlement_id))
            ).then((chain) => {
              // An unstamped assertion would replay successfully, which
              // would make the conflict above enforce nothing.
              expect(chain.body.assertion_consumed_at).to.be.a('string');
              expect(chain.body.assertion_id).to.equal(assertion.assertion_id);
            });
          });
        });
      });
    });
  });
});
