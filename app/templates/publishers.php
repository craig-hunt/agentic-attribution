<?php

declare(strict_types=1);

use Agentic\Dashboard\Money;

use function Agentic\Dashboard\e;

/** @var list<array{publisher_id:string,name:string,payout_currency:string,settlement_count:int,earned_cents:int,blocked_count:int}> $publishers */
/** @var callable $partial */

$earning = array_values(array_filter(
    $publishers,
    static fn (array $publisher): bool => $publisher['settlement_count'] > 0,
));
?>
<h1 data-testid="publishers-heading">Publishers</h1>
<p class="sub">Every publisher earning commission through agent-mediated purchases.</p>

<?= $partial('controls', []) ?>

<?php if ($publishers === []): ?>
  <div class="err" data-testid="catalog-empty">No publishers yet. Run <code>make seed</code> to load the catalog.</div>
<?php else: ?>
  <?php if ($earning === []): ?>
    <div class="err" id="empty-hint" data-testid="no-settlements-hint">
      No purchase has settled yet. Press <strong>Run one purchase</strong> to send a
      single agent through search, payment, and settlement, or <strong>Start
      agents</strong> to run a population of them. Tick <strong>Include fraud
      attempts</strong> to watch the platform refuse tampered assertions.
    </div>
  <?php endif; ?>

  <div id="filter-empty" class="err" data-testid="filter-empty" hidden></div>

  <table data-testid="publishers-table">
    <thead>
      <tr>
        <th class="sortable" data-sort="name" data-testid="sort-name">Publisher</th>
        <th class="sortable" data-sort="publisher_id" data-testid="sort-publisher-id">Identifier</th>
        <th class="sortable num" data-sort="settlement_count" data-testid="sort-settlements">Settlements</th>
        <th class="sortable num desc" data-sort="earned_cents" data-testid="sort-earned">Earned</th>
        <th class="sortable num" data-sort="blocked_count" data-testid="sort-blocked">Blocked</th>
        <th class="sortable num" data-sort="failed_count" data-testid="sort-failed">Failed</th>
      </tr>
    </thead>
    <tbody id="publisher-rows" data-testid="publisher-rows">
    <?php foreach ($publishers as $publisher): ?>
      <tr data-publisher="<?= e($publisher['publisher_id']) ?>" data-testid="publisher-row">
        <td><a data-testid="publisher-link" href="/publishers/<?= e(rawurlencode($publisher['publisher_id'])) ?>"><?= e($publisher['name']) ?></a></td>
        <td><code data-testid="publisher-id"><?= e($publisher['publisher_id']) ?></code></td>
        <td class="num" data-testid="publisher-settlements"><?= e((string) $publisher['settlement_count']) ?></td>
        <td class="num" data-testid="publisher-earned"><?= e(Money::format((int) $publisher['earned_cents'], $publisher['payout_currency'])) ?></td>
        <td class="num blocked" data-testid="publisher-blocked"><?= e((string) $publisher['blocked_count']) ?></td>
        <td class="num" data-testid="publisher-failed"><?= e((string) $publisher['failed_count']) ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
<?php endif; ?>

<script>
(() => {
  const body = document.getElementById('publisher-rows');
  if (!body) { return; }

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const money = (cents, currency) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' })
      .format(cents / 100);

  const cellsOf = (row) =>
    [...row.children].slice(2).map((cell) => cell.textContent).join('|');

  // Which counter each chip narrows the table to. A publisher with no activity
  // of that kind has nothing to say about it.
  const FILTERS = {
    settled: (p) => p.settlement_count > 0,
    blocked: (p) => p.blocked_count > 0,
    failed: (p) => p.failed_count > 0,
  };

  let filter = '';
  let sortKey = 'earned_cents';
  let sortDir = 'desc';
  let latest = [];

  const compare = (a, b) => {
    const left = a[sortKey];
    const right = b[sortKey];
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));

    // Ties fall back to the identifier so the order never shuffles between
    // polls, which would make a live table impossible to read.
    return (sortDir === 'asc' ? order : -order) ||
      a.publisher_id.localeCompare(b.publisher_id);
  };

  // Every hook the server rendered has to survive a refresh, or the suite
  // binds to a table that exists only until the first poll replaces it.
  const rowHtml = (p) =>
    `<td><a data-testid="publisher-link" href="/publishers/${encodeURIComponent(p.publisher_id)}">` +
    `${escapeHtml(p.name)}</a></td>` +
    `<td><code data-testid="publisher-id">${escapeHtml(p.publisher_id)}</code></td>` +
    `<td class="num" data-testid="publisher-settlements">${p.settlement_count}</td>` +
    `<td class="num" data-testid="publisher-earned">${money(p.earned_cents, p.payout_currency)}</td>` +
    `<td class="num blocked" data-testid="publisher-blocked">${p.blocked_count}</td>` +
    `<td class="num" data-testid="publisher-failed">${p.failed_count}</td>`;

  const draw = () => {
    const previous = new Map(
      [...body.querySelectorAll('tr')].map((row) => [row.dataset.publisher, cellsOf(row)]),
    );

    const shown = latest
      .filter((p) => (filter === '' ? true : (FILTERS[filter]?.(p) ?? true)))
      .sort(compare);

    body.replaceChildren(...shown.map((publisher) => {
      const row = document.createElement('tr');
      row.dataset.publisher = publisher.publisher_id;
      row.dataset.testid = 'publisher-row';
      row.innerHTML = rowHtml(publisher);

      const before = previous.get(publisher.publisher_id);
      if (before !== undefined && before !== cellsOf(row)) {
        row.classList.add('changed');
      }

      return row;
    }));

    const empty = document.getElementById('filter-empty');
    if (empty) {
      empty.hidden = shown.length > 0;
      empty.textContent = `No publisher has anything ${filter} yet.`;
    }
  };

  document.querySelectorAll('th.sortable').forEach((header) => {
    header.addEventListener('click', () => {
      const key = header.dataset.sort;
      // A second press on the same column reverses it; a different column
      // starts descending, because the interesting end of every column here is
      // the large end.
      sortDir = key === sortKey && sortDir === 'desc' ? 'asc' : 'desc';
      sortKey = key;

      document.querySelectorAll('th.sortable').forEach((other) => {
        other.classList.remove('asc', 'desc');
      });
      header.classList.add(sortDir);

      draw();
    });
  });

  window.agenticSetFilter = (next) => {
    filter = next;
    draw();
  };

  // The settlement service ranks by earnings, and the client re-sorts to
  // whatever column the reader chose. Rows whose numbers changed flash once,
  // which makes a live run legible rather than a wall of shifting digits.
  window.agenticRefresh = async () => {
    let publishers;
    try {
      publishers = (await (await fetch('/api/publishers')).json()).publishers;
    } catch {
      return;
    }
    if (!Array.isArray(publishers)) { return; }

    latest = publishers;
    draw();

    const hint = document.getElementById('empty-hint');
    if (hint && publishers.some((publisher) => publisher.settlement_count > 0)) {
      hint.remove();
    }
  };
})();
</script>
