package settlement

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Read models for the publisher dashboard. They live behind the settlement
// service rather than letting the dashboard query Postgres directly, so the
// schema stays a private detail of the layer that owns it. A presentation layer
// holding SQL against the ledger turns every column rename into a coordinated
// deploy across two languages.

var ErrSettlementNotFound = errors.New("no settlement with that identifier")

type Publisher struct {
	PublisherID string `json:"publisher_id"`
	Name        string `json:"name"`
	Currency    string `json:"payout_currency"`
}

type PublisherSummary struct {
	Publisher
	SettlementCount   int64 `json:"settlement_count"`
	GrossAmountCents  int64 `json:"gross_amount_cents"`
	EarnedCents       int64 `json:"earned_cents"`
	PlatformFeeCents  int64 `json:"platform_fee_cents"`
	SearchRequests    int64 `json:"search_request_count"`
	AssertionsIssued  int64 `json:"assertions_consumed"`
	AverageCommission int   `json:"average_commission_bps"`
}

type SettlementRow struct {
	SettlementID         string     `json:"settlement_id"`
	ProductTitle         string     `json:"product_title"`
	MerchantName         string     `json:"merchant_name"`
	GrossAmountCents     int64      `json:"gross_amount_cents"`
	PublisherAmountCents int64      `json:"publisher_amount_cents"`
	CommissionBps        int        `json:"commission_bps"`
	Status               string     `json:"status"`
	TxHash               *string    `json:"tx_hash"`
	CreatedAt            time.Time  `json:"created_at"`
	ConfirmedAt          *time.Time `json:"confirmed_at"`
}

type LedgerEntry struct {
	EntryID     int64     `json:"entry_id"`
	Account     string    `json:"account"`
	AccountID   string    `json:"account_id"`
	EntryType   string    `json:"entry_type"`
	AmountCents int64     `json:"amount_cents"`
	Currency    string    `json:"currency"`
	CreatedAt   time.Time `json:"created_at"`
}

// Chain is the whole point of the dashboard: query through assertion through
// payment through ledger, readable end to end. The demo's thesis is that
// attribution survives the agent boundary, and this is the artifact proving it.
type Chain struct {
	SettlementID    string        `json:"settlement_id"`
	Query           string        `json:"query_text"`
	SearchRequestID string        `json:"search_request_id"`
	SearchLatencyMs int           `json:"search_latency_ms"`
	SearchedAt      *time.Time    `json:"searched_at"`
	AssertionID     string        `json:"assertion_id"`
	AssertionUsedAt *time.Time    `json:"assertion_consumed_at"`
	PublisherID     string        `json:"publisher_id"`
	PublisherName   string        `json:"publisher_name"`
	ProductID       string        `json:"product_id"`
	ProductTitle    string        `json:"product_title"`
	MerchantName    string        `json:"merchant_name"`
	GrossCents      int64         `json:"gross_amount_cents"`
	CommissionBps   int           `json:"commission_bps"`
	CommissionCents int64         `json:"commission_amount_cents"`
	PlatformCents   int64         `json:"platform_fee_cents"`
	PublisherCents  int64         `json:"publisher_amount_cents"`
	Network         string        `json:"chain_network"`
	TxHash          *string       `json:"tx_hash"`
	Status          string        `json:"status"`
	ConfirmedAt     *time.Time    `json:"confirmed_at"`
	Ledger          []LedgerEntry `json:"ledger_entries"`
}

func (s *Store) ListPublishers(ctx context.Context) ([]Publisher, error) {
	const q = `
		SELECT publisher_id, name, payout_currency
		FROM publishers
		ORDER BY publisher_id`

	rows, err := s.pool.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list publishers: %w", err)
	}
	defer rows.Close()

	out := make([]Publisher, 0)
	for rows.Next() {
		var p Publisher
		if err := rows.Scan(&p.PublisherID, &p.Name, &p.Currency); err != nil {
			return nil, fmt.Errorf("scan publisher: %w", err)
		}
		out = append(out, p)
	}

	return out, rows.Err()
}

// PublisherSummary aggregates only confirmed settlements. Counting pending or
// failed rows as earnings would show a publisher money that may never arrive,
// which is the kind of number people make decisions on.
func (s *Store) PublisherSummary(ctx context.Context, publisherID string) (PublisherSummary, error) {
	const q = `
		SELECT
			p.publisher_id,
			p.name,
			p.payout_currency,
			COALESCE(s.settlement_count, 0),
			COALESCE(s.gross_cents, 0),
			COALESCE(s.publisher_cents, 0),
			COALESCE(s.platform_cents, 0),
			COALESCE(s.avg_bps, 0),
			COALESCE(r.search_count, 0),
			COALESCE(a.assertion_count, 0)
		FROM publishers p
		LEFT JOIN (
			-- Every aggregate carries an explicit cast. Postgres returns
			-- numeric from SUM over a bigint column and from AVG over any
			-- numeric type, and pgx refuses to scan numeric into a Go integer.
			-- Without these casts the endpoint fails at scan time rather than
			-- at compile time, which is the worst place to find out.
			SELECT publisher_id,
			       COUNT(*)                              AS settlement_count,
			       SUM(gross_amount_cents)::bigint       AS gross_cents,
			       SUM(publisher_amount_cents)::bigint   AS publisher_cents,
			       SUM(platform_fee_cents)::bigint       AS platform_cents,
			       ROUND(AVG(commission_bps))::int       AS avg_bps
			FROM settlements
			WHERE status = $2
			GROUP BY publisher_id
		) s ON s.publisher_id = p.publisher_id
		LEFT JOIN (
			SELECT publisher_id, COUNT(*) AS search_count
			FROM search_requests GROUP BY publisher_id
		) r ON r.publisher_id = p.publisher_id
		LEFT JOIN (
			SELECT publisher_id, COUNT(*) AS assertion_count
			FROM consumed_assertions GROUP BY publisher_id
		) a ON a.publisher_id = p.publisher_id
		WHERE p.publisher_id = $1`

	var out PublisherSummary
	err := s.pool.QueryRow(ctx, q, publisherID, StatusConfirmed).Scan(
		&out.PublisherID, &out.Name, &out.Currency,
		&out.SettlementCount, &out.GrossAmountCents, &out.EarnedCents,
		&out.PlatformFeeCents, &out.AverageCommission,
		&out.SearchRequests, &out.AssertionsIssued,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublisherSummary{}, fmt.Errorf("publisher %s: %w", publisherID, pgx.ErrNoRows)
	}
	if err != nil {
		return PublisherSummary{}, fmt.Errorf("publisher summary: %w", err)
	}

	return out, nil
}

