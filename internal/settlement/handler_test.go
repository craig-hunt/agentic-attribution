package settlement

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newHandlerUnderTest(t *testing.T, fac Facilitator) (http.Handler, *attribution.Signer, *Store) {
	t.Helper()

	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	store, _ := newStore(t)
	svc := NewService(store, attribution.NewVerifier(public), fac)

	return NewHandler(svc, discardLogger()).Routes(), attribution.NewSigner(private), store
}

func getJSON(t *testing.T, routes http.Handler, path string, into any) int {
	t.Helper()

	rec := httptest.NewRecorder()
	routes.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

	if into != nil && rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), into); err != nil {
			t.Fatalf("decode %s: %v (body %s)", path, err, rec.Body.String())
		}
	}

	return rec.Code
}

func TestHealthEndpoint(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, acceptingFacilitator())

	var body map[string]string
	if code := getJSON(t, routes, "/healthz", &body); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %v", body)
	}
}

func TestListPublishersEndpoint(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, acceptingFacilitator())

	var body struct {
		Publishers []Publisher `json:"publishers"`
	}
	if code := getJSON(t, routes, "/publishers", &body); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if len(body.Publishers) != 1 || body.Publishers[0].PublisherID != testPublisherID {
		t.Fatalf("publishers = %+v", body.Publishers)
	}
}

func TestPublisherDetailEndpoint(t *testing.T) {
	routes, _, store := newHandlerUnderTest(t, acceptingFacilitator())
	confirmOne(t, store, "a1")

	var body struct {
		Summary     PublisherSummary `json:"summary"`
		Settlements []SettlementRow  `json:"settlements"`
	}
	if code := getJSON(t, routes, "/publishers/"+testPublisherID, &body); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}

	if body.Summary.SettlementCount != 1 {
		t.Errorf("settlement count = %d", body.Summary.SettlementCount)
	}
	if len(body.Settlements) != 1 {
		t.Fatalf("settlements = %d, want 1", len(body.Settlements))
	}
}

// The dashboard links to identifiers a reader can edit in the address bar, so
// an unknown publisher belongs in the 404 bucket rather than the 500 bucket.
func TestPublisherDetailReturns404ForAnUnknownPublisher(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, acceptingFacilitator())

	var body errorResponse
	if code := getJSON(t, routes, "/publishers/pub_nobody", &body); code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", code)
	}
	if body.Reason != "publisher_not_found" {
		t.Errorf("reason = %q", body.Reason)
	}
}

func TestPublisherDetailHonoursAndClampsTheLimit(t *testing.T) {
	routes, _, store := newHandlerUnderTest(t, acceptingFacilitator())

	for _, id := range []string{"a1", "a2", "a3"} {
		confirmOne(t, store, id)
	}

	cases := []struct {
		query string
		want  int
	}{
		{"", 3},
		{"?limit=2", 2},
		{"?limit=0", 3},
		{"?limit=-1", 3},
		{"?limit=notanumber", 3},
		{"?limit=99999", 3},
	}

	for _, tc := range cases {
		var body struct {
			Settlements []SettlementRow `json:"settlements"`
		}
		if code := getJSON(t, routes, "/publishers/"+testPublisherID+tc.query, &body); code != http.StatusOK {
			t.Fatalf("%q status = %d", tc.query, code)
		}
		if len(body.Settlements) != tc.want {
			t.Errorf("%q returned %d settlements, want %d", tc.query, len(body.Settlements), tc.want)
		}
	}
}

func TestChainEndpoint(t *testing.T) {
	routes, _, store := newHandlerUnderTest(t, acceptingFacilitator())
	p := confirmOne(t, store, "a1")

	var chain Chain
	if code := getJSON(t, routes, "/settlements/"+p.SettlementID+"/chain", &chain); code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}

	if chain.SettlementID != p.SettlementID || len(chain.Ledger) != 3 {
		t.Fatalf("chain = %+v", chain)
	}
}

func TestChainReturns404ForAnUnknownSettlement(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, acceptingFacilitator())

	var body errorResponse
	if code := getJSON(t, routes, "/settlements/stl_nobody/chain", &body); code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", code)
	}
	if body.Reason != "settlement_not_found" {
		t.Errorf("reason = %q", body.Reason)
	}
}

