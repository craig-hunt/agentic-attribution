<?php

declare(strict_types=1);

/**
 * A dependency-free runner so `docker compose` can verify the dashboard on a
 * stock php:8.3 image. PHPUnit stays configured in composer.json for local
 * development; nothing in the demo path needs an install step.
 */
require __DIR__ . '/../src/bootstrap.php';

use Agentic\Dashboard\Money;
use Agentic\Dashboard\Response;
use Agentic\Dashboard\Router;
use Agentic\Dashboard\View;

final class Assertions
{
    public static int $passed = 0;
    /** @var list<string> */
    public static array $failures = [];

    public static function same(mixed $expected, mixed $actual, string $label): void
    {
        if ($expected === $actual) {
            self::$passed++;

            return;
        }

        self::$failures[] = sprintf(
            "%s\n    expected: %s\n    actual:   %s",
            $label,
            var_export($expected, true),
            var_export($actual, true),
        );
    }

    public static function true(bool $condition, string $label): void
    {
        self::same(true, $condition, $label);
    }
}

// --- Money -----------------------------------------------------------------

Assertions::same('$129.99', Money::format(12_999), 'formats cents as dollars');
Assertions::same('$0.01', Money::format(1), 'formats a single cent');
Assertions::same('$0.00', Money::format(0), 'formats zero');
Assertions::same('-$5.00', Money::format(-500), 'formats a debit with the sign outside the symbol');
Assertions::same('$1,234,567.89', Money::format(123_456_789), 'groups thousands');
Assertions::same('€10.00', Money::format(1_000, 'EUR'), 'uses the euro symbol');
Assertions::same('10.00 JPY', Money::format(1_000, 'JPY'), 'falls back to a currency suffix');

Assertions::same('4.5%', Money::basisPoints(450), 'renders basis points as a percentage');
Assertions::same('100%', Money::basisPoints(10_000), 'renders a full rate without decimals');
Assertions::same('0%', Money::basisPoints(0), 'renders a zero rate');
Assertions::same('0.01%', Money::basisPoints(1), 'renders the smallest rate');

// --- Router ----------------------------------------------------------------

$router = new Router();
$router->get('/', static fn (): Response => new Response(200, 'index'));
$router->get('/publishers/{publisherId}', static fn (array $p): Response => new Response(200, $p['publisherId']));
$router->get('/settlements/{settlementId}', static fn (array $p): Response => new Response(200, $p['settlementId']));

Assertions::same('index', $router->dispatch('GET', '/')->body, 'routes the index');
Assertions::same('pub_0001', $router->dispatch('GET', '/publishers/pub_0001')->body, 'captures a parameter');
Assertions::same(404, $router->dispatch('GET', '/nope')->status, 'unknown paths 404');
Assertions::same(404, $router->dispatch('POST', '/')->status, 'a wrong method does not match');

// A placeholder must not match an empty segment, or the upstream receives a
// request for the identifier "" and answers with a confusing 404.
Assertions::same(404, $router->dispatch('GET', '/publishers/')->status, 'an empty segment does not match');

// Segment counts must match exactly, so a deeper path cannot fall into a
// shallower route.
Assertions::same(404, $router->dispatch('GET', '/publishers/a/b')->status, 'extra segments do not match');

Assertions::same(
    'pub 0001',
    $router->dispatch('GET', '/publishers/pub%200001')->body,
    'decodes a percent-encoded parameter',
);

// --- View escaping ---------------------------------------------------------

$view = new View(__DIR__ . '/fixtures');

// Product titles and merchant names arrive from generated feed data, so a
// dashboard interpolating them raw is one hostile feed away from stored XSS.
$rendered = $view->render('escape', ['value' => '<script>alert("xss")</script>']);
Assertions::true(!str_contains($rendered, '<script>'), 'escapes angle brackets');
Assertions::true(str_contains($rendered, '&lt;script&gt;'), 'renders the escaped entity');
Assertions::true(str_contains($rendered, '&quot;xss&quot;'), 'escapes double quotes');

$rendered = $view->render('escape', ['value' => "O'Brien & Sons"]);
Assertions::true(str_contains($rendered, '&amp;'), 'escapes ampersands');
Assertions::true(str_contains($rendered, '&#039;'), 'escapes single quotes');

// A template that throws must not leave the output buffer open, or its partial
// output leaks into whatever renders next.
$depth = ob_get_level();
try {
    $view->render('throws');
} catch (RuntimeException) {
    // expected
}
Assertions::same($depth, ob_get_level(), 'a throwing template leaves no open buffer');

