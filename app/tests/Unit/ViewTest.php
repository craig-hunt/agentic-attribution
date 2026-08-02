<?php

declare(strict_types=1);

namespace Agentic\Dashboard\Tests\Unit;

use Agentic\Dashboard\View;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use RuntimeException;

use function Agentic\Dashboard\e;

final class ViewTest extends TestCase
{
    private function fixtures(): View
    {
        return new View(__DIR__ . '/../fixtures');
    }

    private function templates(): View
    {
        return new View(__DIR__ . '/../../templates');
    }

    /**
     * Product titles and merchant names arrive from generated feed data, so a
     * dashboard interpolating them raw is one hostile merchant feed away from
     * stored XSS.
     */
    #[DataProvider('hostileValues')]
    public function testEveryDangerousCharacterEscapes(string $raw, string $mustContain, string $mustNotContain): void
    {
        $rendered = $this->fixtures()->render('escape', ['value' => $raw]);

        self::assertStringContainsString($mustContain, $rendered);
        self::assertStringNotContainsString($mustNotContain, $rendered);
    }

    public static function hostileValues(): array
    {
        return [
            'script tags' => ['<script>alert(1)</script>', '&lt;script&gt;', '<script>'],
            'double quotes' => ['say "hello"', '&quot;hello&quot;', '"hello"'],
            'single quotes' => ["O'Brien", '&#039;', "O'Brien"],
            'ampersands' => ['Trail & Peak', '&amp;', 'Trail & Peak'],
            'an attribute break-out' => ['" onerror="x', '&quot; onerror=&quot;x', '" onerror="'],
            'an injected image tag' => ['<img src=x onerror=alert(1)>', '&lt;img', '<img'],
        ];
    }

    /**
     * ENT_SUBSTITUTE rather than the default. Invalid UTF-8 would otherwise
     * return an empty string, silently blanking a field rather than escaping it.
     */
    public function testInvalidUtf8SubstitutesRatherThanBlanking(): void
    {
        self::assertNotSame('', e("valid\xB1\x31text"));
    }

    public function testEscapingHandlesTheOrdinaryCase(): void
    {
        self::assertSame('Trail Runner Pro', e('Trail Runner Pro'));
        self::assertSame('', e(''));
        self::assertSame('42', e(42));
    }

    /**
     * Without the buffer being cleaned on the way out, a template that throws
     * leaves partial output in the buffer, and it leaks into whatever renders
     * next.
     */
    public function testAThrowingTemplateLeavesNoOpenBuffer(): void
    {
        $depth = ob_get_level();

        try {
            $this->fixtures()->render('throws');
            self::fail('the throwing template did not throw');
        } catch (RuntimeException) {
            // expected
        }

        self::assertSame($depth, ob_get_level());
    }

    public function testAMissingTemplateThrowsNamingIt(): void
    {
        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessageMatches('/does-not-exist/');

        $this->fixtures()->render('does-not-exist');
    }

    /**
     * Rendering every real template against representative data. Nothing else
     * catches an undefined array key or a bad coercion inside a template, and
     * those surface as a blank page in front of a reviewer.
     */
    public function testThePublisherListRendersAndEscapes(): void
    {
        $rendered = $this->templates()->render('publishers', [
            'publishers' => [[
                'publisher_id' => 'pub_000001',
                'name' => 'Trail & Peak <Media>',
                'payout_currency' => 'USD',
                'settlement_count' => 3,
                'earned_cents' => 1234,
                'blocked_count' => 2,
                'failed_count' => 1,
            ]],
        ]);

        self::assertStringContainsString('Trail &amp; Peak &lt;Media&gt;', $rendered);
        self::assertStringContainsString('/publishers/pub_000001', $rendered);
        self::assertStringNotContainsString('<Media>', $rendered);
    }

    /**
     * A list of names alone gives a reader no way to tell the one publisher
     * that earned something from the forty-seven that never have, so the first
     * row they open is almost certainly empty.
     */
    public function testThePublisherListShowsEarningsAndPointsAtAnActiveOne(): void
    {
        $rendered = $this->templates()->render('publishers', [
            'publishers' => [[
                'publisher_id' => 'pub_000001',
                'name' => 'The Honest Review',
                'payout_currency' => 'USD',
                'settlement_count' => 3,
                'earned_cents' => 1234,
                'blocked_count' => 2,
                'failed_count' => 1,
            ]],
        ]);

        self::assertStringContainsString('$12.34', $rendered);
        self::assertStringContainsString('>3<', $rendered);
        self::assertStringContainsString('The Honest Review</a>', $rendered);
    }

