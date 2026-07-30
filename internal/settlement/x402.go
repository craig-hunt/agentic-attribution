// Package settlement runs the x402 payment state machine and writes the
// double-entry commission ledger. See docs/adr/0004.
package settlement

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	X402Version = 1
	SchemeExact = "exact"

	verifyPath = "/verify"
	settlePath = "/settle"

	facilitatorTimeout = 20 * time.Second

	// Bounded so a hostile or broken facilitator cannot exhaust memory on a
	// path that only ever returns a few hundred bytes.
	maxFacilitatorResponseBytes = 64 << 10
)

var (
	ErrFacilitatorUnavailable = errors.New("facilitator unreachable")
	ErrPaymentInvalid         = errors.New("facilitator rejected the payment payload")
	ErrSettlementFailed       = errors.New("facilitator failed to settle")
)

// The facilitator wire format is camelCase and is fixed by the x402 spec. The
// domain types elsewhere in this repo are snake_case. Keeping the two shapes in
// separate structs means a spec change touches this file alone.

type Eip3009Authorization struct {
	From        string `json:"from"`
	To          string `json:"to"`
	Value       string `json:"value"`
	ValidAfter  string `json:"validAfter"`
	ValidBefore string `json:"validBefore"`
	Nonce       string `json:"nonce"`
}

type PaymentPayload struct {
	X402Version   int                  `json:"x402Version"`
	Scheme        string               `json:"scheme"`
	Network       string               `json:"network"`
	Authorization Eip3009Authorization `json:"authorization"`
	Signature     string               `json:"signature"`
}

type PaymentRequirements struct {
	Scheme            string `json:"scheme"`
	Network           string `json:"network"`
	Asset             string `json:"asset"`
	MaxAmountRequired string `json:"maxAmountRequired"`
	PayTo             string `json:"payTo"`
	MaxTimeoutSeconds int    `json:"maxTimeoutSeconds"`
	Resource          string `json:"resource"`
	Description       string `json:"description"`
}

type facilitatorRequest struct {
	X402Version         int                 `json:"x402Version"`
	PaymentPayload      PaymentPayload      `json:"paymentPayload"`
	PaymentRequirements PaymentRequirements `json:"paymentRequirements"`
}

type VerifyResponse struct {
	IsValid       bool   `json:"isValid"`
	InvalidReason string `json:"invalidReason,omitempty"`
	Payer         string `json:"payer,omitempty"`
}

type SettleResponse struct {
	Success     bool   `json:"success"`
	ErrorReason string `json:"errorReason,omitempty"`
	Transaction string `json:"transaction,omitempty"`
	Network     string `json:"network,omitempty"`
	Payer       string `json:"payer,omitempty"`
}

// Facilitator is the seam the tests replace. The real implementation talks to
// the Coinbase x402 facilitator; the test double returns canned outcomes.
type Facilitator interface {
	Verify(ctx context.Context, payload PaymentPayload, req PaymentRequirements) (VerifyResponse, error)
	Settle(ctx context.Context, payload PaymentPayload, req PaymentRequirements) (SettleResponse, error)
}

type HTTPFacilitator struct {
	baseURL string
	client  *http.Client
}

func NewHTTPFacilitator(baseURL string) *HTTPFacilitator {
	return &HTTPFacilitator{
		baseURL: baseURL,
		client:  &http.Client{Timeout: facilitatorTimeout},
	}
}

func (f *HTTPFacilitator) Verify(
	ctx context.Context,
	payload PaymentPayload,
	req PaymentRequirements,
) (VerifyResponse, error) {
	var out VerifyResponse
	err := f.post(ctx, verifyPath, payload, req, &out)
	return out, err
}

// Settle carries no retry. A timeout leaves the on-chain outcome unknown, and
// resending an EIP-3009 authorization that already landed risks a second
// transfer. Recovery belongs to a reconciler that reads chain state, not to a
// blind retry on the request path.
func (f *HTTPFacilitator) Settle(
	ctx context.Context,
	payload PaymentPayload,
	req PaymentRequirements,
) (SettleResponse, error) {
	var out SettleResponse
	err := f.post(ctx, settlePath, payload, req, &out)
	return out, err
}

func (f *HTTPFacilitator) post(
	ctx context.Context,
	path string,
	payload PaymentPayload,
	requirements PaymentRequirements,
	out any,
) error {
	body, err := json.Marshal(facilitatorRequest{
		X402Version:         X402Version,
		PaymentPayload:      payload,
		PaymentRequirements: requirements,
	})
	if err != nil {
		return fmt.Errorf("marshal facilitator request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build facilitator request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrFacilitatorUnavailable, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxFacilitatorResponseBytes))
	if err != nil {
		return fmt.Errorf("%w: read body: %v", ErrFacilitatorUnavailable, err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: status %d: %s", ErrFacilitatorUnavailable, resp.StatusCode, string(raw))
	}

	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%w: decode body: %v", ErrFacilitatorUnavailable, err)
	}

	return nil
}
