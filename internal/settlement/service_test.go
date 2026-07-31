package settlement

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

// A recording facilitator. Which calls it received, and in what order relative
// to the durable claim, is the whole subject of these tests.
type recordingFacilitator struct {
	verify      VerifyResponse
	verifyErr   error
	settle      SettleResponse
	settleErr   error
	verifyCalls int
	settleCalls int
	onVerify    func()
}

func (f *recordingFacilitator) Verify(context.Context, PaymentPayload, PaymentRequirements) (VerifyResponse, error) {
	f.verifyCalls++
	if f.onVerify != nil {
		f.onVerify()
	}

	return f.verify, f.verifyErr
}

func (f *recordingFacilitator) Settle(context.Context, PaymentPayload, PaymentRequirements) (SettleResponse, error) {
	f.settleCalls++

	return f.settle, f.settleErr
}

func acceptingFacilitator() *recordingFacilitator {
	return &recordingFacilitator{
		verify: VerifyResponse{IsValid: true, Payer: "0xpayer"},
		settle: SettleResponse{Success: true, Transaction: "0xtx", Network: "base-sepolia", Payer: "0xpayer"},
	}
}

func newServiceUnderTest(t *testing.T, fac Facilitator) (*Service, *attribution.Signer, *Store) {
	t.Helper()

	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	store, _ := newStore(t)
	svc := NewService(store, attribution.NewVerifier(public), fac)

	return svc, attribution.NewSigner(private), store
}

func mintFor(t *testing.T, signer *attribution.Signer, id string, bps int, issuedAt time.Time) attribution.Assertion {
	t.Helper()

	a, err := signer.Mint(id, testPublisherID, testProductID, testSearchRequestID, bps, issuedAt)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	return a
}

func settleRequest(a attribution.Assertion) Request {
	return Request{
		Assertion:        a,
		MerchantID:       testMerchantID,
		GrossAmountCents: testPriceCents,
		Currency:         "USD",
		PaymentPayload: PaymentPayload{
			X402Version: X402Version,
			Scheme:      SchemeExact,
			Network:     "base-sepolia",
		},
		PaymentRequirements: PaymentRequirements{Scheme: SchemeExact, Network: "base-sepolia"},
	}
}

func TestSettleConfirmsAndSplitsTheCommission(t *testing.T) {
	fac := acceptingFacilitator()
	svc, signer, _ := newServiceUnderTest(t, fac)

	now := time.Now()
	svc.now = func() time.Time { return now }
	svc.newID = func() string { return "stl_fixed" }

	result, err := svc.Settle(context.Background(), settleRequest(mintFor(t, signer, "a1", 450, now)))
	if err != nil {
		t.Fatalf("Settle: %v", err)
	}

	if result.Status != StatusConfirmed || result.TxHash != "0xtx" {
		t.Errorf("result = %+v", result)
	}

	want := attribution.CalculateCommission(testPriceCents, 450)
	if result.CommissionAmountCents != want.CommissionAmountCents ||
		result.PlatformFeeCents != want.PlatformFeeCents ||
		result.PublisherAmountCents != want.PublisherAmountCents {
		t.Errorf("split = %+v, want %+v", result, want)
	}
}

// Search mints an assertion carrying the best rate across every offer on the
// product, so the merchant the agent picked may publish less. The signature
// caps what the publisher can claim, and the listing caps what the merchant
// can be charged.
func TestSettleTakesTheLowerOfTheSignedAndListedRates(t *testing.T) {
	cases := []struct {
		name      string
		signedBps int
		wantBps   int
	}{
		{"signed rate above the listing rate clamps down", 900, 450},
		{"signed rate below the listing rate wins", 200, 200},
		{"rates agree", 450, 450},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fac := acceptingFacilitator()
			svc, signer, _ := newServiceUnderTest(t, fac)

			now := time.Now()
			svc.now = func() time.Time { return now }

			result, err := svc.Settle(context.Background(),
				settleRequest(mintFor(t, signer, "a1", tc.signedBps, now)))
			if err != nil {
				t.Fatalf("Settle: %v", err)
			}

			if result.CommissionBps != tc.wantBps {
				t.Fatalf("commission_bps = %d, want %d", result.CommissionBps, tc.wantBps)
			}
		})
	}
}

