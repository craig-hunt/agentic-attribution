package settlement

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/craig-hunt/agentic-attribution/internal/attribution"
	"github.com/craig-hunt/agentic-attribution/internal/testsupport"
)

const (
	testMerchantID      = "mer_000001"
	testPublisherID     = "pub_000001"
	testProductID       = "prd_00000001"
	testListingID       = "lst_0000000001"
	testSearchRequestID = "req_000001"
	testPriceCents      = 12_999
)

func newStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()

	pool := testsupport.Postgres(t)
	seedCatalog(t, pool)

	return NewStore(pool), pool
}

func seedCatalog(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()

	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}

	exec(`INSERT INTO merchants (merchant_id, name, default_commission_bps) VALUES ($1,$2,$3)`,
		testMerchantID, "Summit Outfitters", 450)
	exec(`INSERT INTO publishers (publisher_id, name) VALUES ($1,$2)`,
		testPublisherID, "Trail & Peak Media")
	exec(`INSERT INTO search_requests (search_request_id, publisher_id, query_text, result_count, latency_ms)
	      VALUES ($1,$2,$3,$4,$5)`,
		testSearchRequestID, testPublisherID, "trail running shoes", 10, 23)
	exec(`INSERT INTO products (product_id, canonical_title, brand, category_id) VALUES ($1,$2,$3,$4)`,
		testProductID, "Trail Runner Pro", "Acme", "cat_1")
	exec(`INSERT INTO listings (listing_id, product_id, merchant_id, merchant_sku, listing_title,
	          price_cents, currency, in_stock, commission_bps, deep_link_url)
	      VALUES ($1,$2,$3,$4,$5,$6,'USD',true,$7,$8)`,
		testListingID, testProductID, testMerchantID, "SKU-1", "Trail Runner Pro",
		int64(testPriceCents), 450, "https://example.test/p/1")
}

func pending(assertionID string) PendingSettlement {
	split := attribution.CalculateCommission(testPriceCents, 450)

	return PendingSettlement{
		SettlementID:     "stl_" + assertionID,
		AssertionID:      assertionID,
		SearchRequestID:  testSearchRequestID,
		PublisherID:      testPublisherID,
		MerchantID:       testMerchantID,
		ProductID:        testProductID,
		GrossAmountCents: testPriceCents,
		Currency:         "USD",
		CommissionBps:    450,
		Split:            split,
		ChainNetwork:     "base-sepolia",
	}
}

func TestLookupListingReturnsTheMerchantsOwnRow(t *testing.T) {
	store, _ := newStore(t)

	listing, err := store.LookupListing(context.Background(), testProductID, testMerchantID)
	if err != nil {
		t.Fatalf("LookupListing: %v", err)
	}

	if listing.ListingID != testListingID {
		t.Errorf("listing = %s, want %s", listing.ListingID, testListingID)
	}
	if listing.PriceCents != testPriceCents {
		t.Errorf("price = %d, want %d", listing.PriceCents, testPriceCents)
	}
	if !listing.InStock || listing.Currency != "USD" || listing.CommissionBps != 450 {
		t.Errorf("listing decoded wrong: %+v", listing)
	}
}

func TestLookupListingDistinguishesUnknownFromError(t *testing.T) {
	store, _ := newStore(t)

	if _, err := store.LookupListing(context.Background(), "prd_missing", testMerchantID); !errors.Is(err, ErrListingNotFound) {
		t.Fatalf("unknown product returned %v, want ErrListingNotFound", err)
	}

	if _, err := store.LookupListing(context.Background(), testProductID, "mer_other"); !errors.Is(err, ErrListingNotFound) {
		t.Fatalf("wrong merchant returned %v, want ErrListingNotFound", err)
	}
}