func postSettle(t *testing.T, routes http.Handler, body string) (int, errorResponse) {
	t.Helper()

	rec := httptest.NewRecorder()
	routes.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/settle", strings.NewReader(body)))

	var decoded errorResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &decoded)

	return rec.Code, decoded
}

func TestSettleEndpointConfirmsAValidPayment(t *testing.T) {
	routes, signer, _ := newHandlerUnderTest(t, acceptingFacilitator())

	a, err := signer.Mint("a1", testPublisherID, testProductID, testSearchRequestID, 450, time.Now())
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	payload, err := json.Marshal(settleRequest(a))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	rec := httptest.NewRecorder()
	routes.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/settle", strings.NewReader(string(payload))))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}

	var result Result
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.Status != StatusConfirmed || result.TxHash != "0xtx" {
		t.Fatalf("result = %+v", result)
	}
}

func TestSettleEndpointRejectsAMalformedBody(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, acceptingFacilitator())

	code, body := postSettle(t, routes, "{not json")
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", code)
	}
	if body.Reason != "bad_request" {
		t.Errorf("reason = %q", body.Reason)
	}
}

// The status a caller receives has to tell them whether retrying could ever
// help. A replay is permanent, an outage is not.
func TestSettleEndpointMapsFailuresToActionableStatuses(t *testing.T) {
	routes, signer, store := newHandlerUnderTest(t, acceptingFacilitator())

	a, err := signer.Mint("a1", testPublisherID, testProductID, testSearchRequestID, 450, time.Now())
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	p := pending("a1")
	if err := store.Begin(context.Background(), p); err != nil {
		t.Fatalf("pre-claim: %v", err)
	}

	payload, err := json.Marshal(settleRequest(a))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	code, body := postSettle(t, routes, string(payload))
	if code != http.StatusConflict {
		t.Fatalf("a replay returned %d, want 409", code)
	}
	if body.Reason != "assertion_reused" {
		t.Errorf("reason = %q", body.Reason)
	}
}

func TestUnknownRoutesAndMethods(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, acceptingFacilitator())

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/settle"},
		{http.MethodPost, "/publishers"},
		{http.MethodGet, "/nope"},
	}

	for _, tc := range cases {
		rec := httptest.NewRecorder()
		routes.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}")))

		if rec.Code == http.StatusOK {
			t.Errorf("%s %s returned 200, want a rejection", tc.method, tc.path)
		}
	}
}

// The merchant verifies an assertion before it forwards anything, so a
// tampered or expired one never reaches /settle. Without this endpoint the
// platform refuses an attack and records nothing, which is the logging failure
// the rejected_attempts table exists to prevent.
func TestRecordRejectionEndpointJournalsAReportedRefusal(t *testing.T) {
	routes, _, store := newHandlerUnderTest(t, &stubFacilitator{})

	body := `{"publisher_id":"` + testPublisherID + `","assertion_id":"a_reported",` +
		`"merchant_id":"mer_000042","reason":"invalid_signature","detail":"verify assertion"}`

	rec := httptest.NewRecorder()
	routes.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/rejections", strings.NewReader(body)))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusAccepted, rec.Body.String())
	}

	rows, err := store.RecentRejections(context.Background(), testPublisherID, 10)
	if err != nil {
		t.Fatalf("RecentRejections: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("journalled %d refusals, want 1", len(rows))
	}
	if rows[0].Reason != "invalid_signature" {
		t.Errorf("reason = %q, want invalid_signature", rows[0].Reason)
	}
}

// An attempt naming a publisher who does not exist is the signal worth
// keeping, so no foreign key discards it.
func TestRecordRejectionEndpointAcceptsAnUnknownPublisher(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, &stubFacilitator{})

	body := `{"publisher_id":"pub_999999","reason":"invalid_signature"}`

	rec := httptest.NewRecorder()
	routes.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/rejections", strings.NewReader(body)))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusAccepted)
	}
}

func TestRecordRejectionEndpointRefusesAnUnattributableReport(t *testing.T) {
	routes, _, _ := newHandlerUnderTest(t, &stubFacilitator{})

	for _, body := range []string{
		`{"reason":"invalid_signature"}`,
		`{"publisher_id":"` + testPublisherID + `"}`,
		`not json`,
	} {
		rec := httptest.NewRecorder()
		routes.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/rejections", strings.NewReader(body)))

		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %q returned %d, want %d", body, rec.Code, http.StatusBadRequest)
		}
	}
}
