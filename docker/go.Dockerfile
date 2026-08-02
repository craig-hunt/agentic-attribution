# One image, every Go binary. The services differ only in which entrypoint runs,
# so building them separately would repeat the same module download four times.
FROM golang:1.25-alpine AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal

# Static, stripped, no cgo. The result runs on a distroless base with no libc to
# patch and no shell for an attacker to reach for.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ ./cmd/...

# Docker copies ownership from the image when it initialises an empty named
# volume. Creating /seed here owned by the distroless nonroot user (65532) is
# what lets the generator write to the shared seed volume; without it Docker
# creates the volume owned by root and a nonroot process cannot write to it.
# The final stage has no shell, so the directory has to originate here.
RUN mkdir -p /seed && chown 65532:65532 /seed

# The test stage keeps the full toolchain. It carries the source and the
# module cache the build stage already warmed, so `make test-docker` compiles
# nothing twice.
FROM build AS test

WORKDIR /src
COPY db ./db
COPY opensearch ./opensearch

# testsupport starts its own Postgres through the docker CLI, which is not
# available inside a container. Pointing it at a DSN takes the path that needs
# no Docker at all.
ENV TEST_POSTGRES_DSN=postgres://agentic:agentic@postgres:5432/agentic?sslmode=disable

CMD ["go", "test", "./..."]

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/ /usr/local/bin/
COPY --from=build --chown=65532:65532 /seed /seed

# The ingest binary reads these at runtime and its flag defaults are relative,
# so they land where a working directory of / resolves them.
COPY opensearch /opensearch

WORKDIR /

USER nonroot:nonroot
