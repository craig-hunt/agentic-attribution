package settlement

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// confirmOne drives a settlement all the way to confirmed so the read models
// have something real to aggregate rather than hand-inserted rows that could
// drift from what the write path actually produces.
func confirmOne(t *testing.T, store *Store, assertionID string) PendingSettlement {
	t.Helper()

	p := pending(assertionID)
	if err := store.Begin(context.Background(), p); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Confirm(context.Background(), p, "0x"+assertionID, time.Now()); err != nil {
		t.Fatalf("Confirm: %v", err)
	}

	return p
}

func TestListPublishers(t *testing.T) {
	store, _ := newStore(t)

	publishers, err := store.ListPublishers(context.Background())
	if err != nil {
		t.Fatalf("ListPublishers: %v", err)
	}

	if len(publishers) != 1 {
		t.Fatalf("listed %d publishers, want 1", len(publishers))
	}
	if publishers[0].PublisherID != testPublisherID || publishers[0].Currency != "USD" {
		t.Fatalf("publisher decoded wrong: %+v", publishers[0])
	}
	// A publisher that has never been paid reports zero rather than failing to
	// scan a NULL out of the aggregate join.
	if publishers[0].SettlementCount != 0 || publishers[0].EarnedCents != 0 {
		t.Fatalf("an unpaid publisher reports %d settlements and %d cents",
			publishers[0].SettlementCount, publishers[0].EarnedCents)
	}
}

// The dashboard ranks by these numbers, and SUM over a bigint column returns
// numeric, which pgx refuses to scan into an int64. A real database is the
// only place that failure appears.
func TestListPublishersCarriesEarningsForRanking(t *testing.T) {
	store, _ := newStore(t)

	first := confirmOne(t, store, "rank_a")
	confirmOne(t, store, "rank_b")

	publishers, err := store.ListPublishers(context.Background())
	if err != nil {
		t.Fatalf("ListPublishers: %v", err)
	}
	if len(publishers) != 1 {
		t.Fatalf("listed %d publishers, want 1", len(publishers))
	}

	if publishers[0].SettlementCount != 2 {
		t.Errorf("settlement count = %d, want 2", publishers[0].SettlementCount)
	}
	if want := first.Split.PublisherAmountCents * 2; publishers[0].EarnedCents != want {
		t.Errorf("earned %d cents, want %d", publishers[0].EarnedCents, want)
	}
}

// A refusal and a settlement that fell over describe different outcomes. One
// says the platform stopped an attempt, the other says it accepted the
// assertion and the payment failed afterwards. Reporting one number for both
// would hide which happened.
func TestListPublishersSeparatesBlockedFromFailed(t *testing.T) {
	store, _ := newStore(t)

	p := pending("blocked_vs_failed")
	if err := store.Begin(context.Background(), p); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Fail(context.Background(), p.SettlementID); err != nil {
		t.Fatalf("Fail: %v", err)
	}

	if err := store.RecordRejection(context.Background(), Rejection{
		PublisherID: testPublisherID,
		AssertionID: "a_refused",
		Reason:      "assertion_signature_invalid",
	}); err != nil {
		t.Fatalf("RecordRejection: %v", err)
	}

	publishers, err := store.ListPublishers(context.Background())
	if err != nil {
		t.Fatalf("ListPublishers: %v", err)
	}

	if publishers[0].FailedCount != 1 {
		t.Errorf("failed count = %d, want 1", publishers[0].FailedCount)
	}
	if publishers[0].BlockedCount != 1 {
		t.Errorf("blocked count = %d, want 1", publishers[0].BlockedCount)
	}
	// A failed settlement never confirmed, so it earns nothing.
	if publishers[0].SettlementCount != 0 || publishers[0].EarnedCents != 0 {
		t.Errorf("a failed settlement counted as earnings: %+v", publishers[0])
	}
}

// A rejection naming a publisher that does not exist is the signal worth
// keeping, so no foreign key discards it.
func TestRecordRejectionAcceptsAnUnknownPublisher(t *testing.T) {
	store, _ := newStore(t)

	if err := store.RecordRejection(context.Background(), Rejection{
		PublisherID: "pub_999999",
		Reason:      "assertion_signature_invalid",
	}); err != nil {
		t.Fatalf("RecordRejection refused an unknown publisher: %v", err)
	}
}

