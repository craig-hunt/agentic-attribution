import {
  BasisPoints,
  HttpStatus,
  LedgerCounts,
  Publishers,
  Queries,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import { settlementChainUrl } from '../../constants/routes';
import type { AttributionChain } from '../../types/interfaces';

describe('Commission lands on the referring publisher at the signed rate', () => {
  it('splits the commission exactly and credits the publisher who searched', () => {
    agentActions.search(Queries.Default, Publishers.Alternate).then((search) => {
      const assertion = search.body.assertions[0];

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions.attemptPurchase(assertion.product_id, assertion, payment).then((settled) => {
            expect(settled.status).to.equal(HttpStatus.Ok);

            cy.request<AttributionChain>(
              settlementChainUrl(String(settled.body.settlement_id))
            ).then(({ body: chain }) => {
              // The publisher who ran the search gets the money, not the
              // merchant who made the sale. That separation is the problem
              // this project exists to solve.
              expect(chain.publisher_id).to.equal(Publishers.Alternate);

              // The CHECK constraint enforces this on the row, so a mismatch
              // means the reporting query disagrees with what it reads.
              expect(chain.publisher_amount_cents + chain.platform_fee_cents).to.equal(
                chain.commission_amount_cents
              );

              // The signed rate decides the commission. A rate applied to
              // the wrong base, or a stored default used instead of the
              // signed one, shows up here and nowhere else.
              const expected = Math.round(
                (chain.gross_amount_cents * chain.commission_bps) / BasisPoints.Divisor
              );
              expect(Math.abs(expected - chain.commission_amount_cents)).to.be.at.most(1);

              // The commission gets split, not the sale. Both parties taking
              // a share of gross would pay out roughly fifty times what the
              // merchant agreed to.
              expect(chain.commission_amount_cents).to.be.lessThan(chain.gross_amount_cents);
            });
          });
        });
      });
    });
  });

  it('writes a balanced double-entry ledger for the settlement', () => {
    agentActions.search(Queries.Alternate, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions.attemptPurchase(assertion.product_id, assertion, payment).then((settled) => {
            cy.request<AttributionChain>(
              settlementChainUrl(String(settled.body.settlement_id))
            ).then(({ body: chain }) => {
              expect(chain.ledger_entries).to.have.length(LedgerCounts.EntriesPerSettlement);

              // Three entries summing to zero is what makes it double-entry.
              // A credit posted without its matching debit balances nothing.
              const total = chain.ledger_entries.reduce(
                (sum, entry) => sum + entry.amount_cents,
                0
              );
              expect(total).to.equal(0);
            });
          });
        });
      });
    });
  });
});
