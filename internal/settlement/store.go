package settlement

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
)

// PlatformAccountID names the single platform-revenue account. Publisher and
// merchant entries carry their own identifiers; platform revenue does not
// belong to a row in any party table, so it needs a stable literal here.
const PlatformAccountID = "platform"

const (
	StatusPending   = "pending"
	StatusConfirmed = "confirmed"
	StatusFailed    = "failed"
)

const (
	AccountMerchantPayable  = "merchant_payable"
	AccountPlatformRevenue  = "platform_revenue"
	AccountPublisherPayable = "publisher_payable"

	EntryTypeCommission = "commission"
)

var (
	ErrListingNotFound = errors.New("no listing for that product and merchant")
	ErrAssertionReused = errors.New("assertion already consumed")
)

type Listing struct {
	ListingID     string
	PriceCents    int64
	Currency      string
	InStock       bool
	CommissionBps int
}

// PendingSettlement is everything the settlement row needs before the
// facilitator has spoken.
type PendingSettlement struct {
	SettlementID     string
	AssertionID      string
	SearchRequestID  string
	PublisherID      string
	MerchantID       string
	ProductID        string
	GrossAmountCents int64
	Currency         string
	CommissionBps    int
	Split            attribution.CommissionSplit
	ChainNetwork     string
}

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) LookupListing(ctx context.Context, productID, merchantID string) (Listing, error) {
	const q = `
		SELECT listing_id, price_cents, currency, in_stock, commission_bps
		FROM listings
		WHERE product_id = $1 AND merchant_id = $2`

	var l Listing
	err := s.pool.QueryRow(ctx, q, productID, merchantID).Scan(
		&l.ListingID, &l.PriceCents, &l.Currency, &l.InStock, &l.CommissionBps,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Listing{}, ErrListingNotFound
	}
	if err != nil {
		return Listing{}, fmt.Errorf("lookup listing: %w", err)
	}

	return l, nil
}

// Begin claims the assertion and records the pending settlement in one
// transaction. The claim is an insert against a primary key rather than a
// SELECT followed by an INSERT, so two concurrent settlements of the same
// assertion resolve in the database instead of racing in application code.
// Claiming and recording together means a crash between them cannot burn an
// assertion that has no settlement row to account for it.
func (s *Store) Begin(ctx context.Context, p PendingSettlement) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin settlement tx: %w", err)
	}
	defer tx.Rollback(ctx)

	const claim = `
		INSERT INTO consumed_assertions (assertion_id, publisher_id, product_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (assertion_id) DO NOTHING`

	tag, err := tx.Exec(ctx, claim, p.AssertionID, p.PublisherID, p.ProductID)
	if err != nil {
		return fmt.Errorf("claim assertion: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrAssertionReused
	}

	const insert = `
		INSERT INTO settlements (
			settlement_id, assertion_id, search_request_id, publisher_id,
			merchant_id, product_id, gross_amount_cents, currency,
			commission_bps, commission_amount_cents, platform_fee_cents,
			publisher_amount_cents, chain_network, status
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`

	// The column is nullable and carries a foreign key. An empty string
	// satisfies neither, so it would fail the insert with an opaque constraint
	// violation rather than recording a settlement whose originating query is
	// simply unknown.
	var searchRequestID *string
	if p.SearchRequestID != "" {
		searchRequestID = &p.SearchRequestID
	}

	_, err = tx.Exec(ctx, insert,
		p.SettlementID, p.AssertionID, searchRequestID, p.PublisherID,
		p.MerchantID, p.ProductID, p.GrossAmountCents, p.Currency,
		p.CommissionBps, p.Split.CommissionAmountCents, p.Split.PlatformFeeCents,
		p.Split.PublisherAmountCents, p.ChainNetwork, StatusPending,
	)
	if err != nil {
		return fmt.Errorf("insert pending settlement: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit settlement tx: %w", err)
	}

	return nil
}

// Confirm records the transaction hash and writes the balanced ledger entries
// in one transaction. The three entries sum to zero by construction: the
// merchant's negative commission offsets the platform and publisher credits,
// which the split guarantees to add back to exactly that commission.
func (s *Store) Confirm(ctx context.Context, p PendingSettlement, txHash string, confirmedAt time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin confirm tx: %w", err)
	}
	defer tx.Rollback(ctx)

	const update = `
		UPDATE settlements
		SET status = $2, tx_hash = $3, confirmed_at = $4
		WHERE settlement_id = $1 AND status = $5`

	tag, err := tx.Exec(ctx, update, p.SettlementID, StatusConfirmed, txHash, confirmedAt, StatusPending)
	if err != nil {
		return fmt.Errorf("confirm settlement: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("settlement %s was not pending", p.SettlementID)
	}

	const entries = `
		INSERT INTO ledger_entries (settlement_id, account, account_id, entry_type, amount_cents, currency)
		VALUES ($1,$2,$3,$4,$5,$12), ($1,$6,$7,$8,$9,$12), ($1,$10,$11,$8,$13,$12)`

	_, err = tx.Exec(ctx, entries,
		p.SettlementID,
		AccountMerchantPayable, p.MerchantID, EntryTypeCommission, -p.Split.CommissionAmountCents,
		AccountPlatformRevenue, PlatformAccountID, EntryTypeCommission, p.Split.PlatformFeeCents,
		AccountPublisherPayable, p.PublisherID,
		p.Currency,
		p.Split.PublisherAmountCents,
	)
	if err != nil {
		return fmt.Errorf("write ledger entries: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit confirm tx: %w", err)
	}

	return nil
}

// Fail marks a settlement failed and writes no ledger entries. The consumed
// assertion stays consumed: single use means single use, and releasing the
// claim would let a caller grind one assertion against a flaky facilitator
// until a retry happened to land. Recovery issues a fresh assertion.
func (s *Store) Fail(ctx context.Context, settlementID string) error {
	const q = `
		UPDATE settlements
		SET status = $2
		WHERE settlement_id = $1 AND status = $3`

	if _, err := s.pool.Exec(ctx, q, settlementID, StatusFailed, StatusPending); err != nil {
		return fmt.Errorf("mark settlement failed: %w", err)
	}

	return nil
}
