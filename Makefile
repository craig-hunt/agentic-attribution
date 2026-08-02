.DEFAULT_GOAL := help
.PHONY: help keys require-cwd require-keys up seed demo smoke smoke-cold dashboard down clean logs logs-once ps test test-docker test-go test-ts test-php mutate mutate-docker mutate-go mutate-ts mutate-php lint fixture

# Key material lives outside the working tree, and the Makefile passes its
# location to compose explicitly rather than relying on the ./.env compose
# reads by default. Gitignoring a key file stops it being committed, not being
# read: editor extensions, language servers, AI assistants, and any dependency
# with a postinstall script all have filesystem access to this directory.
#
# Override to put it anywhere, for instance:
#   make up ENV_FILE=/mnt/c/Users/HCrai/.agent-secrets/agentic-attribution.env
ENV_FILE ?= $(HOME)/.agentic-attribution/env

# Quoted at every use. ENV_FILE is user-supplied and the docs invite arbitrary
# paths, so a directory with a space in it must not split into two arguments.
COMPOSE := docker compose --env-file "$(ENV_FILE)"

## help: show every target
help:
	@echo "agentic-attribution"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  make /' | sort
	@echo ""
	@echo "First run:  make keys && make up && make seed && make demo"
	@echo "Verify:     make smoke-cold"

## keys: generate the Ed25519 signing keypair outside the repository, once
keys:
	@if [ -f "$(ENV_FILE)" ]; then \
		echo "$(ENV_FILE) exists already; delete it to rotate the keypair"; \
	else \
		dir=$$(dirname "$(ENV_FILE)"); \
		mkdir -p "$$dir"; \
		chmod 700 "$$dir"; \
		echo "Generating an Ed25519 keypair into $(ENV_FILE)"; \
		if command -v go > /dev/null 2>&1; then \
			go run ./cmd/keygen > "$(ENV_FILE)"; \
		else \
			echo "No Go on the host, so generating through Docker instead."; \
			docker build -q -f docker/go.Dockerfile -t agentic-attribution-tools . > /dev/null; \
			docker run --rm agentic-attribution-tools keygen > "$(ENV_FILE)"; \
		fi; \
		echo "MERCHANT_PAY_TO_ADDRESS=0x1111111111111111111111111111111111111111" >> "$(ENV_FILE)"; \
		chmod 600 "$(ENV_FILE)"; \
		echo "Done. The key sits outside the repository, where nothing with"; \
		echo "read access to the working tree can reach it."; \
	fi

## up: start every service (postgres, opensearch, go services, node services, dashboard)
up: require-cwd require-keys
	$(COMPOSE) up -d --build
	@echo ""
	@echo "Waiting for OpenSearch, which takes the longest..."
	@$(COMPOSE) ps

## seed: generate the catalog and load it into Postgres and OpenSearch
#
# The one-shot containers get removed either side of the run. `up` leaves them
# behind on exit, and a stopped container still holds the seed volume, so a
# failed seed would otherwise block both the retry and `make clean` with a
# "volume is in use" error that names container IDs rather than the cause.
seed: require-cwd require-keys
	-@$(COMPOSE) --profile seed rm -f generate ingest > /dev/null 2>&1
	$(COMPOSE) --profile seed up --build --abort-on-container-failure generate ingest
	-@$(COMPOSE) --profile seed rm -f generate ingest > /dev/null 2>&1

## demo: run the agent through search, 402, payment, settlement, and a failed replay
demo: require-cwd require-keys
	$(COMPOSE) --profile demo run --rm --build simulator

## smoke: drive the running stack end to end and assert it actually works
smoke: require-cwd require-keys
	$(COMPOSE) --profile smoke run --rm --build smoke

## smoke-cold: the out-of-the-box proof, from empty volumes through verification
#
# The only target that tests what the README promises. Everything else assumes
# a system that already came up. CI runs this one.
smoke-cold: require-cwd require-keys
	$(MAKE) clean
	$(MAKE) up
	$(MAKE) seed
	$(MAKE) smoke

## dashboard: open the publisher dashboard
dashboard:
	@echo "http://localhost:8000"

## ps: show container status
ps: require-cwd
	$(COMPOSE) ps

## logs: follow logs for every service
logs: require-cwd
	$(COMPOSE) logs -f