    public function testAListWithNoEarningsSaysHowToCreateSome(): void
    {
        $rendered = $this->templates()->render('publishers', [
            'publishers' => [[
                'publisher_id' => 'pub_000001',
                'name' => 'The Honest Review',
                'payout_currency' => 'USD',
                'settlement_count' => 0,
                'earned_cents' => 0,
                'blocked_count' => 0,
                'failed_count' => 0,
            ]],
        ]);

        self::assertStringContainsString('Run one purchase', $rendered);
        self::assertStringContainsString('Include fraud attempts', $rendered);
    }

    /**
     * The chips narrow the table to the publishers each counter describes, and
     * the headers reorder it. Both need markup the script can bind to, so a
     * renamed attribute breaks a test rather than a page.
     */
    public function testThePublisherListOffersFiltersAndSortableHeaders(): void
    {
        $rendered = $this->templates()->render('publishers', [
            'publishers' => [[
                'publisher_id' => 'pub_000001',
                'name' => 'The Honest Review',
                'payout_currency' => 'USD',
                'settlement_count' => 3,
                'earned_cents' => 1234,
                'blocked_count' => 2,
                'failed_count' => 1,
            ]],
        ]);

        foreach (['settled', 'blocked', 'failed'] as $filter) {
            self::assertStringContainsString('data-filter="' . $filter . '"', $rendered);
        }

        foreach (['name', 'settlement_count', 'earned_cents', 'blocked_count', 'failed_count'] as $column) {
            self::assertStringContainsString('data-sort="' . $column . '"', $rendered);
        }

        // Earnings lead by default, so the column carries the marker on load.
        self::assertStringContainsString('data-sort="earned_cents"', $rendered);
        self::assertMatchesRegularExpression('/class="sortable num desc"[^>]*data-sort="earned_cents"/', $rendered);
    }

    public function testThePublisherListShowsFailedSettlementsSeparatelyFromBlocked(): void
    {
        $rendered = $this->templates()->render('publishers', [
            'publishers' => [[
                'publisher_id' => 'pub_000001',
                'name' => 'The Honest Review',
                'payout_currency' => 'USD',
                'settlement_count' => 3,
                'earned_cents' => 1234,
                'blocked_count' => 7,
                'failed_count' => 4,
            ]],
        ]);

        // A refusal and a settlement that fell over are different outcomes, and
        // showing one number for both would hide which happened.
        self::assertStringContainsString('>7<', $rendered);
        self::assertStringContainsString('>4<', $rendered);
    }

    public function testTheSettlementAndRejectionTablesSort(): void
    {
        $rendered = $this->templates()->render('publisher', [
            'summary' => self::summary(),
            'settlements' => [self::settlementRow()],
            'rejections' => [],
        ]);

        foreach (['gross_amount_cents', 'publisher_amount_cents', 'status', 'reason', 'created_at'] as $column) {
            self::assertStringContainsString('data-sort="' . $column . '"', $rendered);
        }
    }

    /**
     * The end-to-end suite binds to data-testid and to nothing else, following
     * the selector hierarchy in cypress-standards. Renaming or dropping one of
     * these breaks a suite that lives in another branch, where the failure
     * would report a missing element rather than a renamed hook.
     */
    public function testThePublisherListCarriesItsTestHooks(): void
    {
        $rendered = $this->templates()->render('publishers', [
            'publishers' => [self::publisherRow()],
        ]);

        foreach ([
            'publishers-heading',
            'publishers-table',
            'publisher-rows',
            'publisher-row',
            'publisher-link',
            'publisher-id',
            'publisher-settlements',
            'publisher-earned',
            'publisher-blocked',
            'publisher-failed',
            'run-once',
            'run-start',
            'run-stop',
            'fraud-toggle',
            'filter-settled',
            'filter-blocked',
            'filter-failed',
            'filter-all',
        ] as $hook) {
            self::assertStringContainsString('data-testid="' . $hook . '"', $rendered, $hook);
        }
    }

    public function testThePublisherDetailCarriesItsTestHooks(): void
    {
        $rendered = $this->templates()->render('publisher', [
            'summary' => self::summary(),
            'settlements' => [self::settlementRow()],
            'rejections' => [[
                'reason' => 'assertion_signature_invalid',
                'assertion_id' => 'a1',
                'merchant_id' => 'mer_000042',
                'detail' => null,
                'created_at' => '2026-08-02T12:00:09Z',
            ]],
        ]);

        foreach ([
            'publisher-name',
            'summary-earned',
            'summary-blocked',
            'settlement-row',
            'settlement-gross',
            'settlement-earned',
            'settlement-chain-link',
            'rejection-row',
            'rejection-reason',
            'rejection-merchant',
        ] as $hook) {
            self::assertStringContainsString('data-testid="' . $hook . '"', $rendered, $hook);
        }
    }

