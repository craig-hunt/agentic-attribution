<?php

declare(strict_types=1);

use Agentic\Dashboard\Money;

use function Agentic\Dashboard\e;

/** @var array<string,mixed> $chain */
$currency = 'USD';
$ledger = is_array($chain['ledger_entries'] ?? null) ? $chain['ledger_entries'] : [];
?>
<h1>Attribution chain</h1>
<p class="sub">
  <code><?= e($chain['settlement_id']) ?></code> ·
  <a href="/publishers/<?= e(rawurlencode((string) $chain['publisher_id'])) ?>"><?= e($chain['publisher_name']) ?></a>
</p>

<ol class="chain">
  <li>
    <div class="step">1 · Agent searched</div>
    <strong><?= $chain['query_text'] !== '' ? e($chain['query_text']) : '(query record pruned)' ?></strong><br>
    <code><?= e($chain['search_request_id']) ?></code>
    <?php if ((int) $chain['search_latency_ms'] > 0): ?>
      · <?= e((string) $chain['search_latency_ms']) ?>ms
    <?php endif; ?>
  </li>
  <li>
    <div class="step">2 · Platform minted a signed assertion</div>
    <code><?= e($chain['assertion_id']) ?></code><br>
    Ed25519, single use, bound to the search request above.
  </li>
  <li>
    <div class="step">3 · Agent chose a product</div>
    <strong><?= e($chain['product_title']) ?></strong> from <?= e($chain['merchant_name']) ?><br>
    <code><?= e($chain['product_id']) ?></code>
  </li>
  <li>
    <div class="step">4 · Merchant charged over x402</div>
    <?= e(Money::format((int) $chain['gross_amount_cents'], $currency)) ?> on <?= e($chain['chain_network']) ?>
    <?php if (is_string($chain['tx_hash'] ?? null) && $chain['tx_hash'] !== ''): ?>
      <br><code><?= e($chain['tx_hash']) ?></code>
    <?php endif; ?>
  </li>
  <li>
    <div class="step">5 · Assertion consumed, commission split</div>
    <?= e(Money::basisPoints((int) $chain['commission_bps'])) ?> of
    <?= e(Money::format((int) $chain['gross_amount_cents'], $currency)) ?> =
    <?= e(Money::format((int) $chain['commission_amount_cents'], $currency)) ?>,
    of which the publisher earned
    <strong><?= e(Money::format((int) $chain['publisher_amount_cents'], $currency)) ?></strong>.
    <br>
    <span class="pill<?= $chain['status'] === 'confirmed' ? '' : ' other' ?>"><?= e($chain['status']) ?></span>
  </li>
</ol>

<h2>Ledger entries</h2>

<?php if ($ledger === []): ?>
  <div class="err">No ledger entries. A settlement that never confirmed writes none, which is the intended behaviour rather than a gap.</div>
<?php else: ?>
  <table>
    <thead><tr><th>Account</th><th>Party</th><th>Type</th><th class="num">Amount</th></tr></thead>
    <tbody>
    <?php $total = 0; ?>
    <?php foreach ($ledger as $entry): ?>
      <?php $total += (int) $entry['amount_cents']; ?>
      <tr>
        <td><?= e($entry['account']) ?></td>
        <td><code><?= e($entry['account_id']) ?></code></td>
        <td><?= e($entry['entry_type']) ?></td>
        <td class="num"><?= e(Money::format((int) $entry['amount_cents'], (string) $entry['currency'])) ?></td>
      </tr>
    <?php endforeach; ?>
      <tr>
        <td colspan="3"><strong>Balance</strong></td>
        <td class="num"><strong><?= e(Money::format($total, $currency)) ?></strong></td>
      </tr>
    </tbody>
  </table>
  <p class="sub">Double-entry: the merchant debit offsets the platform and publisher credits, so a correct settlement balances to zero.</p>
<?php endif; ?>