// The ordering argument. A malformed payload costs the caller a round trip
// rather than a single-use assertion, so the facilitator check has to run
// before anything durable happens.
func TestARejectedPaymentDoesNotBurnTheAssertion(t *testing.T) {
	fac := acceptingFacilitator()
	fac.verify = VerifyResponse{IsValid: false, InvalidReason: "insufficient_funds"}

	svc, signer, store := newServiceUnderTest(t, fac)
	now := time.Now()
	svc.now = func() time.Time { return now }

	a := mintFor(t, signer, "a1", 450, now)

	if _, err := svc.Settle(context.Background(), settleRequest(a)); !errors.Is(err, ErrPaymentInvalid) {
		t.Fatalf("Settle returned %v, want ErrPaymentInvalid", err)
	}
	if fac.settleCalls != 0 {
		t.Errorf("settle ran %d times after verification failed", fac.settleCalls)
	}

	// The assertion survives, so a corrected payment can still use it.
	if err := store.Begin(context.Background(), pending("a1")); err != nil {
		t.Fatalf("the assertion was consumed despite the payment failing: %v", err)
	}
}

// Once value has moved the claim stands. Releasing it would let a caller grind
// one assertion against a flaky facilitator until a retry happened to land.
func TestAFailedSettlementMarksTheRowFailedAndKeepsTheClaim(t *testing.T) {
	fac := acceptingFacilitator()
	fac.settle = SettleResponse{Success: false, ErrorReason: "nonce_already_used"}

	svc, signer, store := newServiceUnderTest(t, fac)
	now := time.Now()
	svc.now = func() time.Time { return now }
	svc.newID = func() string { return "stl_failed" }

	a := mintFor(t, signer, "a1", 450, now)

	if _, err := svc.Settle(context.Background(), settleRequest(a)); !errors.Is(err, ErrSettlementFailed) {
		t.Fatalf("Settle returned %v, want ErrSettlementFailed", err)
	}

	if err := store.Begin(context.Background(), pending("a1")); !errors.Is(err, ErrAssertionReused) {
		t.Fatalf("reclaiming after a failed settlement returned %v, want ErrAssertionReused", err)
	}

	chain, err := store.Chain(context.Background(), "stl_failed")
	if err != nil {
		t.Fatalf("Chain: %v", err)
	}
	if chain.Status != StatusFailed {
		t.Errorf("status = %s, want %s", chain.Status, StatusFailed)
	}
	if len(chain.Ledger) != 0 {
		t.Errorf("a failed settlement wrote %d ledger entries", len(chain.Ledger))
	}
}

func TestAFacilitatorOutageMarksTheSettlementFailed(t *testing.T) {
	fac := acceptingFacilitator()
	fac.settleErr = ErrFacilitatorUnavailable

	svc, signer, store := newServiceUnderTest(t, fac)
	now := time.Now()
	svc.now = func() time.Time { return now }
	svc.newID = func() string { return "stl_outage" }

	if _, err := svc.Settle(context.Background(), settleRequest(mintFor(t, signer, "a1", 450, now))); !errors.Is(err, ErrFacilitatorUnavailable) {
		t.Fatalf("Settle returned %v, want ErrFacilitatorUnavailable", err)
	}

	chain, err := store.Chain(context.Background(), "stl_outage")
	if err != nil {
		t.Fatalf("Chain: %v", err)
	}
	if chain.Status != StatusFailed {
		t.Errorf("status = %s, want the row marked failed rather than left pending", chain.Status)
	}
}

func TestSettleRejectsAReplayedAssertion(t *testing.T) {
	fac := acceptingFacilitator()
	svc, signer, _ := newServiceUnderTest(t, fac)

	now := time.Now()
	svc.now = func() time.Time { return now }

	a := mintFor(t, signer, "a1", 450, now)

	if _, err := svc.Settle(context.Background(), settleRequest(a)); err != nil {
		t.Fatalf("first Settle: %v", err)
	}
	if _, err := svc.Settle(context.Background(), settleRequest(a)); !errors.Is(err, ErrAssertionReused) {
		t.Fatalf("replay returned %v, want ErrAssertionReused", err)
	}
}

