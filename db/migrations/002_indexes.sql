-- Indexes serve two distinct workloads. Ingest needs upsert conflict targets.
-- The dashboard and settlement paths need lookup and aggregation support.
-- Product search does NOT appear here; it runs entirely against OpenSearch.

BEGIN;

-- Ingest: listings arrive keyed by merchant plus the merchant's own SKU, so
-- that pair is the natural key an upsert conflicts on.
CREATE UNIQUE INDEX listings_merchant_sku_key
    ON listings (merchant_id, merchant_sku);

-- Rebuilding the OpenSearch index walks listings by product to assemble each
-- document's merchant offers.
CREATE INDEX listings_product_id_idx
    ON listings (product_id);

-- Dashboard: recently updated listings per merchant.
CREATE INDEX listings_merchant_updated_idx
    ON listings (merchant_id, updated_at DESC);

CREATE INDEX products_category_idx
    ON products (category_id);

CREATE INDEX products_brand_idx
    ON products (brand);

-- Settlement path: the hot lookup is "has this assertion already been used",
-- served by the primary key. This index supports the publisher-facing
-- attribution history view instead.
CREATE INDEX consumed_assertions_publisher_idx
    ON consumed_assertions (publisher_id, consumed_at DESC);

-- Publisher earnings views filter by publisher and status, ordered by time.
CREATE INDEX settlements_publisher_status_idx
    ON settlements (publisher_id, status, created_at DESC);

CREATE INDEX settlements_merchant_idx
    ON settlements (merchant_id, created_at DESC);

-- Reconciliation against on-chain state looks settlements up by transaction
-- hash. Partial index because pending settlements have no hash yet.
CREATE INDEX settlements_tx_hash_idx
    ON settlements (tx_hash)
    WHERE tx_hash IS NOT NULL;

-- Ledger aggregation for payout runs: sum by account and account holder.
CREATE INDEX ledger_account_lookup_idx
    ON ledger_entries (account, account_id, created_at DESC);

CREATE INDEX ledger_settlement_idx
    ON ledger_entries (settlement_id);

COMMIT;
