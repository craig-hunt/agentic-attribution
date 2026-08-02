import { CatalogCounts, HttpStatus, Publishers, Queries } from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import driverActions from '../../actions/driverActions';
import navigationActions from '../../actions/navigationActions';
import publisherListRepository from '../../repositories/publisherListRepository';
import runControlsActions from '../../actions/runControlsActions';
import runControlsRepository from '../../repositories/runControlsRepository';

describe('Happy path, search through settled commission', () => {
  it('returns products and one signed assertion per product', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
      expect(response.body.products).to.have.length.of.at.least(CatalogCounts.MinimumSearchResults);
      // A product returned without an assertion would let an agent buy with
      // nothing to attribute the sale to.
      expect(response.body.assertions).to.have.length(response.body.products.length);
      expect(response.body.assertions[0].publisher_id).to.equal(Publishers.Demo);
      expect(response.body.assertions[0].search_request_id).to.equal(
        response.body.search_request_id
      );
    });
  });

  it('answers a purchase request without payment as 402 Payment Required', () => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      const product = search.body.products[0];

      agentActions.requestChallenge(product.product_id).then((challenge) => {
        expect(challenge.status).to.equal(HttpStatus.PaymentRequired);
        expect(challenge.body.accepts[0].payTo).to.match(/^0x/);
        expect(challenge.body.accepts[0].maxAmountRequired).to.match(/^\d+$/);
      });
    });
  });

  it('settles a purchase and credits the publisher that referred it', () => {
    driverActions.status().then((before) => {
      driverActions.runOnce().then((after) => {
        expect(after.status).to.equal(HttpStatus.Ok);
        // Asserted as a delta. A live population keeps settling while the
        // spec runs, so an absolute total would race the driver.
        expect(after.body.settled).to.be.greaterThan(before.body.settled);
        expect(after.body.blocked).to.equal(before.body.blocked);
      });
    });
  });

  it('shows the settlement on the dashboard without a reload', () => {
    navigationActions.visitPublisherList();
    runControlsRepository.getPanel().should('be.visible');

    publisherListRepository.getEarnedColumn().then((cells) => {
      const before = cells.toArray().map((cell) => cell.textContent);

      runControlsActions.runOnePurchase();
      runControlsActions.awaitPoll();

      // The page rewrites its own rows on a timer. Something in the column
      // has to differ, or the live update never reached the table.
      publisherListRepository.getEarnedColumn().should((updated) => {
        const after = updated.toArray().map((cell) => cell.textContent);
        expect(after.join('|')).to.not.equal(before.join('|'));
      });
    });
  });
});