func TestBeginClaimsTheAssertionAndRecordsThePendingSettlement(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	if err := store.Begin(ctx, pending("a1")); err != nil {
		t.Fatalf("Begin: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status::text FROM settlements WHERE settlement_id = $1`, "stl_a1").Scan(&status); err != nil {
		t.Fatalf("read settlement: %v", err)
	}
	if status != StatusPending {
		t.Errorf("status = %s, want %s", status, StatusPending)
	}

	var claimed int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM consumed_assertions WHERE assertion_id = $1`, "a1").Scan(&claimed); err != nil {
		t.Fatalf("read claim: %v", err)
	}
	if claimed != 1 {
		t.Errorf("claims = %d, want 1", claimed)
	}
}

// The single-use guarantee. The claim inserts against a primary key rather than
// checking then inserting, so the database arbitrates instead of application
// code racing with itself.
func TestBeginRefusesASecondClaimOnTheSameAssertion(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	if err := store.Begin(ctx, pending("a1")); err != nil {
		t.Fatalf("first Begin: %v", err)
	}

	replay := pending("a1")
	replay.SettlementID = "stl_replay"

	if err := store.Begin(ctx, replay); !errors.Is(err, ErrAssertionReused) {
		t.Fatalf("second Begin returned %v, want ErrAssertionReused", err)
	}

	// The rejected attempt must leave nothing behind. A settlement row without
	// a claim would represent money attributed to an assertion nobody consumed.
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM settlements WHERE settlement_id = $1`, "stl_replay").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatalf("the rejected claim left %d settlement rows behind", count)
	}
}

// Two settlements racing on one assertion must produce exactly one winner.
// This is the property the whole single-use design exists to guarantee, and it
// only appears under concurrency.
func TestConcurrentClaimsProduceExactlyOneWinner(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	const racers = 8

	var wg sync.WaitGroup
	results := make([]error, racers)

	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()

			p := pending("contested")
			p.SettlementID = "stl_racer_" + string(rune('a'+n))
			results[n] = store.Begin(ctx, p)
		}(i)
	}
	wg.Wait()

	winners, replays := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, ErrAssertionReused):
			replays++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}

	if winners != 1 {
		t.Fatalf("%d goroutines claimed the same assertion, want exactly 1", winners)
	}
	if replays != racers-1 {
		t.Fatalf("%d replays rejected, want %d", replays, racers-1)
	}

	var settlements int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM settlements`).Scan(&settlements); err != nil {
		t.Fatalf("count: %v", err)
	}
	if settlements != 1 {
		t.Fatalf("%d settlement rows exist, want 1", settlements)
	}
}

// The ledger's whole purpose. Three entries offset to zero, and the database's
// own CHECK constraint refuses a split that does not add up.
func TestConfirmWritesBalancedLedgerEntries(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	p := pending("a1")
	if err := store.Begin(ctx, p); err != nil {
		t.Fatalf("Begin: %v", err)
	}

	confirmedAt := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	if err := store.Confirm(ctx, p, "0xdeadbeef", confirmedAt); err != nil {
		t.Fatalf("Confirm: %v", err)
	}

	var status, txHash string
	if err := pool.QueryRow(ctx,
		`SELECT status::text, tx_hash FROM settlements WHERE settlement_id = $1`,
		p.SettlementID).Scan(&status, &txHash); err != nil {
		t.Fatalf("read settlement: %v", err)
	}
	if status != StatusConfirmed || txHash != "0xdeadbeef" {
		t.Errorf("settlement = %s / %s", status, txHash)
	}

	var total int64
	var entries int
	if err := pool.QueryRow(ctx,
		`SELECT count(*), coalesce(sum(amount_cents), 0) FROM ledger_entries WHERE settlement_id = $1`,
		p.SettlementID).Scan(&entries, &total); err != nil {
		t.Fatalf("read ledger: %v", err)
	}

	if entries != 3 {
		t.Fatalf("wrote %d ledger entries, want 3", entries)
	}
	if total != 0 {
		t.Fatalf("the ledger sums to %d, want 0", total)
	}
}

func TestConfirmAssignsEachEntryToTheRightAccount(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	p := pending("a1")
	if err := store.Begin(ctx, p); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Confirm(ctx, p, "0xtx", time.Now()); err != nil {
		t.Fatalf("Confirm: %v", err)
	}

	rows, err := pool.Query(ctx,
		`SELECT account::text, account_id, amount_cents FROM ledger_entries
		 WHERE settlement_id = $1 ORDER BY entry_id`, p.SettlementID)
	if err != nil {
		t.Fatalf("query ledger: %v", err)
	}
	defer rows.Close()

	got := map[string]struct {
		party  string
		amount int64
	}{}

	for rows.Next() {
		var account, party string
		var amount int64
		if scanErr := rows.Scan(&account, &party, &amount); scanErr != nil {
			t.Fatalf("scan: %v", scanErr)
		}
		got[account] = struct {
			party  string
			amount int64
		}{party, amount}
	}

	if e := got[AccountMerchantPayable]; e.party != testMerchantID || e.amount != -p.Split.CommissionAmountCents {
		t.Errorf("merchant entry = %+v, want %s owing %d", e, testMerchantID, p.Split.CommissionAmountCents)
	}
	if e := got[AccountPlatformRevenue]; e.party != PlatformAccountID || e.amount != p.Split.PlatformFeeCents {
		t.Errorf("platform entry = %+v", e)
	}
	if e := got[AccountPublisherPayable]; e.party != testPublisherID || e.amount != p.Split.PublisherAmountCents {
		t.Errorf("publisher entry = %+v", e)
	}
}

// Confirming twice would double the ledger. The update is conditional on the
// row still sitting pending, so the second attempt finds nothing to change.
func TestConfirmRefusesASettlementThatIsNoLongerPending(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	p := pending("a1")
	if err := store.Begin(ctx, p); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Confirm(ctx, p, "0xtx", time.Now()); err != nil {
		t.Fatalf("first Confirm: %v", err)
	}

	if err := store.Confirm(ctx, p, "0xtx2", time.Now()); err == nil {
		t.Fatal("the second Confirm succeeded, so the ledger would double")
	}

	var entries int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM ledger_entries WHERE settlement_id = $1`, p.SettlementID).Scan(&entries); err != nil {
		t.Fatalf("count: %v", err)
	}
	if entries != 3 {
		t.Fatalf("the ledger holds %d entries after a repeated confirm, want 3", entries)
	}
}

