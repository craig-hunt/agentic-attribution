import {
  HttpStatus,
  LedgerAccounts,
  LedgerCounts,
  Money,
  Publishers,
  Queries,
  SettlementStatus,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import chainRepository from '../../repositories/chainRepository';
import navigationActions from '../../actions/navigationActions';

describe('The dashboard renders the chain from query to ledger entry', () => {
  let settlementId: string;
  let assertionId: string;
  let searchRequestId: string;

  beforeEach(() => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const assertion = search.body.assertions[0];
      assertionId = assertion.assertion_id;
      searchRequestId = assertion.search_request_id;

      agentActions.requestChallenge(assertion.product_id).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((payment) => {
          agentActions.attemptPurchase(assertion.product_id, assertion, payment).then((settled) => {
            expect(settled.status).to.equal(HttpStatus.Ok);
            settlementId = String(settled.body.settlement_id);
          });
        });
      });
    });
  });

  // Every value on this page traces to a row a real settlement wrote. It
  // carries the argument the whole project makes, so it gets asserted rather
  // than eyeballed.
  it('shows the query, the assertion, and the payment that connect them', () => {
    navigationActions.visitSettlement(settlementId);

    chainRepository.getSettlementId().should('have.text', settlementId);
    chainRepository.getQuery().should('have.text', Queries.Default);
    chainRepository.getSearchRequestId().should('have.text', searchRequestId);
    chainRepository.getAssertionId().should('have.text', assertionId);
    chainRepository.getTransactionHash().should('not.be.empty');
    chainRepository.getStatus().should('have.text', SettlementStatus.Confirmed);
  });

  it('renders a ledger that balances to zero on the page itself', () => {
    navigationActions.visitSettlement(settlementId);

    chainRepository.getLedgerRows().should('have.length', LedgerCounts.EntriesPerSettlement);

    // The balance rendered on the page, not merely held in the database. A
    // reviewer reads this line rather than querying Postgres.
    chainRepository.getLedgerBalance().should('have.text', Money.Zero);
  });

  it('names all three parties to the split', () => {
    navigationActions.visitSettlement(settlementId);

    chainRepository.getLedgerAccounts().then((accounts) => {
      const named = accounts.toArray().map((cell) => cell.textContent?.trim());

      expect(named).to.include(LedgerAccounts.MerchantPayable);
      expect(named).to.include(LedgerAccounts.PlatformRevenue);
      expect(named).to.include(LedgerAccounts.PublisherPayable);
    });
  });

  it('links back to the publisher the commission reached', () => {
    navigationActions.visitSettlement(settlementId);

    chainRepository.getPublisherLink().should('have.attr', 'href').and('contain', Publishers.Demo);
  });
});
