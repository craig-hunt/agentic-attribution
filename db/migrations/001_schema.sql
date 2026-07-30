-- Postgres holds the system of record. OpenSearch holds a derived index.
-- Nothing authoritative lives in the index. See docs/adr/0002.

BEGIN;

CREATE TABLE merchants (
    merchant_id             TEXT PRIMARY KEY,
    name                    TEXT        NOT NULL,
    default_commission_bps  INTEGER     NOT NULL CHECK (default_commission_bps BETWEEN 0 AND 10000),
    hold_period_days        INTEGER     NOT NULL DEFAULT 30 CHECK (hold_period_days >= 0),
    reversal_window_days    INTEGER     NOT NULL DEFAULT 60 CHECK (reversal_window_days >= 0),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE publishers (
    publisher_id      TEXT PRIMARY KEY,
    name              TEXT        NOT NULL,
    payout_currency   TEXT        NOT NULL DEFAULT 'USD',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deduplicated product identity. One row per real-world product regardless of
-- how many merchants list it.
CREATE TABLE products (
    product_id       TEXT PRIMARY KEY,
    canonical_title  TEXT        NOT NULL,
    brand            TEXT        NOT NULL,
    category_id      TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    attributes       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The same product listed by many merchants at differing prices, availability,
-- and titles. Merchant feeds drift, so listing titles diverge from the
-- canonical title deliberately. Hash-partitioned by merchant so a single
-- merchant's feed reload touches one partition.
CREATE TABLE listings (
    listing_id      TEXT        NOT NULL,
    product_id      TEXT        NOT NULL REFERENCES products (product_id),
    merchant_id     TEXT        NOT NULL REFERENCES merchants (merchant_id),
    merchant_sku    TEXT        NOT NULL,
    listing_title   TEXT        NOT NULL,
    price_cents     BIGINT      NOT NULL CHECK (price_cents >= 0),
    currency        TEXT        NOT NULL DEFAULT 'USD',
    in_stock        BOOLEAN     NOT NULL DEFAULT TRUE,
    commission_bps  INTEGER     NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
    deep_link_url   TEXT        NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (listing_id, merchant_id)
) PARTITION BY HASH (merchant_id);

CREATE TABLE listings_p0 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE listings_p1 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE listings_p2 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE listings_p3 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE listings_p4 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE listings_p5 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE listings_p6 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE listings_p7 PARTITION OF listings FOR VALUES WITH (MODULUS 8, REMAINDER 7);

-- Every search that produced an attribution assertion. Binding assertions to
-- the originating query creates an auditable chain from search to settlement.
CREATE TABLE search_requests (
    search_request_id  TEXT PRIMARY KEY,
    publisher_id       TEXT        NOT NULL REFERENCES publishers (publisher_id),
    query_text         TEXT        NOT NULL,
    result_count       INTEGER     NOT NULL DEFAULT 0,
    latency_ms         INTEGER     NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Assertions are single use. Consumption is recorded here and checked at
-- settlement, which is what makes replay fail. See docs/adr/0003.
CREATE TABLE consumed_assertions (
    assertion_id   TEXT PRIMARY KEY,
    publisher_id   TEXT        NOT NULL REFERENCES publishers (publisher_id),
    product_id     TEXT        NOT NULL REFERENCES products (product_id),
    consumed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE settlement_status AS ENUM ('pending', 'confirmed', 'failed', 'reversed');

CREATE TABLE settlements (
    settlement_id           TEXT PRIMARY KEY,
    assertion_id            TEXT              NOT NULL REFERENCES consumed_assertions (assertion_id),
    search_request_id       TEXT              REFERENCES search_requests (search_request_id),
    publisher_id            TEXT              NOT NULL REFERENCES publishers (publisher_id),
    merchant_id             TEXT              NOT NULL REFERENCES merchants (merchant_id),
    product_id              TEXT              NOT NULL REFERENCES products (product_id),
    gross_amount_cents      BIGINT            NOT NULL CHECK (gross_amount_cents > 0),
    currency                TEXT              NOT NULL DEFAULT 'USD',
    commission_bps          INTEGER           NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
    commission_amount_cents BIGINT            NOT NULL CHECK (commission_amount_cents >= 0),
    platform_fee_cents      BIGINT            NOT NULL CHECK (platform_fee_cents >= 0),
    publisher_amount_cents  BIGINT            NOT NULL CHECK (publisher_amount_cents >= 0),
    chain_network           TEXT              NOT NULL,
    tx_hash                 TEXT,
    status                  settlement_status NOT NULL DEFAULT 'pending',
    created_at              TIMESTAMPTZ       NOT NULL DEFAULT now(),
    confirmed_at            TIMESTAMPTZ,
    CONSTRAINT commission_splits_exactly CHECK (
        platform_fee_cents + publisher_amount_cents = commission_amount_cents
    )
);

CREATE TYPE ledger_account AS ENUM ('merchant_payable', 'platform_revenue', 'publisher_payable');
CREATE TYPE ledger_entry_type AS ENUM ('commission', 'reversal', 'adjustment', 'payout');

-- Double-entry. Every settlement writes a balanced set of rows in one
-- transaction. Amounts are signed; a valid settlement's entries sum to zero.
CREATE TABLE ledger_entries (
    entry_id       BIGSERIAL PRIMARY KEY,
    settlement_id  TEXT              NOT NULL REFERENCES settlements (settlement_id),
    account        ledger_account    NOT NULL,
    account_id     TEXT              NOT NULL,
    entry_type     ledger_entry_type NOT NULL,
    amount_cents   BIGINT            NOT NULL,
    currency       TEXT              NOT NULL DEFAULT 'USD',
    created_at     TIMESTAMPTZ       NOT NULL DEFAULT now()
);

COMMIT;
