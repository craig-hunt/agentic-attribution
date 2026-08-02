import {
  HttpStatus,
  Publishers,
  Queries,
  EdgeRejectionReasons,
  Tampering,
} from '../../constants/testData';
import agentActions from '../../actions/agentActions';
import type { AttributionAssertion, X402Payment } from '../../types/interfaces';

describe('A tampered assertion is refused at the edge', () => {
  let genuine: AttributionAssertion;
  let productId: string;
  let payment: X402Payment;

  beforeEach(() => {
    agentActions.search(Queries.Default, Publishers.Demo).then((search) => {
      genuine = search.body.assertions[0];
      productId = genuine.product_id;

      agentActions.requestChallenge(productId).then((challenge) => {
        agentActions.signAuthorization(challenge.body.accepts[0]).then((signed) => {
          payment = signed;
        });
      });
    });
  });

  // The signature covers the publisher, so redirecting the payout breaks
  // verification without the attacker ever touching the signature itself.
  it('refuses an assertion whose publisher was rewritten', () => {
    const tampered = { ...genuine, publisher_id: Publishers.Attacker };

    agentActions.attemptPurchase(productId, tampered, payment).then((response) => {
      expect(response.status).to.equal(HttpStatus.Unauthorized);
      expect(response.body.reason).to.equal(EdgeRejectionReasons.SignatureInvalid);
    });
  });

  // The rate travels inside the signature precisely so a merchant cannot be
  // talked into honouring a number the platform never agreed to.
  it('refuses an assertion whose commission rate was inflated', () => {
    const tampered = { ...genuine, commission_bps: Tampering.InflatedCommissionBps };

    agentActions.attemptPurchase(productId, tampered, payment).then((response) => {
      expect(response.status).to.equal(HttpStatus.Unauthorized);
      expect(response.body.reason).to.equal(EdgeRejectionReasons.SignatureInvalid);
    });
  });

  // Verification has to reject rather than compare lengths or prefixes, so the
  // forgery keeps the scheme and the full base64 body a real signature carries.
  it('refuses a wholly forged signature', () => {
    const tampered = {
      ...genuine,
      signature:
        Tampering.ForgedSignaturePrefix +
        Tampering.ForgedSignatureBody +
        Tampering.ForgedSignaturePadding,
    };

    agentActions.attemptPurchase(productId, tampered, payment).then((response) => {
      expect(response.status).to.equal(HttpStatus.Unauthorized);
      expect(response.body.reason).to.equal(EdgeRejectionReasons.SignatureInvalid);
    });
  });

  // An assertion names the product it was issued against. Accepting one issued
  // for a different product would let an attacker move a high-commission
  // assertion onto an unrelated purchase.
  it('refuses an assertion issued for a different product', () => {
    agentActions.search(Queries.Alternate, Publishers.Demo).then((other) => {
      const foreign = other.body.assertions[0];

      agentActions.attemptPurchase(productId, foreign, payment).then((response) => {
        expect(response.status).to.not.equal(HttpStatus.Ok);
      });
    });
  });
});
