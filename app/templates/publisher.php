<?php

declare(strict_types=1);

use Agentic\Dashboard\Money;

use function Agentic\Dashboard\e;

/** @var array<string,mixed> $summary */
/** @var list<array<string,mixed>> $settlements */
/** @var list<array<string,mixed>> $rejections */
/** @var callable $partial */
$currency = (string) $summary['payout_currency'];
?>
<h1 data-testid="publisher-name"><?= e($summary['name']) ?></h1>
<p class="sub"><code data-testid="publisher-id"><?= e($summary['publisher_id']) ?></code></p>

<?= $partial('controls', []) ?>

<div class="cards" id="summary-cards" data-publisher="<?= e($summary['publisher_id']) ?>" data-currency="<?= e($currency) ?>">
  <div class="card"><div class="k">Earned</div><div class="v" data-testid="summary-earned"><?= e(Money::format((int) $summary['earned_cents'], $currency)) ?></div></div>
  <div class="card"><div class="k">Gross referred</div><div class="v" data-testid="summary-gross"><?= e(Money::format((int) $summary['gross_amount_cents'], $currency)) ?></div></div>
  <div class="card"><div class="k">Settlements</div><div class="v" data-testid="summary-settlements"><?= e(number_format((int) $summary['settlement_count'])) ?></div></div>
  <div class="card"><div class="k">Avg commission</div><div class="v" data-testid="summary-avg-commission"><?= e(Money::basisPoints((int) $summary['average_commission_bps'])) ?></div></div>
  <div class="card"><div class="k">Searches</div><div class="v" data-testid="summary-searches"><?= e(number_format((int) $summary['search_request_count'])) ?></div></div>
  <div class="card"><div class="k">Assertions used</div><div class="v" data-testid="summary-assertions"><?= e(number_format((int) $summary['assertions_consumed'])) ?></div></div>
  <div class="card"><div class="k">Blocked</div><div class="v blocked" data-testid="summary-blocked"><?= e(number_format((int) $summary['blocked_count'])) ?></div></div>
</div>

<h2>Settlements</h2>

<div id="settlements-empty" class="err" data-testid="settlements-empty"<?= $settlements === [] ? '' : ' hidden' ?>>
  No settlements for this publisher yet. Press <strong>Run one purchase</strong>
  above, or <strong>Start agents</strong> and wait for one to land here.
</div>

<div id="settlements-wrap" data-testid="settlements-wrap"<?= $settlements === [] ? ' hidden' : '' ?>>
  <table>
    <thead>
      <tr>
        <th class="sortable" data-sort="product_title" data-testid="sort-product">Product</th>
        <th class="sortable" data-sort="merchant_name">Merchant</th>
        <th class="sortable num" data-sort="gross_amount_cents" data-testid="sort-gross">Gross</th>
        <th class="sortable num" data-sort="commission_bps">Rate</th>
        <th class="sortable num" data-sort="publisher_amount_cents" data-testid="sort-settlement-earned">Earned</th>
        <th class="sortable" data-sort="status">Status</th>
        <th>Chain</th>
      </tr>
    </thead>
    <tbody id="settlement-rows" data-testid="settlement-rows">
    <?php foreach ($settlements as $settlement): ?>
      <tr data-testid="settlement-row" data-settlement="<?= e((string) $settlement['settlement_id']) ?>">
        <td data-testid="settlement-product"><?= e($settlement['product_title']) ?></td>
        <td data-testid="settlement-merchant"><?= e($settlement['merchant_name']) ?></td>
        <td class="num" data-testid="settlement-gross"><?= e(Money::format((int) $settlement['gross_amount_cents'], $currency)) ?></td>
        <td class="num" data-testid="settlement-rate"><?= e(Money::basisPoints((int) $settlement['commission_bps'])) ?></td>
        <td class="num" data-testid="settlement-earned"><?= e(Money::format((int) $settlement['publisher_amount_cents'], $currency)) ?></td>
        <td>
          <span class="pill<?= $settlement['status'] === 'confirmed' ? '' : ' other' ?>" data-testid="settlement-status"><?= e($settlement['status']) ?></span>
        </td>
        <td><a data-testid="settlement-chain-link" href="/settlements/<?= e(rawurlencode((string) $settlement['settlement_id'])) ?>">view</a></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
</div>

<h2>Blocked attempts</h2>
<p class="sub">
  Assertions the platform refused in this publisher's name. Every row here is a
  payout that did not happen, decided by signature verification rather than by
  review.
</p>

<div id="rejections-empty" class="err" data-testid="rejections-empty"<?= $rejections === [] ? '' : ' hidden' ?>>
  Nothing refused yet. Tick <strong>Include fraud attempts</strong> above to send
  tampered assertions through the same path a genuine purchase takes.
</div>