// A failed settlement writes no ledger entries and keeps the assertion
// consumed. Releasing the claim would let a caller grind one assertion against
// a flaky facilitator until a retry happened to land.
func TestFailLeavesTheClaimInPlaceAndTheLedgerEmpty(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	p := pending("a1")
	if err := store.Begin(ctx, p); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Fail(ctx, p.SettlementID); err != nil {
		t.Fatalf("Fail: %v", err)
	}

	var status string
	var entries, claims int

	if err := pool.QueryRow(ctx,
		`SELECT status::text FROM settlements WHERE settlement_id = $1`, p.SettlementID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != StatusFailed {
		t.Errorf("status = %s, want %s", status, StatusFailed)
	}

	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM ledger_entries WHERE settlement_id = $1`, p.SettlementID).Scan(&entries); err != nil {
		t.Fatalf("count entries: %v", err)
	}
	if entries != 0 {
		t.Errorf("a failed settlement wrote %d ledger entries", entries)
	}

	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM consumed_assertions WHERE assertion_id = $1`, p.AssertionID).Scan(&claims); err != nil {
		t.Fatalf("count claims: %v", err)
	}
	if claims != 1 {
		t.Errorf("the failure released the claim, leaving %d", claims)
	}

	// And the burned assertion stays burned.
	if err := store.Begin(ctx, pending("a1")); !errors.Is(err, ErrAssertionReused) {
		t.Fatalf("reclaiming after a failure returned %v, want ErrAssertionReused", err)
	}
}

func TestFailIgnoresASettlementAlreadyConfirmed(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	p := pending("a1")
	if err := store.Begin(ctx, p); err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if err := store.Confirm(ctx, p, "0xtx", time.Now()); err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if err := store.Fail(ctx, p.SettlementID); err != nil {
		t.Fatalf("Fail after Confirm: %v", err)
	}

	var status string
	if err := pool.QueryRow(ctx,
		`SELECT status::text FROM settlements WHERE settlement_id = $1`, p.SettlementID).Scan(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}
	if status != StatusConfirmed {
		t.Fatalf("status = %s, want a confirmed settlement to stay confirmed", status)
	}
}