func (s *Store) RecentSettlements(ctx context.Context, publisherID string, limit int) ([]SettlementRow, error) {
	const q = `
		SELECT s.settlement_id, pr.canonical_title, m.name,
		       s.gross_amount_cents, s.publisher_amount_cents, s.commission_bps,
		       s.status::text, s.tx_hash, s.created_at, s.confirmed_at
		FROM settlements s
		JOIN products  pr ON pr.product_id  = s.product_id
		JOIN merchants m  ON m.merchant_id  = s.merchant_id
		WHERE s.publisher_id = $1
		ORDER BY s.created_at DESC
		LIMIT $2`

	rows, err := s.pool.Query(ctx, q, publisherID, limit)
	if err != nil {
		return nil, fmt.Errorf("recent settlements: %w", err)
	}
	defer rows.Close()

	out := make([]SettlementRow, 0, limit)
	for rows.Next() {
		var r SettlementRow
		if err := rows.Scan(
			&r.SettlementID, &r.ProductTitle, &r.MerchantName,
			&r.GrossAmountCents, &r.PublisherAmountCents, &r.CommissionBps,
			&r.Status, &r.TxHash, &r.CreatedAt, &r.ConfirmedAt,
		); err != nil {
			return nil, fmt.Errorf("scan settlement: %w", err)
		}
		out = append(out, r)
	}

	return out, rows.Err()
}

// Chain reconstructs the full path from query to ledger. search_requests joins
// LEFT because the settlement survives even if the originating query row was
// pruned, and a chain missing its first link still tells the reader more than
// an error page does.
func (s *Store) Chain(ctx context.Context, settlementID string) (Chain, error) {
	const q = `
		SELECT s.settlement_id,
		       COALESCE(sr.query_text, ''), COALESCE(s.search_request_id, ''),
		       COALESCE(sr.latency_ms, 0), sr.created_at,
		       s.assertion_id, ca.consumed_at,
		       s.publisher_id, p.name,
		       s.product_id, pr.canonical_title, m.name,
		       s.gross_amount_cents, s.commission_bps, s.commission_amount_cents,
		       s.platform_fee_cents, s.publisher_amount_cents,
		       s.chain_network, s.tx_hash, s.status::text, s.confirmed_at
		FROM settlements s
		JOIN publishers p            ON p.publisher_id  = s.publisher_id
		JOIN products   pr           ON pr.product_id   = s.product_id
		JOIN merchants  m            ON m.merchant_id   = s.merchant_id
		JOIN consumed_assertions ca  ON ca.assertion_id = s.assertion_id
		LEFT JOIN search_requests sr ON sr.search_request_id = s.search_request_id
		WHERE s.settlement_id = $1`

	var c Chain
	err := s.pool.QueryRow(ctx, q, settlementID).Scan(
		&c.SettlementID,
		&c.Query, &c.SearchRequestID, &c.SearchLatencyMs, &c.SearchedAt,
		&c.AssertionID, &c.AssertionUsedAt,
		&c.PublisherID, &c.PublisherName,
		&c.ProductID, &c.ProductTitle, &c.MerchantName,
		&c.GrossCents, &c.CommissionBps, &c.CommissionCents,
		&c.PlatformCents, &c.PublisherCents,
		&c.Network, &c.TxHash, &c.Status, &c.ConfirmedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Chain{}, ErrSettlementNotFound
	}
	if err != nil {
		return Chain{}, fmt.Errorf("chain: %w", err)
	}

	const ledgerQuery = `
		SELECT entry_id, account::text, account_id, entry_type::text,
		       amount_cents, currency, created_at
		FROM ledger_entries
		WHERE settlement_id = $1
		ORDER BY entry_id`

	rows, err := s.pool.Query(ctx, ledgerQuery, settlementID)
	if err != nil {
		return Chain{}, fmt.Errorf("chain ledger: %w", err)
	}
	defer rows.Close()

	c.Ledger = make([]LedgerEntry, 0, 3)
	for rows.Next() {
		var e LedgerEntry
		if err := rows.Scan(
			&e.EntryID, &e.Account, &e.AccountID, &e.EntryType,
			&e.AmountCents, &e.Currency, &e.CreatedAt,
		); err != nil {
			return Chain{}, fmt.Errorf("scan ledger entry: %w", err)
		}
		c.Ledger = append(c.Ledger, e)
	}

	return c, rows.Err()
}