$caught = false;
try {
    $view->render('does-not-exist');
} catch (RuntimeException) {
    $caught = true;
}
Assertions::true($caught, 'a missing template throws');


// --- Template smoke ---------------------------------------------------------

// Rendering every real template against representative data. Unit tests cover
// the helpers; nothing else would catch an undefined array key or a bad type
// coercion inside a template, and those surface as a blank page in front of a
// reviewer rather than as a failing assertion.
$templates = new View(__DIR__ . '/../templates');

$publisherRow = [
    'publisher_id' => 'pub_0001',
    'name' => 'Trail & Peak <Media>',
    'payout_currency' => 'USD',
];

$rendered = $templates->render('publishers', ['publishers' => [$publisherRow]]);
Assertions::true(str_contains($rendered, 'Trail &amp; Peak'), 'publisher list escapes the name');
Assertions::true(str_contains($rendered, '/publishers/pub_0001'), 'publisher list links to the detail page');

Assertions::true(
    str_contains($templates->render('publishers', ['publishers' => []]), 'No publishers yet'),
    'publisher list handles an empty catalog',
);

$summary = $publisherRow + [
    'settlement_count' => 3,
    'gross_amount_cents' => 38_997,
    'earned_cents' => 1_228,
    'platform_fee_cents' => 526,
    'search_request_count' => 12,
    'assertions_consumed' => 3,
    'average_commission_bps' => 450,
];

$settlementRow = [
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

$rendered = $templates->render('publisher', ['summary' => $summary, 'settlements' => [$settlementRow]]);
Assertions::true(str_contains($rendered, '$389.97'), 'publisher page formats gross');
Assertions::true(str_contains($rendered, '4.5%'), 'publisher page formats the commission rate');
Assertions::true(str_contains($rendered, 'Trail Runner &lt;Pro&gt;'), 'publisher page escapes a product title');
Assertions::true(!str_contains($rendered, '<Pro>'), 'publisher page leaks no raw markup');

Assertions::true(
    str_contains($templates->render('publisher', ['summary' => $summary, 'settlements' => []]), 'No settlements yet'),
    'publisher page handles no settlements',
);

$chain = [
    'settlement_id' => 'stl_1',
    'query_text' => 'trail running shoes',
    'search_request_id' => 'req_1',
    'search_latency_ms' => 23,
    'assertion_id' => 'a_1',
    'publisher_id' => 'pub_0001',
    'publisher_name' => 'Trail & Peak Media',
    'product_id' => 'prod_1',
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

$rendered = $templates->render('chain', ['chain' => $chain]);
Assertions::true(str_contains($rendered, 'trail running shoes'), 'chain shows the originating query');
Assertions::true(str_contains($rendered, '0xdeadbeef'), 'chain shows the transaction hash');

// The rendered balance proves the double-entry arithmetic reaches the page, not
// merely the database. A chain that balances anywhere other than zero is wrong.
Assertions::true(str_contains($rendered, '$0.00'), 'chain ledger balances to zero on the page');

// A settlement that never confirmed writes no ledger entries, which the page
// must explain rather than render as an empty table.
Assertions::true(
    str_contains(
        $templates->render('chain', ['chain' => ['ledger_entries' => []] + $chain]),
        'No ledger entries',
    ),
    'chain explains an empty ledger',
);

// A pruned search request leaves the chain intact minus its first link.
Assertions::true(
    str_contains(
        $templates->render('chain', ['chain' => ['query_text' => ''] + $chain]),
        'query record pruned',
    ),
    'chain survives a missing search request',
);

$rendered = $templates->render('layout', ['title' => 'Publishers', 'content' => '<p>body</p>']);
Assertions::true(str_contains($rendered, '<title>Publishers'), 'layout renders the title');
Assertions::true(str_contains($rendered, '<p>body</p>'), 'layout embeds content without escaping it');

Assertions::true(
    str_contains($templates->render('error', ['status' => 404, 'message' => 'No such page.']), '404'),
    'error page renders the status',
);

// --- Report ----------------------------------------------------------------

printf("%d passed, %d failed\n", Assertions::$passed, count(Assertions::$failures));

foreach (Assertions::$failures as $failure) {
    fwrite(STDERR, "  FAIL: {$failure}\n");
}

exit(Assertions::$failures === [] ? 0 : 1);
