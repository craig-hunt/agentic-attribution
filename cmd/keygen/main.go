package main

import (
	"fmt"
	"log"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

// keygen prints a fresh Ed25519 pair for local use. Output goes to stdout so
// it can be redirected somewhere outside the repository rather than written
// into the working tree.
func main() {
	_, private, public, err := attribution.GenerateKeyPair()
	if err != nil {
		log.Fatalf("generate: %v", err)
	}

	fmt.Printf(`# Attribution signing key pair
#
# The private key belongs only to the service that mints assertions.
# Merchants and the edge worker need the public key alone, which is why an
# asymmetric scheme fits: a verifier holding the public key can never forge.
#
# Store this OUTSIDE the repository. Gitignoring a key file prevents it from
# being committed, not from being read by editor extensions, language servers,
# AI assistants, or any dependency with a postinstall script.

%s=%s
%s=%s
`,
		attribution.EnvPrivateKey, private,
		attribution.EnvPublicKey, public,
	)
}
