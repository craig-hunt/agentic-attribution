<?php

declare(strict_types=1);

use Agentic\Dashboard\Money;

use function Agentic\Dashboard\e;

/** @var array<string,mixed> $summary */
/** @var list<array<string,mixed>> $settlements */
$currency = (string) $summary['payout_currency'];
?>
<h1><?= e($summary['name']) ?></h1>
<p class="sub"><code><?= e($summary['publisher_id']) ?></code></p>

<div class="cards">
  <div class="card"><div class="k">Earned</div><div class="v"><?= e(Money::format((int) $summary['earned_cents'], $currency)) ?></div></div>
  <div class="card"><div class="k">Gross referred</div><div class="v"><?= e(Money::format((int) $summary['gross_amount_cents'], $currency)) ?></div></div>
  <div class="card"><div class="k">Settlements</div><div class="v"><?= e(number_format((int) $summary['settlement_count'])) ?></div></div>
  <div class="card"><div class="k">Avg commission</div><div class="v"><?= e(Money::basisPoints((int) $summary['average_commission_bps'])) ?></div></div>
  <div class="card"><div class="k">Searches</div><div class="v"><?= e(number_format((int) $summary['search_request_count'])) ?></div></div>
  <div class="card"><div class="k">Assertions used</div><div class="v"><?= e(number_format((int) $summary['assertions_consumed'])) ?></div></div>
</div>

<h2>Settlements</h2>

<?php if ($settlements === []): ?>
  <div class="err">No settlements yet. Run <code>npm run simulate</code> to drive a purchase.</div>
<?php else: ?>
  <table>
    <thead>
      <tr>
        <th>Product</th><th>Merchant</th><th class="num">Gross</th>
        <th class="num">Rate</th><th class="num">Earned</th><th>Status</th><th>Chain</th>
      </tr>
    </thead>
    <tbody>
    <?php foreach ($settlements as $settlement): ?>
      <tr>
        <td><?= e($settlement['product_title']) ?></td>
        <td><?= e($settlement['merchant_name']) ?></td>
        <td class="num"><?= e(Money::format((int) $settlement['gross_amount_cents'], $currency)) ?></td>
        <td class="num"><?= e(Money::basisPoints((int) $settlement['commission_bps'])) ?></td>
        <td class="num"><?= e(Money::format((int) $settlement['publisher_amount_cents'], $currency)) ?></td>
        <td>
          <span class="pill<?= $settlement['status'] === 'confirmed' ? '' : ' other' ?>"><?= e($settlement['status']) ?></span>
        </td>
        <td><a href="/settlements/<?= e(rawurlencode((string) $settlement['settlement_id'])) ?>">view</a></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
<?php endif; ?>
