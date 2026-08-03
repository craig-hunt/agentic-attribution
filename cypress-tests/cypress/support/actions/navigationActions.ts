import { DashboardPaths, dashboardUrl, publisherUrl, settlementUrl } from '../constants/routes';
import publisherDetailRepository from '../repositories/publisherDetailRepository';
import publisherListRepository from '../repositories/publisherListRepository';

class NavigationActions {
  visitPublisherList(): void {
    cy.visit(dashboardUrl(DashboardPaths.Publishers));
  }

  visitPublisher(publisherId: string): void {
    cy.visit(publisherUrl(publisherId));
  }

  visitSettlement(settlementId: string): void {
    cy.visit(settlementUrl(settlementId));
  }

  openPublisherFromList(publisherId: string): void {
    publisherListRepository.getLinkFor(publisherId).click();
  }

  openFirstSettlementChain(): void {
    publisherDetailRepository.getFirstSettlementChainLink().click();
  }
}

export default new NavigationActions();
