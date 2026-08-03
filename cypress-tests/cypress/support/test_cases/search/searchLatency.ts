import { CatalogCounts, HttpStatus, Publishers, Queries, Timings } from '../../constants/testData';
import agentActions from '../../actions/agentActions';

describe('Search answers inside its latency budget', () => {
  // A regression that doubles query time still passes a default assertion
  // timeout, so the budget has to be asserted rather than inherited.
  it('returns hybrid results within the budget', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
      expect(response.body.products).to.have.length.of.at.least(CatalogCounts.MinimumSearchResults);
      expect(response.duration).to.be.lessThan(Timings.SearchLatencyBudgetMs);
    });
  });

  // The service publishes what it measured, which excludes the network hop the
  // duration above includes. When those two figures diverge sharply, the cost
  // sits at the edge rather than in retrieval.
  it('reports its own latency alongside the results', () => {
    agentActions.search(Queries.Alternate, Publishers.Demo).then((response) => {
      expect(response.body.latency_ms).to.be.a('number');
      expect(response.body.latency_ms).to.be.lessThan(Timings.SearchLatencyBudgetMs);
    });
  });

  it('answers a query matching nothing without failing', () => {
    agentActions.search(Queries.Unmatchable, Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
      expect(response.body.products).to.be.an('array');
    });
  });
});