    /**
     * The chain page carries the argument this project makes, so every value a
     * reviewer would check has to be addressable rather than scraped out of
     * prose that a copy edit would move.
     */
    public function testTheChainCarriesItsTestHooks(): void
    {
        $rendered = $this->templates()->render('chain', ['chain' => self::chain()]);

        foreach ([
            'chain-settlement-id',
            'chain-query',
            'chain-assertion-id',
            'chain-product-title',
            'chain-gross',
            'chain-tx-hash',
            'chain-commission-rate',
            'chain-commission-amount',
            'chain-publisher-amount',
            'chain-status',
            'ledger-table',
            'ledger-row',
            'ledger-account',
            'ledger-amount',
            'ledger-balance',
        ] as $hook) {
            self::assertStringContainsString('data-testid="' . $hook . '"', $rendered, $hook);
        }
    }

    /**
     * The poll replaces every row it rendered, so a hook the server emits and
     * the script omits survives exactly until the first refresh. That failure
     * looks like a flaky suite rather than a missing attribute.
     */
    public function testTheScriptsRebuildRowsWithTheSameHooks(): void
    {
        $list = $this->templates()->render('publishers', ['publishers' => [self::publisherRow()]]);
        $detail = $this->templates()->render('publisher', [
            'summary' => self::summary(),
            'settlements' => [],
            'rejections' => [],
        ]);

        foreach (['publisher-link', 'publisher-earned', 'publisher-blocked', 'publisher-failed'] as $hook) {
            self::assertSame(2, substr_count($list, 'data-testid="' . $hook . '"'), $hook);
        }

        foreach (['settlement-row', 'settlement-gross', 'rejection-reason'] as $hook) {
            self::assertStringContainsString('data-testid="' . $hook . '"', $detail, $hook);
        }
    }

    /** @return array<string, mixed> */
    private static function publisherRow(): array
    {
        return [
            'publisher_id' => 'pub_000001',
            'name' => 'The Honest Review',
            'payout_currency' => 'USD',
            'settlement_count' => 3,
            'earned_cents' => 1234,
            'blocked_count' => 2,
            'failed_count' => 1,
        ];
    }

    public function testAnEmptyCatalogExplainsHowToLoadIt(): void
    {
        $rendered = $this->templates()->render('publishers', ['publishers' => []]);

        self::assertStringContainsString('No publishers yet', $rendered);
        self::assertStringContainsString('make seed', $rendered);
    }

    public function testThePublisherPageFormatsMoneyAndRates(): void
    {
        $rendered = $this->templates()->render('publisher', [
            'summary' => self::summary(),
            'settlements' => [self::settlementRow()],
            'rejections' => [],
        ]);

        self::assertStringContainsString('$389.97', $rendered);
        self::assertStringContainsString('4.5%', $rendered);
        self::assertStringContainsString('Trail Runner &lt;Pro&gt;', $rendered);
        self::assertStringNotContainsString('<Pro>', $rendered);
    }

    public function testAPublisherWithNoSettlementsExplainsHowToCreateOne(): void
    {
        $rendered = $this->templates()->render('publisher', [
            'summary' => self::summary(),
            'settlements' => [],
            'rejections' => [],
        ]);

        self::assertStringContainsString('No settlements for this publisher yet', $rendered);
        self::assertStringContainsString('Run one purchase', $rendered);
    }

    /**
     * A refused attempt is a payout that did not happen, decided by signature
     * verification. Showing it beside the settlements is what turns the
     * security claim into something a viewer watches rather than reads.
     */
    public function testBlockedAttemptsRenderWithTheirReason(): void
    {
        $rendered = $this->templates()->render('publisher', [
            'summary' => self::summary(),
            'settlements' => [],
            'rejections' => [[
                'reason' => 'assertion_signature_invalid',
                'assertion_id' => 'a1',
                'merchant_id' => 'mer_000042',
                'detail' => 'verify assertion: invalid signature',
                'created_at' => '2026-07-30T12:00:09Z',
            ]],
        ]);

        self::assertStringContainsString('assertion_signature_invalid', $rendered);
        self::assertStringContainsString('mer_000042', $rendered);
        // The empty-state block renders either way; its visibility carries the
        // meaning, so assert on that rather than on its absence.
        // Matched by attribute rather than by exact string, so adding a test
        // hook between the existing attributes does not break the assertion.
        self::assertMatchesRegularExpression('/id="rejections-empty"[^>]*\shidden/', $rendered);
    }

