package attribution

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const (
	testAssertionID     = "018f4a2b-7c31-7000-8000-abcdef123456"
	testPublisherID     = "pub_a1b2c3"
	testProductID       = "prod_x7y8z9"
	testSearchRequestID = "req_m4n5p6"
	testCommissionBps   = 450
)

var testIssuedAt = time.Date(2026, 8, 2, 14, 22, 11, 0, time.UTC)

func newKeyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return pub, priv
}

func mintValid(t *testing.T, signer *Signer) Assertion {
	t.Helper()
	a, err := signer.Mint(
		testAssertionID,
		testPublisherID,
		testProductID,
		testSearchRequestID,
		testCommissionBps,
		testIssuedAt,
	)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	return a
}

func TestMintSetsExpiryOneHourAfterIssue(t *testing.T) {
	_, priv := newKeyPair(t)
	a := mintValid(t, NewSigner(priv))

	expires, err := time.Parse(time.RFC3339, a.ExpiresAt)
	if err != nil {
		t.Fatalf("parse expires_at: %v", err)
	}

	want := testIssuedAt.Add(TTL)
	if !expires.Equal(want) {
		t.Errorf("expires_at = %v, want %v", expires, want)
	}
}

func TestMintPrefixesSignatureWithScheme(t *testing.T) {
	_, priv := newKeyPair(t)
	a := mintValid(t, NewSigner(priv))

	if len(a.Signature) <= len(SignaturePrefix) || a.Signature[:len(SignaturePrefix)] != SignaturePrefix {
		t.Errorf("signature = %q, want prefix %q", a.Signature, SignaturePrefix)
	}
}

func TestMintRejectsCommissionOutsideRange(t *testing.T) {
	_, priv := newKeyPair(t)
	signer := NewSigner(priv)

	cases := []struct {
		name string
		bps  int
	}{
		{"negative", -1},
		{"above maximum", BasisPointsDivisor + 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := signer.Mint(
				testAssertionID, testPublisherID, testProductID, testSearchRequestID,
				tc.bps, testIssuedAt,
			)
			if err != ErrCommissionRange {
				t.Errorf("err = %v, want %v", err, ErrCommissionRange)
			}
		})
	}
}

func TestVerifyAcceptsFreshlyMintedAssertion(t *testing.T) {
	pub, priv := newKeyPair(t)
	a := mintValid(t, NewSigner(priv))

	if err := NewVerifier(pub).Verify(a, testIssuedAt); err != nil {
		t.Errorf("Verify() = %v, want nil", err)
	}
}

func TestVerifyRejectsTamperedFields(t *testing.T) {
	pub, priv := newKeyPair(t)
	base := mintValid(t, NewSigner(priv))
	verifier := NewVerifier(pub)

	cases := []struct {
		name  string
		mutTe func(a *Assertion)
	}{
		{"publisher redirected", func(a *Assertion) { a.PublisherID = "pub_attacker" }},
		{"product swapped", func(a *Assertion) { a.ProductID = "prod_other" }},
		{"commission inflated", func(a *Assertion) { a.CommissionBps = 9000 }},
		{"expiry extended", func(a *Assertion) { a.ExpiresAt = "2099-01-01T00:00:00Z" }},
		{"search request rebound", func(a *Assertion) { a.SearchRequestID = "req_forged" }},
		{"assertion id changed", func(a *Assertion) { a.AssertionID = "018f4a2b-7c31-7000-8000-000000000000" }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tampered := base
			tc.mutTe(&tampered)

			if err := verifier.Verify(tampered, testIssuedAt); err != ErrInvalidSignature {
				t.Errorf("Verify() = %v, want %v", err, ErrInvalidSignature)
			}
		})
	}
}

func TestVerifyRejectsSignatureFromAnotherKey(t *testing.T) {
	_, attackerPriv := newKeyPair(t)
	legitimatePub, _ := newKeyPair(t)

	forged := mintValid(t, NewSigner(attackerPriv))

	if err := NewVerifier(legitimatePub).Verify(forged, testIssuedAt); err != ErrInvalidSignature {
		t.Errorf("Verify() = %v, want %v", err, ErrInvalidSignature)
	}
}

func TestVerifyRejectsMalformedSignature(t *testing.T) {
	pub, priv := newKeyPair(t)
	base := mintValid(t, NewSigner(priv))
	verifier := NewVerifier(pub)

	cases := []struct {
		name string
		sig  string
	}{
		{"missing prefix", "AAAA"},
		{"empty", ""},
		{"prefix only", SignaturePrefix},
		{"not base64", SignaturePrefix + "!!!not-base64!!!"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := base
			a.Signature = tc.sig

			err := verifier.Verify(a, testIssuedAt)
			if err == nil {
				t.Fatal("Verify() = nil, want error")
			}
		})
	}
}

func TestVerifyRejectsExpiredAssertion(t *testing.T) {
	pub, priv := newKeyPair(t)
	a := mintValid(t, NewSigner(priv))

	atExpiry := testIssuedAt.Add(TTL)
	pastExpiry := testIssuedAt.Add(TTL + time.Second)

	t.Run("exactly at expiry", func(t *testing.T) {
		if err := NewVerifier(pub).Verify(a, atExpiry); err != ErrExpired {
			t.Errorf("Verify() = %v, want %v", err, ErrExpired)
		}
	})

	t.Run("past expiry", func(t *testing.T) {
		if err := NewVerifier(pub).Verify(a, pastExpiry); err != ErrExpired {
			t.Errorf("Verify() = %v, want %v", err, ErrExpired)
		}
	})

	t.Run("one second before expiry", func(t *testing.T) {
		justInside := testIssuedAt.Add(TTL - time.Second)
		if err := NewVerifier(pub).Verify(a, justInside); err != nil {
			t.Errorf("Verify() = %v, want nil", err)
		}
	})
}