// The database refuses a split that does not add up, independently of the Go
// arithmetic. Both layers have to agree, and this proves the constraint is
// live rather than merely declared.
func TestTheDatabaseRejectsAnUnbalancedSplit(t *testing.T) {
	store, _ := newStore(t)

	broken := pending("a1")
	broken.Split = attribution.CommissionSplit{
		CommissionAmountCents: 100,
		PlatformFeeCents:      30,
		PublisherAmountCents:  80,
	}

	if err := store.Begin(context.Background(), broken); err == nil {
		t.Fatal("the database accepted a split summing to 110 against a commission of 100")
	}
}

// An assertion can reach settlement without a search request the platform still
// holds. The column is nullable for exactly that case, and an empty string
// satisfies the foreign key no better than a made-up identifier would.
func TestBeginStoresNullWhenNoSearchRequestIsKnown(t *testing.T) {
	store, pool := newStore(t)
	ctx := context.Background()

	p := pending("a1")
	p.SearchRequestID = ""

	if err := store.Begin(ctx, p); err != nil {
		t.Fatalf("Begin without a search request: %v", err)
	}

	var isNull bool
	if err := pool.QueryRow(ctx,
		`SELECT search_request_id IS NULL FROM settlements WHERE settlement_id = $1`,
		p.SettlementID).Scan(&isNull); err != nil {
		t.Fatalf("read column: %v", err)
	}
	if !isNull {
		t.Fatal("an absent search request stored as something other than NULL")
	}
}

func TestBeginRejectsAnUnknownSearchRequest(t *testing.T) {
	store, _ := newStore(t)

	p := pending("a1")
	p.SearchRequestID = "req_never_existed"

	if err := store.Begin(context.Background(), p); err == nil {
		t.Fatal("Begin accepted a settlement referencing a search request that does not exist")
	}
}

// Slicing a detail by byte offset can split a multi-byte rune. Postgres
// refuses invalid UTF-8 on a text column, the insert fails, and
// RecordRejection logs and drops that error deliberately, so the refusal
// disappears with nothing recording that it happened.
func TestTruncateDetailCutsOnRuneBoundaries(t *testing.T) {
	// Three-byte runes guarantee a boundary lands mid-rune at some offset, so
	// the cut position has to move rather than take whatever byte it landed on.
	for _, filler := range []string{"€", "日", "🙂"} {
		count := maxRejectionDetail
		detail := strings.Repeat(filler, count)

		got := truncateDetail(detail)

		if !utf8.ValidString(got) {
			t.Errorf("truncating %q produced invalid UTF-8", filler)
		}
		if !strings.HasSuffix(got, "...") {
			t.Errorf("truncating %q dropped the ellipsis: %q", filler, got)
		}
		if len(got) > maxRejectionDetail+len("...") {
			t.Errorf("truncating %q returned %d bytes, over the cap", filler, len(got))
		}
	}
}

func TestTruncateDetailLeavesAShortDetailAlone(t *testing.T) {
	const detail = "verify assertion: signature invalid for publisher pub_000001"

	if got := truncateDetail(detail); got != detail {
		t.Errorf("a short detail came back as %q", got)
	}
}

// The unit test above proves the string stays valid. This proves Postgres
// accepts it, which is the failure the truncation exists to avoid.
func TestRecordRejectionStoresAnOversizedNonAsciiDetail(t *testing.T) {
	store, _ := newStore(t)

	detail := "facilitator refused: " + strings.Repeat("é", maxRejectionDetail)

	if err := store.RecordRejection(context.Background(), Rejection{
		PublisherID: testPublisherID,
		AssertionID: "a_long_detail",
		Reason:      "payment_invalid",
		Detail:      detail,
	}); err != nil {
		t.Fatalf("RecordRejection refused a long non-ASCII detail: %v", err)
	}

	rows, err := store.RecentRejections(context.Background(), testPublisherID, 1)
	if err != nil {
		t.Fatalf("RecentRejections: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("the rejection did not persist")
	}
	if rows[0].Detail == nil || !utf8.ValidString(*rows[0].Detail) {
		t.Errorf("the stored detail is not valid UTF-8: %+v", rows[0].Detail)
	}
}
