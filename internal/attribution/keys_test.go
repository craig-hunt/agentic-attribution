package attribution

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestGenerateKeyPairProducesAUsablePair(t *testing.T) {
	pair, privateEncoded, publicEncoded, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}

	if len(pair.Private) != ed25519.PrivateKeySize || len(pair.Public) != ed25519.PublicKeySize {
		t.Fatalf("key sizes = %d / %d", len(pair.Private), len(pair.Public))
	}

	// The encodings must round trip, because they cross a process boundary as
	// environment variables and nothing downstream can repair a bad one.
	decodedPrivate, err := base64.StdEncoding.DecodeString(privateEncoded)
	if err != nil {
		t.Fatalf("decode private: %v", err)
	}
	decodedPublic, err := base64.StdEncoding.DecodeString(publicEncoded)
	if err != nil {
		t.Fatalf("decode public: %v", err)
	}

	if string(decodedPrivate) != string(pair.Private) || string(decodedPublic) != string(pair.Public) {
		t.Fatal("the encoded halves do not match the generated pair")
	}

	// The pair has to actually work together, which is the only property that
	// matters and the one a length check cannot establish.
	issuedAt := time.Now()

	assertion, err := NewSigner(pair.Private).Mint("a1", "pub_1", "prd_1", "req_1", 450, issuedAt)
	if err != nil {
		t.Fatalf("mint with the generated key: %v", err)
	}
	if err := NewVerifier(pair.Public).Verify(assertion, issuedAt); err != nil {
		t.Fatalf("the generated public key does not verify its own signature: %v", err)
	}
}

func TestGenerateKeyPairProducesADifferentPairEachTime(t *testing.T) {
	_, firstPrivate, _, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("first: %v", err)
	}

	_, secondPrivate, _, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("second: %v", err)
	}

	if firstPrivate == secondPrivate {
		t.Fatal("two calls produced the same private key")
	}
}

func TestLoadPrivateKeyRoundTrips(t *testing.T) {
	pair, encoded, _, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}

	t.Setenv(EnvPrivateKey, encoded)

	loaded, err := LoadPrivateKey()
	if err != nil {
		t.Fatalf("LoadPrivateKey: %v", err)
	}
	if string(loaded) != string(pair.Private) {
		t.Fatal("the loaded key differs from the generated one")
	}
}

func TestLoadPublicKeyRoundTrips(t *testing.T) {
	pair, _, encoded, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}

	t.Setenv(EnvPublicKey, encoded)

	loaded, err := LoadPublicKey()
	if err != nil {
		t.Fatalf("LoadPublicKey: %v", err)
	}
	if string(loaded) != string(pair.Public) {
		t.Fatal("the loaded key differs from the generated one")
	}
}

// Surrounding whitespace survives a copy out of a terminal or a here-document
// far too easily, and a trailing newline would otherwise fail base64 decoding
// with an error that says nothing about its cause.
func TestLoadTrimsSurroundingWhitespace(t *testing.T) {
	_, privateEncoded, publicEncoded, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}

	t.Setenv(EnvPrivateKey, "  "+privateEncoded+"\n")
	t.Setenv(EnvPublicKey, "\t"+publicEncoded+"  \n")

	if _, err := LoadPrivateKey(); err != nil {
		t.Errorf("LoadPrivateKey with padding: %v", err)
	}
	if _, err := LoadPublicKey(); err != nil {
		t.Errorf("LoadPublicKey with padding: %v", err)
	}
}

// A missing key is the most common first-run failure. The message has to name
// the variable and the command that produces one, because the alternative is a
// signature failure nobody can trace back to configuration.
func TestAMissingKeyNamesTheVariableAndTheFix(t *testing.T) {
	t.Setenv(EnvPrivateKey, "")

	_, err := LoadPrivateKey()
	if err == nil {
		t.Fatal("LoadPrivateKey succeeded with nothing set")
	}
	if !strings.Contains(err.Error(), EnvPrivateKey) {
		t.Errorf("error does not name the variable: %v", err)
	}
	if !strings.Contains(err.Error(), "keygen") {
		t.Errorf("error does not point at the fix: %v", err)
	}

	t.Setenv(EnvPublicKey, "")
	if _, err := LoadPublicKey(); err == nil {
		t.Fatal("LoadPublicKey succeeded with nothing set")
	} else if !strings.Contains(err.Error(), EnvPublicKey) {
		t.Errorf("error does not name the variable: %v", err)
	}
}

func TestLoadRejectsUndecodableKeyMaterial(t *testing.T) {
	t.Setenv(EnvPrivateKey, "this is not base64!!!")
	if _, err := LoadPrivateKey(); err == nil {
		t.Error("LoadPrivateKey accepted undecodable material")
	}

	t.Setenv(EnvPublicKey, "@@@@")
	if _, err := LoadPublicKey(); err == nil {
		t.Error("LoadPublicKey accepted undecodable material")
	}
}

// A key of the wrong length decodes cleanly and then fails every signature
// check, which reads as a signing bug rather than a configuration one. Failing
// at load time puts the error where the cause is.
func TestLoadRejectsCorrectlyEncodedKeysOfTheWrongLength(t *testing.T) {
	cases := []struct {
		name  string
		bytes int
	}{
		{"far too short", 8},
		{"a public key supplied as a private key", ed25519.PublicKeySize},
		{"one byte over", ed25519.PrivateKeySize + 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(EnvPrivateKey, base64.StdEncoding.EncodeToString(make([]byte, tc.bytes)))

			_, err := LoadPrivateKey()
			if err == nil {
				t.Fatalf("LoadPrivateKey accepted %d bytes", tc.bytes)
			}
			if !strings.Contains(err.Error(), "expected") {
				t.Errorf("error does not state the expected size: %v", err)
			}
		})
	}

	t.Setenv(EnvPublicKey, base64.StdEncoding.EncodeToString(make([]byte, ed25519.PrivateKeySize)))
	if _, err := LoadPublicKey(); err == nil {
		t.Error("LoadPublicKey accepted a private-key-sized value")
	}
}