func TestCalculateCommissionSplitsSumExactly(t *testing.T) {
	cases := []struct {
		name  string
		gross int64
		bps   int
	}{
		{"round hundred", 10_000, 450},
		{"odd amount forcing truncation", 9_999, 733},
		{"single cent", 1, 450},
		{"zero commission", 10_000, 0},
		{"full commission", 10_000, BasisPointsDivisor},
		{"large amount", 999_999_999, 275},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := CalculateCommission(tc.gross, tc.bps)

			sum := got.PlatformFeeCents + got.PublisherAmountCents
			if sum != got.CommissionAmountCents {
				t.Errorf("platform %d + publisher %d = %d, want commission %d",
					got.PlatformFeeCents, got.PublisherAmountCents, sum, got.CommissionAmountCents)
			}

			if got.PlatformFeeCents < 0 || got.PublisherAmountCents < 0 {
				t.Errorf("negative split: platform %d, publisher %d",
					got.PlatformFeeCents, got.PublisherAmountCents)
			}
		})
	}
}

func TestCalculateCommissionKnownValues(t *testing.T) {
	got := CalculateCommission(10_000, 450)

	if got.CommissionAmountCents != 450 {
		t.Errorf("commission = %d, want 450", got.CommissionAmountCents)
	}
	if got.PlatformFeeCents != 135 {
		t.Errorf("platform fee = %d, want 135", got.PlatformFeeCents)
	}
	if got.PublisherAmountCents != 315 {
		t.Errorf("publisher amount = %d, want 315", got.PublisherAmountCents)
	}
}

func TestCalculateCommissionPublisherAbsorbsTruncationRemainder(t *testing.T) {
	// 7 cents at 3000bps platform share truncates to 2, leaving 5 for the
	// publisher rather than losing a cent to rounding.
	got := CalculateCommission(100, 700)

	if got.CommissionAmountCents != 7 {
		t.Fatalf("commission = %d, want 7", got.CommissionAmountCents)
	}
	if got.PlatformFeeCents != 2 {
		t.Errorf("platform fee = %d, want 2", got.PlatformFeeCents)
	}
	if got.PublisherAmountCents != 5 {
		t.Errorf("publisher amount = %d, want 5", got.PublisherAmountCents)
	}
}

// The signing payload crosses a language boundary, so its exact bytes form part
// of the contract rather than an implementation detail. This pins them.
func TestCanonicalizeMatchesJavaScriptStringify(t *testing.T) {
	a := Assertion{
		AssertionID:     "a1",
		PublisherID:     "pub-1",
		ProductID:       "prod-1",
		SearchRequestID: "sr-1",
		IssuedAt:        "2026-07-30T12:00:00Z",
		ExpiresAt:       "2026-07-30T13:00:00Z",
		CommissionBps:   750,
		Signature:       "ed25519:ignored",
	}

	got, err := canonicalize(a)
	if err != nil {
		t.Fatalf("canonicalize returned %v", err)
	}

	const want = `{"assertion_id":"a1","publisher_id":"pub-1","product_id":"prod-1",` +
		`"search_request_id":"sr-1","issued_at":"2026-07-30T12:00:00Z",` +
		`"expires_at":"2026-07-30T13:00:00Z","commission_bps":750}`

	if string(got) != want {
		t.Fatalf("canonical bytes diverged from JSON.stringify\n got: %s\nwant: %s", got, want)
	}
}

// json.Marshal would escape these three characters and JSON.stringify would
// not, which is the divergence SetEscapeHTML(false) removes.
func TestCanonicalizeLeavesHTMLCharactersUnescaped(t *testing.T) {
	a := Assertion{
		AssertionID:     "a<1>",
		PublisherID:     "pub&co",
		ProductID:       "prod-1",
		SearchRequestID: "sr-1",
		IssuedAt:        "2026-07-30T12:00:00Z",
		ExpiresAt:       "2026-07-30T13:00:00Z",
		CommissionBps:   750,
	}

	got, err := canonicalize(a)
	if err != nil {
		t.Fatalf("canonicalize returned %v", err)
	}

	// Comparing against json.Marshal proves the escaping is off rather than
	// asserting on escape sequences directly. Marshal HTML-escapes by default,
	// so identical output would mean canonicalize still escapes and the two
	// languages would sign different bytes for the same assertion.
	marshaled, err := json.Marshal(unsigned{
		AssertionID:     a.AssertionID,
		PublisherID:     a.PublisherID,
		ProductID:       a.ProductID,
		SearchRequestID: a.SearchRequestID,
		IssuedAt:        a.IssuedAt,
		ExpiresAt:       a.ExpiresAt,
		CommissionBps:   a.CommissionBps,
	})
	if err != nil {
		t.Fatalf("json.Marshal returned %v", err)
	}

	if bytes.Equal(got, marshaled) {
		t.Fatalf("canonicalize still HTML-escapes, so Go and TypeScript sign different bytes:\n%s", got)
	}

	for _, raw := range []string{`"assertion_id":"a<1>"`, `"publisher_id":"pub&co"`} {
		if !strings.Contains(string(got), raw) {
			t.Fatalf("expected %s to survive unescaped:\n%s", raw, got)
		}
	}
}