func TestRecentRejectionsReturnsTheNewestFirst(t *testing.T) {
	store, _ := newStore(t)

	for _, reason := range []string{"assertion_expired", "assertion_signature_invalid"} {
		if err := store.RecordRejection(context.Background(), Rejection{
			PublisherID: testPublisherID,
			Reason:      reason,
			MerchantID:  "mer_000042",
		}); err != nil {
			t.Fatalf("RecordRejection: %v", err)
		}
	}

	rows, err := store.RecentRejections(context.Background(), testPublisherID, 10)
	if err != nil {
		t.Fatalf("RecentRejections: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rejections, want 2", len(rows))
	}
	// Same-timestamp rows tie-break on the identifier, so the newest insert
	// leads rather than the order the database happened to return.
	if rows[0].Reason != "assertion_signature_invalid" {
		t.Errorf("newest row = %q, want assertion_signature_invalid", rows[0].Reason)
	}
	if rows[0].MerchantID == nil || *rows[0].MerchantID != "mer_000042" {
		t.Errorf("merchant did not survive the round trip: %+v", rows[0])
	}
	// An absent assertion stays NULL rather than becoming an empty string.
	if rows[0].AssertionID != nil {
		t.Errorf("an absent assertion came back as %q", *rows[0].AssertionID)
	}
}

func TestRecentRejectionsHonoursItsLimit(t *testing.T) {
	store, _ := newStore(t)

	for i := 0; i < 5; i++ {
		if err := store.RecordRejection(context.Background(), Rejection{
			PublisherID: testPublisherID,
			Reason:      "assertion_expired",
		}); err != nil {
			t.Fatalf("RecordRejection: %v", err)
		}
	}

	rows, err := store.RecentRejections(context.Background(), testPublisherID, 3)
	if err != nil {
		t.Fatalf("RecentRejections: %v", err)
	}
	if len(rows) != 3 {
		t.Errorf("got %d rows, want the 3 the limit allows", len(rows))
	}
}

// Every aggregate in this query returns numeric from Postgres, which pgx
// refuses to scan into a Go integer. Casting is the fix and this is the test
// that would have caught the omission, since the failure appears only at scan
// time against a real database.
func TestPublisherSummaryScansEveryAggregate(t *testing.T) {
	store, _ := newStore(t)

	first := confirmOne(t, store, "a1")
	confirmOne(t, store, "a2")

	summary, err := store.PublisherSummary(context.Background(), testPublisherID)
	if err != nil {
		t.Fatalf("PublisherSummary: %v", err)
	}

	if summary.SettlementCount != 2 {
		t.Errorf("settlement count = %d, want 2", summary.SettlementCount)
	}
	if summary.GrossAmountCents != 2*testPriceCents {
		t.Errorf("gross = %d, want %d", summary.GrossAmountCents, 2*testPriceCents)
	}
	if summary.EarnedCents != 2*first.Split.PublisherAmountCents {
		t.Errorf("earned = %d, want %d", summary.EarnedCents, 2*first.Split.PublisherAmountCents)
	}
	if summary.PlatformFeeCents != 2*first.Split.PlatformFeeCents {
		t.Errorf("platform fee = %d, want %d", summary.PlatformFeeCents, 2*first.Split.PlatformFeeCents)
	}
	if summary.AverageCommission != 450 {
		t.Errorf("average commission = %d, want 450", summary.AverageCommission)
	}
	if summary.AssertionsIssued != 2 {
		t.Errorf("assertions consumed = %d, want 2", summary.AssertionsIssued)
	}
	if summary.SearchRequests != 1 {
		t.Errorf("search requests = %d, want 1", summary.SearchRequests)
	}
}

// A publisher with no activity must report zeroes rather than fail on NULL
// aggregates from the outer joins. The dashboard links to every publisher,
// including ones who have earned nothing yet.
func TestPublisherSummaryReportsZeroesForAnInactivePublisher(t *testing.T) {
	store, pool := newStore(t)

	if _, err := pool.Exec(context.Background(),
		`INSERT INTO publishers (publisher_id, name) VALUES ($1,$2)`, "pub_quiet", "Quiet Media"); err != nil {
		t.Fatalf("seed: %v", err)
	}

	summary, err := store.PublisherSummary(context.Background(), "pub_quiet")
	if err != nil {
		t.Fatalf("PublisherSummary for an inactive publisher: %v", err)
	}

	if summary.SettlementCount != 0 || summary.EarnedCents != 0 || summary.AverageCommission != 0 {
		t.Fatalf("expected zeroes, got %+v", summary)
	}
	if summary.Name != "Quiet Media" {
		t.Errorf("name = %q", summary.Name)
	}
}

