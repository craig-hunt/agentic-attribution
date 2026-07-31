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

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/ /usr/local/bin/

# The ingest binary reads these at runtime and its flag defaults are relative,
# so they land where a working directory of / resolves them.
COPY opensearch /opensearch

WORKDIR /

USER nonroot:nonroot
