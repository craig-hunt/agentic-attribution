// Package attribution mints and verifies the signed assertions that carry
// commission attribution across the agent boundary. See docs/adr/0003.
package attribution

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	TTL                 = time.Hour
	BasisPointsDivisor  = 10_000
	PlatformFeeShareBps = 3000
	SignaturePrefix     = "ed25519:"
)

var (
	ErrMalformedSignature = errors.New("signature missing the ed25519 prefix")
	ErrInvalidSignature   = errors.New("signature does not verify against the public key")
	ErrExpired            = errors.New("assertion expired")
	ErrCommissionRange    = errors.New("commission_bps outside 0..10000")
)

// Assertion mirrors packages/types/assertion.schema.json. Field order in the
// struct matters: canonicalize marshals a fixed-order shadow struct so Go and
// TypeScript produce byte-identical signing input.
type Assertion struct {
	AssertionID     string `json:"assertion_id"`
	PublisherID     string `json:"publisher_id"`
	ProductID       string `json:"product_id"`
	SearchRequestID string `json:"search_request_id"`
	IssuedAt        string `json:"issued_at"`
	ExpiresAt       string `json:"expires_at"`
	CommissionBps   int    `json:"commission_bps"`
	Signature       string `json:"signature"`
}

// unsigned carries exactly the fields the signature covers, in the exact order
// the TypeScript canonicalizeForSigning emits them. Any divergence here breaks
// cross-language verification, which is the failure the Cypress suite catches.
type unsigned struct {
	AssertionID     string `json:"assertion_id"`
	PublisherID     string `json:"publisher_id"`
	ProductID       string `json:"product_id"`
	SearchRequestID string `json:"search_request_id"`
	IssuedAt        string `json:"issued_at"`
	ExpiresAt       string `json:"expires_at"`
	CommissionBps   int    `json:"commission_bps"`
}

func canonicalize(a Assertion) ([]byte, error) {
	return json.Marshal(unsigned{
		AssertionID:     a.AssertionID,
		PublisherID:     a.PublisherID,
		ProductID:       a.ProductID,
		SearchRequestID: a.SearchRequestID,
		IssuedAt:        a.IssuedAt,
		ExpiresAt:       a.ExpiresAt,
		CommissionBps:   a.CommissionBps,
	})
}

type Signer struct {
	privateKey ed25519.PrivateKey
}

func NewSigner(privateKey ed25519.PrivateKey) *Signer {
	return &Signer{privateKey: privateKey}
}

// Mint produces a signed assertion valid for TTL from issuedAt. The caller
// supplies issuedAt rather than the function reading the clock, so tests
// control time without a clock abstraction.
func (s *Signer) Mint(
	assertionID, publisherID, productID, searchRequestID string,
	commissionBps int,
	issuedAt time.Time,
) (Assertion, error) {
	if commissionBps < 0 || commissionBps > BasisPointsDivisor {
		return Assertion{}, ErrCommissionRange
	}

	a := Assertion{
		AssertionID:     assertionID,
		PublisherID:     publisherID,
		ProductID:       productID,
		SearchRequestID: searchRequestID,
		IssuedAt:        issuedAt.UTC().Format(time.RFC3339),
		ExpiresAt:       issuedAt.Add(TTL).UTC().Format(time.RFC3339),
		CommissionBps:   commissionBps,
	}

	payload, err := canonicalize(a)
	if err != nil {
		return Assertion{}, fmt.Errorf("canonicalize: %w", err)
	}

	sig := ed25519.Sign(s.privateKey, payload)
	a.Signature = SignaturePrefix + base64.StdEncoding.EncodeToString(sig)

	return a, nil
}

type Verifier struct {
	publicKey ed25519.PublicKey
}

func NewVerifier(publicKey ed25519.PublicKey) *Verifier {
	return &Verifier{publicKey: publicKey}
}

// Verify checks the signature and the expiry. Replay detection is not handled
// here because it requires durable state; the settlement service checks the
// consumed_assertions table separately.
func (v *Verifier) Verify(a Assertion, now time.Time) error {
	if !strings.HasPrefix(a.Signature, SignaturePrefix) {
		return ErrMalformedSignature
	}

	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(a.Signature, SignaturePrefix))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrMalformedSignature, err)
	}

	payload, err := canonicalize(a)
	if err != nil {
		return fmt.Errorf("canonicalize: %w", err)
	}

	if !ed25519.Verify(v.publicKey, payload, raw) {
		return ErrInvalidSignature
	}

	expires, err := time.Parse(time.RFC3339, a.ExpiresAt)
	if err != nil {
		return fmt.Errorf("parse expires_at: %w", err)
	}

	if !now.Before(expires) {
		return ErrExpired
	}

	return nil
}

type CommissionSplit struct {
	CommissionAmountCents int64 `json:"commission_amount_cents"`
	PlatformFeeCents      int64 `json:"platform_fee_cents"`
	PublisherAmountCents  int64 `json:"publisher_amount_cents"`
}

// CalculateCommission splits gross into platform and publisher shares. Integer
// truncation is deliberate and the publisher absorbs the remainder, so the
// three values always sum exactly and the ledger's balance constraint holds.
func CalculateCommission(grossAmountCents int64, commissionBps int) CommissionSplit {
	commission := (grossAmountCents * int64(commissionBps)) / BasisPointsDivisor
	platformFee := (commission * PlatformFeeShareBps) / BasisPointsDivisor

	return CommissionSplit{
		CommissionAmountCents: commission,
		PlatformFeeCents:      platformFee,
		PublisherAmountCents:  commission - platformFee,
	}
}