    public function testNoBlockedAttemptsExplainsHowToCreateOne(): void
    {
        $rendered = $this->templates()->render('publisher', [
            'summary' => self::summary(),
            'settlements' => [],
            'rejections' => [],
        ]);

        self::assertStringContainsString('Nothing refused yet', $rendered);
        self::assertStringContainsString('Include fraud attempts', $rendered);
    }

    /**
     * The rendered balance proves the double-entry arithmetic survives all the
     * way to the page rather than merely holding in the database.
     */
    public function testTheChainRendersABalancedLedger(): void
    {
        $rendered = $this->templates()->render('chain', ['chain' => self::chain()]);

        self::assertStringContainsString('trail running shoes', $rendered);
        self::assertStringContainsString('0xdeadbeef', $rendered);
        self::assertStringContainsString('$0.00', $rendered);
    }

    public function testAPendingChainExplainsItsEmptyLedger(): void
    {
        $rendered = $this->templates()->render('chain', [
            'chain' => ['ledger_entries' => []] + self::chain(),
        ]);

        self::assertStringContainsString('No ledger entries', $rendered);
    }

    public function testAPrunedSearchRequestStillRenders(): void
    {
        $rendered = $this->templates()->render('chain', [
            'chain' => ['query_text' => ''] + self::chain(),
        ]);

        self::assertStringContainsString('query record pruned', $rendered);
    }

    public function testTheLayoutEmbedsContentWithoutEscapingIt(): void
    {
        $rendered = $this->templates()->render('layout', [
            'title' => 'Publishers & <Co>',
            'content' => '<p>body</p>',
        ]);

        // The title is data and gets escaped; the content is already-rendered
        // markup and must not be.
        self::assertStringContainsString('Publishers &amp; &lt;Co&gt;', $rendered);
        self::assertStringContainsString('<p>body</p>', $rendered);
    }

    public function testTheErrorPageRendersItsStatus(): void
    {
        $rendered = $this->templates()->render('error', ['status' => 404, 'message' => 'No such page.']);

        self::assertStringContainsString('404', $rendered);
        self::assertStringContainsString('No such page.', $rendered);
    }

    private static function summary(): array
    {
        return [
            'publisher_id' => 'pub_0001',
            'name' => 'Trail & Peak <Media>',
            'payout_currency' => 'USD',
            'settlement_count' => 3,
            'gross_amount_cents' => 38_997,
            'earned_cents' => 1_228,
            'platform_fee_cents' => 526,
            'search_request_count' => 12,
            'blocked_count' => 4,
            'assertions_consumed' => 3,
            'average_commission_bps' => 450,
        ];
    }

    private static function settlementRow(): array
    {
        return [
            'settlement_id' => 'stl_1',
            'product_title' => 'Trail Runner <Pro>',
            'merchant_name' => 'Summit Outfitters',
            'gross_amount_cents' => 12_999,
            'publisher_amount_cents' => 409,
            'commission_bps' => 450,
            'status' => 'confirmed',
            'tx_hash' => '0xdeadbeef',
            'created_at' => '2026-07-30T12:00:00Z',
            'confirmed_at' => '2026-07-30T12:00:04Z',
        ];
    }

    private static function chain(): array
    {
        return [
            'settlement_id' => 'stl_1',
            'query_text' => 'trail running shoes',
            'search_request_id' => 'req_1',
            'search_latency_ms' => 23,
            'assertion_id' => 'a_1',
            'publisher_id' => 'pub_0001',
            'publisher_name' => 'Trail & Peak Media',
            'product_id' => 'prd_1',
            'product_title' => 'Trail Runner Pro',
            'merchant_name' => 'Summit Outfitters',
            'gross_amount_cents' => 12_999,
            'commission_bps' => 450,
            'commission_amount_cents' => 584,
            'platform_fee_cents' => 175,
            'publisher_amount_cents' => 409,
            'chain_network' => 'base-sepolia',
            'tx_hash' => '0xdeadbeef',
            'status' => 'confirmed',
            'ledger_entries' => [
                ['account' => 'merchant_payable', 'account_id' => 'merch_1', 'entry_type' => 'commission', 'amount_cents' => -584, 'currency' => 'USD'],
                ['account' => 'platform_revenue', 'account_id' => 'platform', 'entry_type' => 'commission', 'amount_cents' => 175, 'currency' => 'USD'],
                ['account' => 'publisher_payable', 'account_id' => 'pub_0001', 'entry_type' => 'commission', 'amount_cents' => 409, 'currency' => 'USD'],
            ],
        ];
    }
}
