package settlement

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

func TestEffectiveCommissionBpsTakesTheLower(t *testing.T) {
	cases := []struct {
		name      string
		signedBps int
		listing   int
		want      int
	}{
		{"listing below the signed ceiling", 900, 400, 400},
		{"listing above the signed ceiling", 400, 900, 400},
		{"rates agree", 500, 500, 500},
		{"merchant dropped to zero", 900, 0, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := effectiveCommissionBps(tc.signedBps, tc.listing); got != tc.want {
				t.Fatalf("effectiveCommissionBps(%d, %d) = %d, want %d",
					tc.signedBps, tc.listing, got, tc.want)
			}
		})
	}
}

// The ledger's balance depends entirely on the split summing to the commission.
// A split that loses a cent to truncation would fail the database CHECK at
// write time, which is a far worse place to discover it.
func TestSplitAlwaysSumsToCommission(t *testing.T) {
	grossAmounts := []int64{1, 7, 99, 100, 1_999, 12_999, 999_999, 1_000_000_007}
	rates := []int{0, 1, 37, 250, 499, 500, 1_234, 9_999, 10_000}

	for _, gross := range grossAmounts {
		for _, bps := range rates {
			split := attribution.CalculateCommission(gross, bps)

			if split.PlatformFeeCents+split.PublisherAmountCents != split.CommissionAmountCents {
				t.Fatalf("gross=%d bps=%d: %d + %d != %d",
					gross, bps,
					split.PlatformFeeCents, split.PublisherAmountCents, split.CommissionAmountCents)
			}

			if split.PlatformFeeCents < 0 || split.PublisherAmountCents < 0 {
				t.Fatalf("gross=%d bps=%d produced a negative share: %+v", gross, bps, split)
			}
		}
	}
}

// The three ledger entries sum to zero for any valid split. This mirrors the
// arithmetic in Store.Confirm without needing a database.
func TestLedgerEntriesBalance(t *testing.T) {
	grossAmounts := []int64{1, 999, 12_999, 4_500_000}
	rates := []int{0, 137, 750, 10_000}

	for _, gross := range grossAmounts {
		for _, bps := range rates {
			split := attribution.CalculateCommission(gross, bps)

			total := -split.CommissionAmountCents +
				split.PlatformFeeCents +
				split.PublisherAmountCents

			if total != 0 {
				t.Fatalf("gross=%d bps=%d: ledger entries sum to %d, want 0", gross, bps, total)
			}
		}
	}
}

type stubFacilitator struct {
	verify      VerifyResponse
	verifyErr   error
	settle      SettleResponse
	settleErr   error
	verifyCalls int
	settleCalls int
}

func (s *stubFacilitator) Verify(context.Context, PaymentPayload, PaymentRequirements) (VerifyResponse, error) {
	s.verifyCalls++
	return s.verify, s.verifyErr
}

func (s *stubFacilitator) Settle(context.Context, PaymentPayload, PaymentRequirements) (SettleResponse, error) {
	s.settleCalls++
	return s.settle, s.settleErr
}

func TestHTTPFacilitatorParsesVerifyAndSettle(t *testing.T) {
	var seen []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path)

		var body facilitatorRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if body.X402Version != X402Version {
			t.Errorf("x402Version = %d, want %d", body.X402Version, X402Version)
		}

		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case verifyPath:
			_ = json.NewEncoder(w).Encode(VerifyResponse{IsValid: true, Payer: "0xpayer"})
		case settlePath:
			_ = json.NewEncoder(w).Encode(SettleResponse{
				Success:     true,
				Transaction: "0xdeadbeef",
				Network:     "base-sepolia",
				Payer:       "0xpayer",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	f := NewHTTPFacilitator(srv.URL)

	v, err := f.Verify(context.Background(), PaymentPayload{}, PaymentRequirements{})
	if err != nil {
		t.Fatalf("Verify returned %v", err)
	}
	if !v.IsValid || v.Payer != "0xpayer" {
		t.Fatalf("Verify returned %+v", v)
	}

	s, err := f.Settle(context.Background(), PaymentPayload{}, PaymentRequirements{})
	if err != nil {
		t.Fatalf("Settle returned %v", err)
	}
	if !s.Success || s.Transaction != "0xdeadbeef" {
		t.Fatalf("Settle returned %+v", s)
	}

	if len(seen) != 2 || seen[0] != verifyPath || seen[1] != settlePath {
		t.Fatalf("paths called: %v", seen)
	}
}

func TestHTTPFacilitatorTreatsNon200AsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"down"}`))
	}))
	defer srv.Close()

	_, err := NewHTTPFacilitator(srv.URL).Verify(context.Background(), PaymentPayload{}, PaymentRequirements{})

	if !errors.Is(err, ErrFacilitatorUnavailable) {
		t.Fatalf("error = %v, want ErrFacilitatorUnavailable", err)
	}
}

// A 200 carrying success:false is a settlement failure, not a transport
// failure. Conflating the two would let a rejected payment retry against a
// path that assumes the facilitator never heard the request.
func TestHTTPFacilitatorDistinguishesRejectionFromOutage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(SettleResponse{Success: false, ErrorReason: "insufficient_funds"})
	}))
	defer srv.Close()

	got, err := NewHTTPFacilitator(srv.URL).Settle(context.Background(), PaymentPayload{}, PaymentRequirements{})
	if err != nil {
		t.Fatalf("Settle returned transport error %v, want a clean rejection", err)
	}
	if got.Success || got.ErrorReason != "insufficient_funds" {
		t.Fatalf("Settle returned %+v", got)
	}
}

func TestStatusForMapsFailuresToActionableCodes(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantReason string
	}{
		{"replay", ErrAssertionReused, http.StatusConflict, "assertion_reused"},
		{"expired", attribution.ErrExpired, http.StatusUnauthorized, "assertion_expired"},
		{"forged", attribution.ErrInvalidSignature, http.StatusUnauthorized, "assertion_signature_invalid"},
		{"malformed signature", attribution.ErrMalformedSignature, http.StatusUnauthorized, "assertion_signature_invalid"},
		{"unknown listing", ErrListingNotFound, http.StatusNotFound, "listing_not_found"},
		{"out of stock", ErrOutOfStock, http.StatusUnprocessableEntity, "listing_mismatch"},
		{"wrong amount", ErrAmountMismatch, http.StatusUnprocessableEntity, "listing_mismatch"},
		{"wrong currency", ErrCurrencyMismatch, http.StatusUnprocessableEntity, "listing_mismatch"},
		{"payment rejected", ErrPaymentInvalid, http.StatusPaymentRequired, "payment_invalid"},
		{"settlement rejected", ErrSettlementFailed, http.StatusPaymentRequired, "settlement_failed"},
		{"facilitator down", ErrFacilitatorUnavailable, http.StatusBadGateway, "facilitator_unavailable"},
		{"unrecognized", errors.New("something else"), http.StatusInternalServerError, "internal_error"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, reason := statusFor(tc.err)

			if status != tc.wantStatus {
				t.Errorf("status = %d, want %d", status, tc.wantStatus)
			}
			if reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", reason, tc.wantReason)
			}
		})
	}
}

// Wrapped errors must still map correctly, since the service decorates most
// failures with context before returning them.
func TestStatusForSeesThroughWrapping(t *testing.T) {
	wrapped := errors.Join(
		errors.New("settle: facilitator call failed"),
		ErrFacilitatorUnavailable,
	)

	status, reason := statusFor(wrapped)

	if status != http.StatusBadGateway || reason != "facilitator_unavailable" {
		t.Fatalf("statusFor(wrapped) = %d/%s", status, reason)
	}
}
