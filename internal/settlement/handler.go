package settlement

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

const maxRequestBytes = 256 << 10

type Handler struct {
	svc *Service
	log *slog.Logger
}

func NewHandler(svc *Service, log *slog.Logger) *Handler {
	return &Handler{svc: svc, log: log}
}

func (h *Handler) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /settle", h.handleSettle)
	mux.HandleFunc("GET /healthz", h.handleHealth)

	return mux
}

type errorResponse struct {
	Error  string `json:"error"`
	Reason string `json:"reason"`
}

// statusFor maps a failure to the status the caller can act on. A reused
// assertion returns 409 rather than 400 because the request was well formed and
// the conflict is with prior state, which tells a retrying client that trying
// again will never succeed.
func statusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrAssertionReused):
		return http.StatusConflict, "assertion_reused"
	case errors.Is(err, attribution.ErrExpired):
		return http.StatusUnauthorized, "assertion_expired"
	case errors.Is(err, attribution.ErrInvalidSignature),
		errors.Is(err, attribution.ErrMalformedSignature):
		return http.StatusUnauthorized, "assertion_signature_invalid"
	case errors.Is(err, ErrListingNotFound):
		return http.StatusNotFound, "listing_not_found"
	case errors.Is(err, ErrOutOfStock),
		errors.Is(err, ErrAmountMismatch),
		errors.Is(err, ErrCurrencyMismatch):
		return http.StatusUnprocessableEntity, "listing_mismatch"
	case errors.Is(err, ErrPaymentInvalid):
		return http.StatusPaymentRequired, "payment_invalid"
	case errors.Is(err, ErrSettlementFailed):
		return http.StatusPaymentRequired, "settlement_failed"
	case errors.Is(err, ErrFacilitatorUnavailable):
		return http.StatusBadGateway, "facilitator_unavailable"
	default:
		return http.StatusInternalServerError, "internal_error"
	}
}

func (h *Handler) handleSettle(w http.ResponseWriter, r *http.Request) {
	var req Request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "malformed request body", Reason: "bad_request"})
		return
	}

	result, err := h.svc.Settle(r.Context(), req)
	if err != nil {
		status, reason := statusFor(err)

		h.log.Warn("settlement rejected",
			"assertion_id", req.Assertion.AssertionID,
			"publisher_id", req.Assertion.PublisherID,
			"merchant_id", req.MerchantID,
			"reason", reason,
			"error", err,
		)

		writeJSON(w, status, errorResponse{Error: err.Error(), Reason: reason})
		return
	}

	h.log.Info("settlement confirmed",
		"settlement_id", result.SettlementID,
		"publisher_id", req.Assertion.PublisherID,
		"merchant_id", req.MerchantID,
		"commission_bps", result.CommissionBps,
		"publisher_amount_cents", result.PublisherAmountCents,
		"tx_hash", result.TxHash,
	)

	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