// Nothing durable happens and no facilitator round trip gets spent on an
// assertion that fails verification.
func TestSettleRejectsForgedAndExpiredAssertionsBeforeAnyNetworkCall(t *testing.T) {
	now := time.Now()

	t.Run("tampered", func(t *testing.T) {
		fac := acceptingFacilitator()
		svc, signer, _ := newServiceUnderTest(t, fac)
		svc.now = func() time.Time { return now }

		a := mintFor(t, signer, "a1", 450, now)
		a.CommissionBps = 9_999

		if _, err := svc.Settle(context.Background(), settleRequest(a)); !errors.Is(err, attribution.ErrInvalidSignature) {
			t.Fatalf("Settle returned %v, want ErrInvalidSignature", err)
		}
		if fac.verifyCalls != 0 {
			t.Errorf("the facilitator saw %d calls for a forged assertion", fac.verifyCalls)
		}
	})

	t.Run("expired", func(t *testing.T) {
		fac := acceptingFacilitator()
		svc, signer, _ := newServiceUnderTest(t, fac)
		svc.now = func() time.Time { return now.Add(2 * attribution.TTL) }

		a := mintFor(t, signer, "a1", 450, now)

		if _, err := svc.Settle(context.Background(), settleRequest(a)); !errors.Is(err, attribution.ErrExpired) {
			t.Fatalf("Settle returned %v, want ErrExpired", err)
		}
		if fac.verifyCalls != 0 {
			t.Errorf("the facilitator saw %d calls for an expired assertion", fac.verifyCalls)
		}
	})
}

func TestSettleValidatesTheListingBeforePaying(t *testing.T) {
	now := time.Now()

	cases := []struct {
		name    string
		mutate  func(*Request)
		wantErr error
	}{
		{"unknown merchant", func(r *Request) { r.MerchantID = "mer_nobody" }, ErrListingNotFound},
		{"wrong amount", func(r *Request) { r.GrossAmountCents = 1 }, ErrAmountMismatch},
		{"wrong currency", func(r *Request) { r.Currency = "EUR" }, ErrCurrencyMismatch},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fac := acceptingFacilitator()
			svc, signer, _ := newServiceUnderTest(t, fac)
			svc.now = func() time.Time { return now }

			req := settleRequest(mintFor(t, signer, "a1", 450, now))
			tc.mutate(&req)

			if _, err := svc.Settle(context.Background(), req); !errors.Is(err, tc.wantErr) {
				t.Fatalf("Settle returned %v, want %v", err, tc.wantErr)
			}
			if fac.verifyCalls != 0 || fac.settleCalls != 0 {
				t.Errorf("the facilitator was contacted for an invalid listing")
			}
		})
	}
}

func TestSettleRefusesAnOutOfStockListing(t *testing.T) {
	fac := acceptingFacilitator()
	svc, signer, store := newServiceUnderTest(t, fac)

	now := time.Now()
	svc.now = func() time.Time { return now }

	if _, err := store.pool.Exec(context.Background(),
		`UPDATE listings SET in_stock = false WHERE listing_id = $1`, testListingID); err != nil {
		t.Fatalf("mark out of stock: %v", err)
	}

	if _, err := svc.Settle(context.Background(), settleRequest(mintFor(t, signer, "a1", 450, now))); !errors.Is(err, ErrOutOfStock) {
		t.Fatalf("Settle returned %v, want ErrOutOfStock", err)
	}
}

// A claim landing between this caller's verify and its own claim is an ordinary
// race rather than an error. The loser spent one verify call, which moves no
// value, and gets a clean replay rejection.
func TestLosingTheClaimRaceAfterVerificationReportsAReplay(t *testing.T) {
	fac := acceptingFacilitator()
	svc, signer, store := newServiceUnderTest(t, fac)

	now := time.Now()
	svc.now = func() time.Time { return now }

	fac.onVerify = func() {
		p := pending("a1")
		p.SettlementID = "stl_someone_else"
		if err := store.Begin(context.Background(), p); err != nil {
			t.Errorf("competing claim failed: %v", err)
		}
		fac.onVerify = nil
	}

	if _, err := svc.Settle(context.Background(), settleRequest(mintFor(t, signer, "a1", 450, now))); !errors.Is(err, ErrAssertionReused) {
		t.Fatalf("Settle returned %v, want ErrAssertionReused", err)
	}
	if fac.settleCalls != 0 {
		t.Errorf("settle ran %d times after losing the claim race", fac.settleCalls)
	}
}
