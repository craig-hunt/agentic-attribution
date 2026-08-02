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
	// Carried on the list so the dashboard can show which publishers have
	// earned anything. A list of names alone gives a reader no way to tell an
	// active publisher from the forty-seven that have never been paid, so the
	// first row they click is almost always an empty page.
	SettlementCount int64 `json:"settlement_count"`
	EarnedCents     int64 `json:"earned_cents"`
	// Attempts the platform refused in this publisher's name. A live view of
	// this column is the only place attribution integrity becomes visible
	// rather than merely claimed.
	BlockedCount int64 `json:"blocked_count"`
	// Settlements that started and never confirmed. Distinct from blocked: the
	// platform accepted the assertion and the payment fell over afterwards, so
	// nobody defrauded anybody and nobody got paid either.
	FailedCount int64 `json:"failed_count"`
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
	BlockedCount      int64 `json:"blocked_count"`
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
	// Earners first, so whoever opens the dashboard lands on a publisher with
	// something to show. SUM over a bigint column returns numeric, which pgx
	// refuses to scan into an int64, hence the cast.
	const q = `
		SELECT
			p.publisher_id,
			p.name,
			p.payout_currency,
			COALESCE(s.settlement_count, 0),
			COALESCE(s.publisher_cents, 0),
			COALESCE(b.blocked_count, 0),
			COALESCE(f.failed_count, 0)
		FROM publishers p
		LEFT JOIN (
			SELECT publisher_id,
			       COUNT(*)                            AS settlement_count,
			       SUM(publisher_amount_cents)::bigint AS publisher_cents
			FROM settlements
			WHERE status = $1
			GROUP BY publisher_id
		) s ON s.publisher_id = p.publisher_id
		LEFT JOIN (
			SELECT publisher_id, COUNT(*) AS blocked_count
			FROM rejected_attempts
			GROUP BY publisher_id
		) b ON b.publisher_id = p.publisher_id
		LEFT JOIN (
			SELECT publisher_id, COUNT(*) AS failed_count
			FROM settlements
			WHERE status = $2
			GROUP BY publisher_id
		) f ON f.publisher_id = p.publisher_id
		ORDER BY COALESCE(s.publisher_cents, 0) DESC, p.publisher_id`

	rows, err := s.pool.Query(ctx, q, StatusConfirmed, StatusFailed)
	if err != nil {
		return nil, fmt.Errorf("list publishers: %w", err)
	}
	defer rows.Close()

	out := make([]Publisher, 0)
	for rows.Next() {
		var p Publisher
		if err := rows.Scan(&p.PublisherID, &p.Name, &p.Currency,
			&p.SettlementCount, &p.EarnedCents, &p.BlockedCount, &p.FailedCount); err != nil {
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
			COALESCE(a.assertion_count, 0),
			COALESCE(b.blocked_count, 0)
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
		LEFT JOIN (
			SELECT publisher_id, COUNT(*) AS blocked_count
			FROM rejected_attempts GROUP BY publisher_id
		) b ON b.publisher_id = p.publisher_id
		WHERE p.publisher_id = $1`

	var out PublisherSummary
	err := s.pool.QueryRow(ctx, q, publisherID, StatusConfirmed).Scan(
		&out.PublisherID, &out.Name, &out.Currency,
		&out.SettlementCount, &out.GrossAmountCents, &out.EarnedCents,
		&out.PlatformFeeCents, &out.AverageCommission,
		&out.SearchRequests, &out.AssertionsIssued, &out.BlockedCount,
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

// RejectionRow is one refused attempt, for the publisher detail view.
type RejectionRow struct {
	Reason      string    `json:"reason"`
	AssertionID *string   `json:"assertion_id"`
	MerchantID  *string   `json:"merchant_id"`
	Detail      *string   `json:"detail"`
	CreatedAt   time.Time `json:"created_at"`
}

// RecentRejections returns the newest refused attempts for one publisher. The
// dashboard shows these beside the settlements, so a viewer sees what the
// platform let through and what it stopped in the same place.
func (s *Store) RecentRejections(ctx context.Context, publisherID string, limit int) ([]RejectionRow, error) {
	const q = `
		SELECT reason, assertion_id, merchant_id, detail, created_at
		FROM rejected_attempts
		WHERE publisher_id = $1
		ORDER BY created_at DESC, attempt_id DESC
		LIMIT $2`

	rows, err := s.pool.Query(ctx, q, publisherID, limit)
	if err != nil {
		return nil, fmt.Errorf("recent rejections: %w", err)
	}
	defer rows.Close()

	out := make([]RejectionRow, 0)
	for rows.Next() {
		var r RejectionRow
		if err := rows.Scan(&r.Reason, &r.AssertionID, &r.MerchantID, &r.Detail, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan rejection: %w", err)
		}
		out = append(out, r)
	}

	return out, rows.Err()
}
