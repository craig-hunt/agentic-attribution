import { RunControls, Timings } from '../constants/testData';
import { StateClasses } from '../constants/selectors';
import runControlsRepository from '../repositories/runControlsRepository';

class RunControlsActions {
  // Fires one purchase and waits for the driver to finish it. The endpoint
  // behind this button awaits the run before answering, so the count moving is
  // the signal that the work completed rather than that the click registered.
  runOnePurchase(): void {
    runControlsRepository.getRunOnceButton().click();
  }

  enableFraud(): void {
    runControlsRepository.getFraudToggle().check();
  }

  disableFraud(): void {
    runControlsRepository.getFraudToggle().uncheck();
  }

  setConcurrency(agents: number = RunControls.Concurrency): void {
    runControlsRepository.getConcurrencyInput().clear().type(String(agents));
  }

  startAgents(): void {
    runControlsRepository.getStartButton().click();
  }

  stopAgents(): void {
    runControlsRepository.getStopButton().click();
  }

  filterBySettled(): void {
    runControlsRepository.getSettledFilter().click();
  }

  filterByBlocked(): void {
    runControlsRepository.getBlockedFilter().click();
  }

  filterByFailed(): void {
    runControlsRepository.getFailedFilter().click();
  }

  clearFilter(): void {
    runControlsRepository.getAllFilter().click();
  }

  // The page rewrites its table on a timer rather than on demand, so a spec
  // that reads immediately after an action reads the previous state. Waiting
  // two cycles covers a poll that fired just before the change landed.
  awaitPoll(): void {
    cy.wait(Timings.PollIntervalMs * Timings.PollCycles);
  }
}

export const ActiveChipClass = StateClasses.ActiveChip;

export default new RunControlsActions();