// Pending and failed settlements represent money that may never arrive.
// Counting them as earnings would put a number on a dashboard that a publisher
// makes decisions on.
func TestPublisherSummaryCountsOnlyConfirmedSettlements(t *testing.T) {
	store, _ := newStore(t)
	ctx := context.Background()

	confirmOne(t, store, "confirmed")

	stillPending := pending("pending")
	if err := store.Begin(ctx, stillPending); err != nil {
		t.Fatalf("Begin pending: %v", err)
	}

	failed := pending("failed")
	if err := store.Begin(ctx, failed); err != nil {
		t.Fatalf("Begin failed: %v", err)
	}
	if err := store.Fail(ctx, failed.SettlementID); err != nil {
		t.Fatalf("Fail: %v", err)
	}

	summary, err := store.PublisherSummary(ctx, testPublisherID)
	if err != nil {
		t.Fatalf("PublisherSummary: %v", err)
	}

	if summary.SettlementCount != 1 {
		t.Fatalf("counted %d settlements, want only the confirmed one", summary.SettlementCount)
	}
	if summary.GrossAmountCents != testPriceCents {
		t.Fatalf("gross = %d, want a single settlement's worth", summary.GrossAmountCents)
	}

	// Consumed assertions count all three, because all three burned one.
	if summary.AssertionsIssued != 3 {
		t.Errorf("assertions consumed = %d, want 3", summary.AssertionsIssued)
	}
}

func TestPublisherSummaryDistinguishesUnknownFromEmpty(t *testing.T) {
	store, _ := newStore(t)

	if _, err := store.PublisherSummary(context.Background(), "pub_nobody"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("unknown publisher returned %v, want pgx.ErrNoRows", err)
	}
}

func TestRecentSettlementsJoinsProductAndMerchantNames(t *testing.T) {
	store, _ := newStore(t)

	p := confirmOne(t, store, "a1")

	rows, err := store.RecentSettlements(context.Background(), testPublisherID, 25)
	if err != nil {
		t.Fatalf("RecentSettlements: %v", err)
	}

	if len(rows) != 1 {
		t.Fatalf("returned %d rows, want 1", len(rows))
	}

	row := rows[0]
	if row.ProductTitle != "Trail Runner Pro" || row.MerchantName != "Summit Outfitters" {
		t.Errorf("names did not join: %+v", row)
	}
	if row.Status != StatusConfirmed {
		t.Errorf("status = %s", row.Status)
	}
	if row.TxHash == nil || *row.TxHash != "0xa1" {
		t.Errorf("tx hash = %v", row.TxHash)
	}
	if row.ConfirmedAt == nil {
		t.Error("confirmed_at did not decode")
	}
	if row.PublisherAmountCents != p.Split.PublisherAmountCents {
		t.Errorf("publisher amount = %d", row.PublisherAmountCents)
	}
}

// A pending settlement carries a NULL tx_hash and confirmed_at. Scanning those
// into non-pointer fields would fail, so the pointers are load bearing.
func TestRecentSettlementsHandlesNullColumns(t *testing.T) {
	store, _ := newStore(t)

	if err := store.Begin(context.Background(), pending("a1")); err != nil {
		t.Fatalf("Begin: %v", err)
	}

	rows, err := store.RecentSettlements(context.Background(), testPublisherID, 25)
	if err != nil {
		t.Fatalf("RecentSettlements: %v", err)
	}

	if len(rows) != 1 {
		t.Fatalf("returned %d rows, want 1", len(rows))
	}
	if rows[0].TxHash != nil || rows[0].ConfirmedAt != nil {
		t.Fatalf("a pending settlement reported %v / %v", rows[0].TxHash, rows[0].ConfirmedAt)
	}
}

