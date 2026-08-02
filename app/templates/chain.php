<?php

declare(strict_types=1);

use Agentic\Dashboard\Money;

use function Agentic\Dashboard\e;

/** @var array<string,mixed> $chain */
$currency = 'USD';
$ledger = is_array($chain['ledger_entries'] ?? null) ? $chain['ledger_entries'] : [];
?>
<h1 data-testid="chain-heading">Attribution chain</h1>
<p class="sub">
  <code data-testid="chain-settlement-id"><?= e($chain['settlement_id']) ?></code> ·
  <a data-testid="chain-publisher-link" href="/publishers/<?= e(rawurlencode((string) $chain['publisher_id'])) ?>"><?= e($chain['publisher_name']) ?></a>
</p>

<ol class="chain" data-testid="chain-steps">
  <li data-testid="chain-step-search">
    <div class="step">1 · Agent searched</div>
    <strong data-testid="chain-query"><?= $chain['query_text'] !== '' ? e($chain['query_text']) : '(query record pruned)' ?></strong><br>
    <code data-testid="chain-search-request-id"><?= e($chain['search_request_id']) ?></code>
    <?php if ((int) $chain['search_latency_ms'] > 0): ?>
      · <?= e((string) $chain['search_latency_ms']) ?>ms
    <?php endif; ?>
  </li>
  <li data-testid="chain-step-assertion">
    <div class="step">2 · Platform minted a signed assertion</div>
    <code data-testid="chain-assertion-id"><?= e($chain['assertion_id']) ?></code><br>
    Ed25519, single use, bound to the search request above.
  </li>
  <li data-testid="chain-step-product">
    <div class="step">3 · Agent chose a product</div>
    <strong data-testid="chain-product-title"><?= e($chain['product_title']) ?></strong> from <span data-testid="chain-merchant-name"><?= e($chain['merchant_name']) ?></span><br>
    <code data-testid="chain-product-id"><?= e($chain['product_id']) ?></code>
  </li>
  <li data-testid="chain-step-payment">
    <div class="step">4 · Merchant charged over x402</div>
    <span data-testid="chain-gross"><?= e(Money::format((int) $chain['gross_amount_cents'], $currency)) ?></span> on <span data-testid="chain-network"><?= e($chain['chain_network']) ?></span>
    <?php if (is_string($chain['tx_hash'] ?? null) && $chain['tx_hash'] !== ''): ?>
      <br><code data-testid="chain-tx-hash"><?= e($chain['tx_hash']) ?></code>
    <?php endif; ?>
  </li>
  <li data-testid="chain-step-split">
    <div class="step">5 · Assertion consumed, commission split</div>
    <span data-testid="chain-commission-rate"><?= e(Money::basisPoints((int) $chain['commission_bps'])) ?></span> of
    <?= e(Money::format((int) $chain['gross_amount_cents'], $currency)) ?> =
    <span data-testid="chain-commission-amount"><?= e(Money::format((int) $chain['commission_amount_cents'], $currency)) ?></span>,
    of which the publisher earned
    <strong data-testid="chain-publisher-amount"><?= e(Money::format((int) $chain['publisher_amount_cents'], $currency)) ?></strong>.
    <br>
    <span data-testid="chain-status" class="pill<?= $chain['status'] === 'confirmed' ? '' : ' other' ?>"><?= e($chain['status']) ?></span>
  </li>
</ol>

<h2>Ledger entries</h2>

<?php if ($ledger === []): ?>
  <div class="err" data-testid="ledger-empty">No ledger entries. A settlement that never confirmed writes none, which is the intended behaviour rather than a gap.</div>
<?php else: ?>
  <table data-testid="ledger-table">
    <thead><tr><th>Account</th><th>Party</th><th>Type</th><th class="num">Amount</th></tr></thead>
    <tbody data-testid="ledger-rows">
    <?php $total = 0; ?>
    <?php foreach ($ledger as $entry): ?>
      <?php $total += (int) $entry['amount_cents']; ?>
      <tr data-testid="ledger-row" data-account="<?= e($entry['account']) ?>">
        <td data-testid="ledger-account"><?= e($entry['account']) ?></td>
        <td><code data-testid="ledger-party"><?= e($entry['account_id']) ?></code></td>
        <td data-testid="ledger-type"><?= e($entry['entry_type']) ?></td>
        <td class="num" data-testid="ledger-amount"><?= e(Money::format((int) $entry['amount_cents'], (string) $entry['currency'])) ?></td>
      </tr>
    <?php endforeach; ?>
      <tr>
        <td colspan="3"><strong>Balance</strong></td>
        <td class="num"><strong data-testid="ledger-balance"><?= e(Money::format($total, $currency)) ?></strong></td>
      </tr>
    </tbody>
  </table>
  <p class="sub">Double-entry: the merchant debit offsets the platform and publisher credits, so a correct settlement balances to zero.</p>
<?php endif; ?>
