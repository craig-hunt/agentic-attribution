<?php

declare(strict_types=1);

use function Agentic\Dashboard\e;

/** @var list<array{publisher_id:string,name:string,payout_currency:string}> $publishers */
?>
<h1>Publishers</h1>
<p class="sub">Every publisher earning commission through agent-mediated purchases.</p>

<?php if ($publishers === []): ?>
  <div class="err">No publishers yet. Run <code>make seed</code> to load the catalog.</div>
<?php else: ?>
  <table>
    <thead><tr><th>Publisher</th><th>Identifier</th><th>Payout currency</th></tr></thead>
    <tbody>
    <?php foreach ($publishers as $publisher): ?>
      <tr>
        <td><a href="/publishers/<?= e(rawurlencode($publisher['publisher_id'])) ?>"><?= e($publisher['name']) ?></a></td>
        <td><code><?= e($publisher['publisher_id']) ?></code></td>
        <td><?= e($publisher['payout_currency']) ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
<?php endif; ?>