func TestRecentSettlementsHonoursTheLimit(t *testing.T) {
	store, _ := newStore(t)

	for _, id := range []string{"a1", "a2", "a3", "a4"} {
		confirmOne(t, store, id)
	}

	rows, err := store.RecentSettlements(context.Background(), testPublisherID, 2)
	if err != nil {
		t.Fatalf("RecentSettlements: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("returned %d rows against a limit of 2", len(rows))
	}

	empty, err := store.RecentSettlements(context.Background(), "pub_nobody", 25)
	if err != nil {
		t.Fatalf("RecentSettlements for an unknown publisher: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("an unknown publisher returned %d rows", len(empty))
	}
}

// The chain is the artifact the whole demo exists to produce: query through
// assertion through payment to ledger, readable end to end.
func TestChainReconstructsTheWholePath(t *testing.T) {
	store, _ := newStore(t)

	p := confirmOne(t, store, "a1")

	chain, err := store.Chain(context.Background(), p.SettlementID)
	if err != nil {
		t.Fatalf("Chain: %v", err)
	}

	if chain.Query != "trail running shoes" {
		t.Errorf("query = %q", chain.Query)
	}
	if chain.SearchRequestID != testSearchRequestID {
		t.Errorf("search request = %q", chain.SearchRequestID)
	}
	if chain.SearchLatencyMs != 23 {
		t.Errorf("latency = %d", chain.SearchLatencyMs)
	}
	if chain.AssertionID != "a1" || chain.AssertionUsedAt == nil {
		t.Errorf("assertion = %q consumed at %v", chain.AssertionID, chain.AssertionUsedAt)
	}
	if chain.PublisherName != "Trail & Peak Media" || chain.MerchantName != "Summit Outfitters" {
		t.Errorf("names did not join: %+v", chain)
	}
	if chain.ProductTitle != "Trail Runner Pro" {
		t.Errorf("product title = %q", chain.ProductTitle)
	}
	if chain.Network != "base-sepolia" || chain.Status != StatusConfirmed {
		t.Errorf("network/status = %s / %s", chain.Network, chain.Status)
	}

	if len(chain.Ledger) != 3 {
		t.Fatalf("chain carries %d ledger entries, want 3", len(chain.Ledger))
	}

	var total int64
	for _, e := range chain.Ledger {
		total += e.AmountCents
	}
	if total != 0 {
		t.Fatalf("the chain's ledger sums to %d, want 0", total)
	}
}

// Settlements outlive the search request rows a retention policy prunes. A
// chain missing its first link still tells the reader more than an error page.
func TestChainSurvivesAPrunedSearchRequest(t *testing.T) {
	store, _ := newStore(t)
	ctx := context.Background()

	p := pending("a1")
	p.SearchRequestID = ""
	if err := store.Begin(ctx, p); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Confirm(ctx, p, "0xtx", time.Now()); err != nil {
		t.Fatalf("Confirm: %v", err)
	}

	chain, err := store.Chain(ctx, p.SettlementID)
	if err != nil {
		t.Fatalf("Chain without a search request: %v", err)
	}

	if chain.Query != "" || chain.SearchRequestID != "" {
		t.Errorf("expected empty query fields, got %q / %q", chain.Query, chain.SearchRequestID)
	}
	if chain.SettlementID != p.SettlementID || len(chain.Ledger) != 3 {
		t.Errorf("the rest of the chain did not survive: %+v", chain)
	}
}

func TestChainOfAPendingSettlementCarriesNoLedgerEntries(t *testing.T) {
	store, _ := newStore(t)

	p := pending("a1")
	if err := store.Begin(context.Background(), p); err != nil {
		t.Fatalf("Begin: %v", err)
	}

	chain, err := store.Chain(context.Background(), p.SettlementID)
	if err != nil {
		t.Fatalf("Chain: %v", err)
	}

	if chain.Status != StatusPending {
		t.Errorf("status = %s", chain.Status)
	}
	if len(chain.Ledger) != 0 {
		t.Fatalf("a pending settlement carries %d ledger entries", len(chain.Ledger))
	}
	if chain.TxHash != nil || chain.ConfirmedAt != nil {
		t.Errorf("pending settlement reported %v / %v", chain.TxHash, chain.ConfirmedAt)
	}
}

func TestChainDistinguishesUnknownFromError(t *testing.T) {
	store, _ := newStore(t)

	if _, err := store.Chain(context.Background(), "stl_nobody"); !errors.Is(err, ErrSettlementNotFound) {
		t.Fatalf("unknown settlement returned %v, want ErrSettlementNotFound", err)
	}
}