## logs-once: dump logs and exit, for CI and for pasting into an issue
logs-once: require-cwd
	$(COMPOSE) --profile seed --profile demo --profile smoke logs --no-color --tail=200

## down: stop every service, keeping the data
down: require-cwd
	$(COMPOSE) --profile seed --profile demo --profile smoke down

## clean: stop everything and delete the volumes, so the next seed starts empty
clean: require-cwd
	$(COMPOSE) --profile seed --profile demo --profile smoke down -v

## test-docker: run every suite in containers, needing only Docker
test-docker: require-cwd require-keys
	$(COMPOSE) --profile test up --build --abort-on-container-failure \
		--exit-code-from test-go test-go
	$(COMPOSE) --profile test run --rm --build test-ts
	$(COMPOSE) --profile test run --rm --build test-php

## mutate-docker: run every mutation suite in containers (slow)
mutate-docker: require-cwd require-keys
	$(COMPOSE) --profile mutate run --rm --build mutate-ts
	$(COMPOSE) --profile mutate run --rm --build mutate-php
	@echo ""
	@echo "Go mutation testing needs gremlins on the host:"
	@echo "  go install github.com/go-gremlins/gremlins/cmd/gremlins@latest"
	@echo "  for p in attribution generator ingest search settlement; do \\"
	@echo "    gremlins unleash ./internal/$$p/; done"

## test: run the Go, TypeScript, and PHP suites on the host
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

## mutate: run every mutation suite on the host
mutate: mutate-go mutate-ts mutate-php

## mutate-go: gremlins across every Go package
mutate-go:
	@for p in attribution generator ingest search settlement; do \
		echo "=== $$p ==="; \
		gremlins unleash ./internal/$$p/ --workers 4 | tail -4; \
	done

## mutate-ts: Stryker across every TypeScript workspace
mutate-ts:
	npx stryker run packages/types/stryker.conf.json
	npx stryker run stryker.gateway.json
	npx stryker run facilitator/stryker.conf.json
	npx stryker run stryker.merchant.json
	npx stryker run stryker.simulator.json

## mutate-php: Infection across the dashboard
mutate-php:
	cd app && ./vendor/bin/infection --threads=4 --no-progress --no-interaction

## lint: gofmt, tsc, and php -l across everything
lint:
	@test -z "$$(gofmt -l . | grep -v node_modules)" || (gofmt -l . | grep -v node_modules; exit 1)
	npm run typecheck --workspaces --if-present
	@find app -name '*.php' -print0 | xargs -0 -n1 php -l > /dev/null

## fixture: regenerate the Go-minted cross-language test vector
fixture:
	go run ./cmd/fixture > packages/types/src/__fixtures__/go-minted-assertion.json

# Docker Desktop on Windows resolves registry credentials through a Windows
# executable, and WSL launches it through interop. Interop translates the
# current directory to a Windows path to do that, so a working directory whose
# handle has gone stale breaks the launch. The helper exits 1 with no output
# and Docker reports the only thing it can see, "error getting credentials",
# which sends people hunting for a Docker Hub login they do not need.
#
# A remount of /mnt/c, a Docker Desktop restart, or a long-idle shell all
# invalidate the handle. `env pwd` runs the real binary rather than the shell
# builtin, which reads $PWD and would report success against a dead handle.
# The message names no path on purpose. Both $(CURDIR) and $PWD derive from
# the call that just failed, so both arrive empty here.
require-cwd:
	@env pwd > /dev/null 2>&1 || { \
		echo "This shell's working directory no longer resolves."; \
		echo ""; \
		echo "Docker builds fail here with a misleading credentials error."; \
		echo "Nothing is wrong with the repository and no login is needed."; \
		echo ""; \
		echo "Change into the project directory again by its full path, or"; \
		echo "open a new shell and change into it there. Either one rebinds"; \
		echo "the handle and the build proceeds normally."; \
		echo ""; \
		echo "Restarting Docker Desktop also clears it, and costs more time."; \
		echo "See Troubleshooting in docs/RUNNING.md."; \
		exit 1; \
	}

# A phony guard rather than a file target. Make splits prerequisites on
# whitespace, so a path containing a space could never work as a target name,
# and a missing key file should produce one instruction rather than a wall of
# compose interpolation errors.
require-keys:
	@test -f "$(ENV_FILE)" || { \
		echo "No key file at $(ENV_FILE)."; \
		echo "Run: make keys"; \
		exit 1; \
	}
