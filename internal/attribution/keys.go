package attribution

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

// Key material arrives through the environment rather than through files
// inside the project. A signing key sitting in the working tree is readable by
// every tool with filesystem access, including editor extensions and any
// dependency with a postinstall script. Gitignoring it prevents committing,
// not reading.
const (
	EnvPrivateKey = "ATTRIBUTION_PRIVATE_KEY"
	EnvPublicKey  = "ATTRIBUTION_PUBLIC_KEY"
)

type KeyPair struct {
	Public  ed25519.PublicKey
	Private ed25519.PrivateKey
}

// GenerateKeyPair produces a fresh pair and its base64 encodings, for seeding
// a local environment.
func GenerateKeyPair() (KeyPair, string, string, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, "", "", fmt.Errorf("generate key: %w", err)
	}

	return KeyPair{Public: pub, Private: priv},
		base64.StdEncoding.EncodeToString(priv),
		base64.StdEncoding.EncodeToString(pub),
		nil
}

// LoadPrivateKey reads the signing key. Only the minting service needs this.
func LoadPrivateKey() (ed25519.PrivateKey, error) {
	encoded := strings.TrimSpace(os.Getenv(EnvPrivateKey))
	if encoded == "" {
		return nil, fmt.Errorf("%s not set; generate one with `go run ./cmd/keygen`", EnvPrivateKey)
	}

	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", EnvPrivateKey, err)
	}

	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("%s holds %d bytes, expected %d", EnvPrivateKey, len(raw), ed25519.PrivateKeySize)
	}

	return ed25519.PrivateKey(raw), nil
}

// LoadPublicKey reads the verification key. Merchants and the edge worker need
// only this half, which is the entire point of an asymmetric scheme: verifiers
// never hold anything that lets them forge.
func LoadPublicKey() (ed25519.PublicKey, error) {
	encoded := strings.TrimSpace(os.Getenv(EnvPublicKey))
	if encoded == "" {
		return nil, fmt.Errorf("%s not set", EnvPublicKey)
	}

	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", EnvPublicKey, err)
	}

	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%s holds %d bytes, expected %d", EnvPublicKey, len(raw), ed25519.PublicKeySize)
	}

	return ed25519.PublicKey(raw), nil
}
