.DEFAULT_GOAL := help
.PHONY: help keys up seed demo dashboard down clean logs ps test test-go test-ts test-php lint fixture

# Key material lives outside the working tree, and the Makefile passes its
# location to compose explicitly rather than relying on the ./.env compose
# reads by default. Gitignoring a key file stops it being committed, not being
# read: editor extensions, language servers, AI assistants, and any dependency
# with a postinstall script all have filesystem access to this directory.
#
# Override to put it anywhere, for instance:
#   make up ENV_FILE=/mnt/c/Users/HCrai/.agent-secrets/agentic-attribution.env
ENV_FILE ?= $(HOME)/.agentic-attribution/env

COMPOSE := docker compose --env-file $(ENV_FILE)

## help: show every target
help:
	@echo "agentic-attribution"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  make /' | sort
	@echo ""
	@echo "First run:  make keys && make up && make seed && make demo"

## keys: generate the Ed25519 signing keypair outside the repository, once
keys:
	@if [ -f $(ENV_FILE) ]; then \
		echo "$(ENV_FILE) exists already; delete it to rotate the keypair"; \
	else \
		mkdir -p $(dir $(ENV_FILE)); \
		chmod 700 $(dir $(ENV_FILE)); \
		echo "Generating an Ed25519 keypair into $(ENV_FILE)"; \
		if command -v go > /dev/null 2>&1; then \
			go run ./cmd/keygen > $(ENV_FILE); \
		else \
			echo "No Go on the host, so generating through Docker instead."; \
			docker build -q -f docker/go.Dockerfile -t agentic-attribution-tools . > /dev/null; \
			docker run --rm agentic-attribution-tools keygen > $(ENV_FILE); \
		fi; \
		echo "MERCHANT_PAY_TO_ADDRESS=0x1111111111111111111111111111111111111111" >> $(ENV_FILE); \
		chmod 600 $(ENV_FILE); \
		echo "Done. The key sits outside the repository, where nothing with"; \
		echo "read access to the working tree can reach it."; \
	fi

## up: start every service (postgres, opensearch, go services, node services, dashboard)
up: $(ENV_FILE)
	$(COMPOSE) up -d --build
	@echo ""
	@echo "Waiting for OpenSearch, which takes the longest..."
	@$(COMPOSE) ps

## seed: generate the catalog and load it into Postgres and OpenSearch
seed: $(ENV_FILE)
	$(COMPOSE) --profile seed up --build --abort-on-container-failure generate ingest

## demo: run the agent through search, 402, payment, settlement, and a failed replay
demo: $(ENV_FILE)
	$(COMPOSE) --profile demo run --rm --build simulator

## dashboard: open the publisher dashboard
dashboard:
	@echo "http://localhost:8000"

## ps: show container status
ps:
	$(COMPOSE) ps

## logs: follow logs for every service
logs:
	$(COMPOSE) logs -f

## down: stop every service, keeping the data
down:
	$(COMPOSE) --profile seed --profile demo down

## clean: stop everything and delete the volumes, so the next seed starts empty
clean:
	$(COMPOSE) --profile seed --profile demo down -v

## test: run the Go, TypeScript, and PHP suites
test: test-go test-ts test-php

## test-go: go vet and go test
test-go:
	go vet ./...
	go test ./...

## test-ts: every TypeScript workspace suite
test-ts:
	npm test --workspaces --if-present

## test-php: the dashboard suite
test-php:
	cd app && php -d error_reporting=E_ALL tests/run.php

## lint: gofmt, tsc, and php -l across everything
lint:
	@test -z "$$(gofmt -l . | grep -v node_modules)" || (gofmt -l . | grep -v node_modules; exit 1)
	npm run typecheck --workspaces --if-present
	@find app -name '*.php' -print0 | xargs -0 -n1 php -l > /dev/null

## fixture: regenerate the Go-minted cross-language test vector
fixture:
	go run ./cmd/fixture > packages/types/src/__fixtures__/go-minted-assertion.json

# Every target needing the keypair depends on this, so a missing key file
# produces one instruction rather than a wall of compose interpolation errors.
$(ENV_FILE):
	@echo "No key file at $(ENV_FILE). Run: make keys"
	@exit 1