<div id="rejections-wrap" data-testid="rejections-wrap"<?= $rejections === [] ? ' hidden' : '' ?>>
  <table>
    <thead>
      <tr>
        <th class="sortable" data-sort="reason" data-testid="sort-reason">Reason</th>
        <th>Assertion</th>
        <th class="sortable" data-sort="merchant_id">Merchant</th>
        <th class="sortable" data-sort="created_at">When</th>
      </tr>
    </thead>
    <tbody id="rejection-rows" data-testid="rejection-rows">
    <?php foreach ($rejections as $rejection): ?>
      <tr data-testid="rejection-row">
        <td><span class="pill other" data-testid="rejection-reason"><?= e((string) $rejection['reason']) ?></span></td>
        <td><code data-testid="rejection-assertion"><?= e((string) ($rejection['assertion_id'] ?? '')) ?></code></td>
        <td><code data-testid="rejection-merchant"><?= e((string) ($rejection['merchant_id'] ?? '')) ?></code></td>
        <td data-testid="rejection-when"><?= e((string) $rejection['created_at']) ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
</div>

<script>
(() => {
  const cards = document.getElementById('summary-cards');
  if (!cards) { return; }

  const publisherId = cards.dataset.publisher;
  const currency = cards.dataset.currency || 'USD';

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const money = (cents) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

  const bps = (value) => (value / 100).toFixed(2) + '%';

  // Cards render in a fixed order, so index maps to meaning. Rewriting only
  // the value keeps the label and the layout untouched between polls.
  const CARD_VALUES = (s) => [
    money(s.earned_cents),
    money(s.gross_amount_cents),
    String(s.settlement_count),
    bps(s.average_commission_bps),
    String(s.search_request_count),
    String(s.assertions_consumed),
    String(s.blocked_count),
  ];

  const show = (id, visible) => {
    const node = document.getElementById(id);
    if (node) { node.hidden = !visible; }
  };

  // One sort per table, held across polls so a live page keeps the order the
  // reader chose rather than snapping back every second and a half.
  const sorts = new Map();

  const sorted = (rows, table) => {
    const sort = sorts.get(table);
    if (!sort) { return rows; }

    return [...rows].sort((a, b) => {
      const left = a[sort.key];
      const right = b[sort.key];
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left ?? '').localeCompare(String(right ?? ''));

      return sort.dir === 'asc' ? order : -order;
    });
  };

  document.querySelectorAll('table').forEach((table, index) => {
    table.querySelectorAll('th.sortable').forEach((header) => {
      header.addEventListener('click', () => {
        const current = sorts.get(index);
        const key = header.dataset.sort;
        const dir = current?.key === key && current.dir === 'desc' ? 'asc' : 'desc';

        sorts.set(index, { key, dir });
        table.querySelectorAll('th.sortable').forEach((other) => {
          other.classList.remove('asc', 'desc');
        });
        header.classList.add(dir);

        window.agenticRefresh?.();
      });
    });
  });

  const tableIndexOf = (bodyId) => {
    const tables = [...document.querySelectorAll('table')];

    return tables.findIndex((table) => table.querySelector(`#${bodyId}`));
  };

  window.agenticRefresh = async () => {
    let data;
    try {
      data = await (await fetch(`/api/publishers/${encodeURIComponent(publisherId)}`)).json();
    } catch {
      return;
    }
    if (!data || !data.summary) { return; }

    const values = CARD_VALUES(data.summary);
    [...cards.querySelectorAll('.card .v')].forEach((node, index) => {
      if (values[index] !== undefined && node.textContent !== values[index]) {
        node.textContent = values[index];
      }
    });

    const settlements = sorted(
      Array.isArray(data.settlements) ? data.settlements : [],
      tableIndexOf('settlement-rows'),
    );
    const settlementRows = document.getElementById('settlement-rows');
    if (settlementRows) {
      settlementRows.innerHTML = settlements.map((s) => `
        <tr data-testid="settlement-row" data-settlement="${escapeHtml(s.settlement_id)}">
          <td data-testid="settlement-product">${escapeHtml(s.product_title)}</td>
          <td data-testid="settlement-merchant">${escapeHtml(s.merchant_name)}</td>
          <td class="num" data-testid="settlement-gross">${money(s.gross_amount_cents)}</td>
          <td class="num" data-testid="settlement-rate">${bps(s.commission_bps)}</td>
          <td class="num" data-testid="settlement-earned">${money(s.publisher_amount_cents)}</td>
          <td><span class="pill${s.status === 'confirmed' ? '' : ' other'}" data-testid="settlement-status">${escapeHtml(s.status)}</span></td>
          <td><a data-testid="settlement-chain-link" href="/settlements/${encodeURIComponent(s.settlement_id)}">view</a></td>
        </tr>`).join('');
    }
    show('settlements-wrap', settlements.length > 0);
    show('settlements-empty', settlements.length === 0);

    const rejections = sorted(
      Array.isArray(data.rejections) ? data.rejections : [],
      tableIndexOf('rejection-rows'),
    );
    const rejectionRows = document.getElementById('rejection-rows');
    if (rejectionRows) {
      rejectionRows.innerHTML = rejections.map((r) => `
        <tr data-testid="rejection-row">
          <td><span class="pill other" data-testid="rejection-reason">${escapeHtml(r.reason)}</span></td>
          <td><code data-testid="rejection-assertion">${escapeHtml(r.assertion_id ?? '')}</code></td>
          <td><code data-testid="rejection-merchant">${escapeHtml(r.merchant_id ?? '')}</code></td>
          <td data-testid="rejection-when">${escapeHtml(r.created_at)}</td>
        </tr>`).join('');
    }
    show('rejections-wrap', rejections.length > 0);
    show('rejections-empty', rejections.length === 0);
  };
})();
</script>
