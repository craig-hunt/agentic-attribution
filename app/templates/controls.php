<?php

declare(strict_types=1);
?>
<div class="controls" id="controls" data-testid="run-controls">
  <button type="button" id="run-once" data-testid="run-once">Run one purchase</button>
  <button type="button" id="run-start" class="primary" data-testid="run-start">Start agents</button>
  <button type="button" id="run-stop" disabled data-testid="run-stop">Stop</button>

  <label>Agents
    <input type="number" id="concurrency" value="6" min="1" max="24" step="1" data-testid="concurrency">
  </label>

  <label>
    <input type="checkbox" id="fraud" data-testid="fraud-toggle"> Include fraud attempts
  </label>

  <span class="live" id="live-stats">
    <button type="button" class="chip" data-filter="settled" data-testid="filter-settled"><b id="stat-settled" data-testid="stat-settled">0</b> settled</button>
    <button type="button" class="chip" data-filter="blocked" data-testid="filter-blocked"><b id="stat-blocked" data-testid="stat-blocked">0</b> blocked</button>
    <button type="button" class="chip" data-filter="failed" data-testid="filter-failed"><b id="stat-failed" data-testid="stat-failed">0</b> failed</button>
    <button type="button" class="chip" data-filter="" id="chip-all" data-testid="filter-all">all</button>
    <span id="stat-mode" data-testid="run-mode">stopped</span>
  </span>
</div>
<div class="event" id="live-event" data-testid="run-event"></div>

<script>
(() => {
  const POLL_MS = 1500;
  const FRAUD_RATE = 0.35;

  const $ = (id) => document.getElementById(id);
  const buttons = { once: $('run-once'), start: $('run-start'), stop: $('run-stop') };
  const event = $('live-event');
  const chips = [...document.querySelectorAll('.chip')];

  // A continuous run mixes fraud into a minority of attempts, which is what
  // makes the Blocked column climb alongside Earned rather than instead of it.
  // A single click has no population to average over, so with fraud ticked it
  // sends a tampered assertion every time; otherwise someone presses the
  // button, watches a normal purchase settle, and concludes the option does
  // nothing.
  const controls = (path) => ({
    concurrency: Number($('concurrency').value) || 6,
    fraud_rate: $('fraud').checked ? (path.endsWith('/once') ? 1 : FRAUD_RATE) : 0,
  });

  const post = async (path) => {
    buttons.once.disabled = true;
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(controls(path)),
      });
      const body = await response.json();
      if (!response.ok) {
        event.textContent = body.error || `request failed with ${response.status}`;
        return null;
      }
      render(body);
      await pollTotals();
      // A single run leaves rows behind that the next poll would otherwise
      // take up to POLL_MS to show. Each page registers its own refresh,
      // because the index and the detail view read different endpoints.
      await window.agenticRefresh?.();
      return body;
    } catch (error) {
      event.textContent = String(error);
      return null;
    } finally {
      buttons.once.disabled = false;
    }
  };

  const render = (s) => {
    if (!s || typeof s.started !== 'number') { return; }
    buttons.stop.disabled = !s.running;
    buttons.start.disabled = !!s.running;
    // Written per node rather than by rebuilding the row, so pressing a chip
    // does not lose its focus to the next poll a fraction of a second later.
    $('stat-mode').textContent = s.running
      ? `${s.concurrency} agents running · ${s.settled} settled this run`
      : 'stopped';
    if (s.lastEvent) { event.textContent = s.lastEvent; }
  };

  // The counters describe the run; the chips filter the table to the
  // publishers each counter is about. Pressing an active chip clears it, so
  // the same control both narrows and restores.
  let activeFilter = '';

  const applyFilter = (next) => {
    activeFilter = next === activeFilter ? '' : next;
    chips.forEach((chip) => {
      chip.classList.toggle('on', chip.dataset.filter === activeFilter && activeFilter !== '');
    });
    window.agenticSetFilter?.(activeFilter);
  };

  chips.forEach((chip) => chip.addEventListener('click', () => applyFilter(chip.dataset.filter)));

  buttons.once.addEventListener('click', () => post('/api/driver/once'));
  buttons.start.addEventListener('click', () => post('/api/driver/start'));
  buttons.stop.addEventListener('click', () => post('/api/driver/stop'));

  // Changing the rate mid-run has to reach the driver, otherwise ticking the
  // box while agents run appears to do nothing.
  $('fraud').addEventListener('change', () => {
    if (!buttons.stop.disabled) { post('/api/driver/start'); }
  });

  const pollStatus = async () => {
    try {
      render(await (await fetch('/api/driver/status')).json());
    } catch {
      // The driver restarting mid-poll is not worth a visible error.
    }
  };

  // The chips count what the table holds, not what this run happened to do.
  // Sourcing them from the driver made the two disagree the moment a run ended
  // or a page was opened fresh, and a filter whose count contradicts the rows
  // it reveals reads as a broken page rather than as two different measures.
  const pollTotals = async () => {
    let publishers;
    try {
      publishers = (await (await fetch('/api/publishers')).json()).publishers;
    } catch {
      return;
    }
    if (!Array.isArray(publishers)) { return; }

    const total = (field) => publishers.reduce((sum, p) => sum + (p[field] ?? 0), 0);

    $('stat-settled').textContent = total('settlement_count');
    $('stat-blocked').textContent = total('blocked_count');
    $('stat-failed').textContent = total('failed_count');
  };

  setInterval(pollStatus, POLL_MS);
  setInterval(pollTotals, POLL_MS);
  setInterval(() => window.agenticRefresh?.(), POLL_MS);
  pollStatus();
  pollTotals();
})();
</script>
