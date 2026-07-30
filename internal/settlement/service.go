package settlement

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

var (
	ErrOutOfStock       = errors.New("listing is out of stock")
	ErrAmountMismatch   = errors.New("gross amount does not match the listing price")
	ErrCurrencyMismatch = errors.New("currency does not match the listing currency")
)

type Request struct {
	Assertion           attribution.Assertion `json:"assertion"`
	MerchantID          string                `json:"merchant_id"`
	GrossAmountCents    int64                 `json:"gross_amount_cents"`
	Currency            string                `json:"currency"`
	PaymentPayload      PaymentPayload        `json:"payment_payload"`
	PaymentRequirements PaymentRequirements   `json:"payment_requirements"`
}

type Result struct {
	SettlementID          string `json:"settlement_id"`
	Status                string `json:"status"`
	TxHash                string `json:"tx_hash"`
	Network               string `json:"network"`
	Payer                 string `json:"payer"`
	CommissionBps         int    `json:"commission_bps"`
	CommissionAmountCents int64  `json:"commission_amount_cents"`
	PlatformFeeCents      int64  `json:"platform_fee_cents"`
	PublisherAmountCents  int64  `json:"publisher_amount_cents"`
}

type Service struct {
	store       *Store
	verifier    *attribution.Verifier
	facilitator Facilitator
	now         func() time.Time
	newID       func() string
}

func NewService(store *Store, verifier *attribution.Verifier, facilitator Facilitator) *Service {
	return &Service{
		store:       store,
		verifier:    verifier,
		facilitator: facilitator,
		now:         time.Now,
		newID:       uuid.NewString,
	}
}

// effectiveCommissionBps reconciles the rate the assertion carries against the
// rate the chosen merchant currently publishes. Search mints the assertion with
// the best rate across every offer on the product, so the merchant the agent
// actually picked may publish less. Taking the lower of the two keeps the
// signed rate as a ceiling the publisher cannot exceed while never charging a
// merchant more than its own listing advertises.
func effectiveCommissionBps(signedBps, listingBps int) int {
	if listingBps < signedBps {
		return listingBps
	}
	return signedBps
}

// Settle runs the state machine. Ordering carries the correctness argument:
// the assertion is verified and the payment checked before anything durable
// happens, the claim and the pending row commit together, and only then does
// value move. A failure after the claim leaves a failed settlement rather than
// a silently reusable assertion.
func (s *Service) Settle(ctx context.Context, req Request) (Result, error) {
	now := s.now()

	if err := s.verifier.Verify(req.Assertion, now); err != nil {
		return Result{}, fmt.Errorf("verify assertion: %w", err)
	}

	listing, err := s.store.LookupListing(ctx, req.Assertion.ProductID, req.MerchantID)
	if err != nil {
		return Result{}, err
	}
	if !listing.InStock {
		return Result{}, ErrOutOfStock
	}
	if listing.Currency != req.Currency {
		return Result{}, fmt.Errorf("%w: listing %s, payment %s", ErrCurrencyMismatch, listing.Currency, req.Currency)
	}
	if listing.PriceCents != req.GrossAmountCents {
		return Result{}, fmt.Errorf("%w: listing %d, payment %d", ErrAmountMismatch, listing.PriceCents, req.GrossAmountCents)
	}

	bps := effectiveCommissionBps(req.Assertion.CommissionBps, listing.CommissionBps)
	split := attribution.CalculateCommission(req.GrossAmountCents, bps)

	// The facilitator check runs before the claim so a malformed payload costs
	// the caller a round trip rather than the assertion. Verify moves no value,
	// so a caller that loses the claim race afterwards has spent nothing.
	verified, err := s.facilitator.Verify(ctx, req.PaymentPayload, req.PaymentRequirements)
	if err != nil {
		return Result{}, err
	}
	if !verified.IsValid {
		return Result{}, fmt.Errorf("%w: %s", ErrPaymentInvalid, verified.InvalidReason)
	}

	pending := PendingSettlement{
		SettlementID:     s.newID(),
		AssertionID:      req.Assertion.AssertionID,
		SearchRequestID:  req.Assertion.SearchRequestID,
		PublisherID:      req.Assertion.PublisherID,
		MerchantID:       req.MerchantID,
		ProductID:        req.Assertion.ProductID,
		GrossAmountCents: req.GrossAmountCents,
		Currency:         req.Currency,
		CommissionBps:    bps,
		Split:            split,
		ChainNetwork:     req.PaymentRequirements.Network,
	}

	if err := s.store.Begin(ctx, pending); err != nil {
		return Result{}, err
	}

	settled, err := s.facilitator.Settle(ctx, req.PaymentPayload, req.PaymentRequirements)
	if err != nil {
		return Result{}, errors.Join(err, s.store.Fail(ctx, pending.SettlementID))
	}
	if !settled.Success {
		failure := fmt.Errorf("%w: %s", ErrSettlementFailed, settled.ErrorReason)
		return Result{}, errors.Join(failure, s.store.Fail(ctx, pending.SettlementID))
	}

	if err := s.store.Confirm(ctx, pending, settled.Transaction, s.now()); err != nil {
		return Result{}, err
	}

	return Result{
		SettlementID:          pending.SettlementID,
		Status:                StatusConfirmed,
		TxHash:                settled.Transaction,
		Network:               settled.Network,
		Payer:                 settled.Payer,
		CommissionBps:         bps,
		CommissionAmountCents: split.CommissionAmountCents,
		PlatformFeeCents:      split.PlatformFeeCents,
		PublisherAmountCents:  split.PublisherAmountCents,
	}, nil
}
