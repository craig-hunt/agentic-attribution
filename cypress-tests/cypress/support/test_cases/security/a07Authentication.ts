import { HttpStatus, Publishers, RunControls } from '../../constants/testData';
import driverActions from '../../actions/driverActions';

// OWASP A07: Identification and Authentication Failures.
//
// This application carries no authentication anywhere, deliberately. Every
// service trusts its callers, and the driver's control endpoints accept a
// start from anyone who can reach the dashboard. PRODUCTIONALIZING.md records
// that as a deploy blocker and ADR-0010 explains what bounds it today.
//
// These specs assert the posture that exists rather than the one that should,
// so the suite stays green and the finding lives in the test names. A
// permanently red suite trains everyone to ignore the colour, which is the
// failure ADR-0006 warns about for brittle selectors.
describe('A07 Authentication posture, as documented', () => {
  it('serves publisher earnings unauthenticated, which production must gate', () => {
    driverActions.publisher(Publishers.Demo).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
    });
  });

  it('accepts an unauthenticated driver start, which production must gate behind an operator identity', () => {
    driverActions.start().then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);

      driverActions.stop().then((stopped) => {
        expect(stopped.status).to.equal(HttpStatus.Ok);
        expect(stopped.body.running).to.equal(false);
      });
    });
  });

  // The one control that does exist. The dashboard clamps what a caller may
  // ask for, which bounds the blast radius without deciding who may cause it.
  it('clamps a concurrency request far above its ceiling', () => {
    driverActions.start(RunControls.AbsurdConcurrency, 0).then((response) => {
      expect(response.status).to.equal(HttpStatus.Ok);
      expect(response.body.concurrency).to.be.at.most(RunControls.MaxConcurrency);

      driverActions.stop();
    });
  });

  it('clamps a fraud rate outside its range', () => {
    driverActions.start(1, RunControls.AbsurdFraudRate).then((response) => {
      expect(response.body.fraudRate).to.be.at.most(RunControls.MaxFraudRate);

      driverActions.stop();
    });
  });
});
