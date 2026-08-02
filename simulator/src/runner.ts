// Drives many agents against the running system at once, so the dashboard has
// something live to show.
//
// Every run goes through the real path: the edge gateway, the search service,
// a genuine 402 challenge, an EIP-3009 signature, the facilitator, and a
// settlement that writes ledger rows. Nothing here fabricates a number the
// dashboard then displays. A simulated counter would be quicker to build and
// would prove nothing.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { Agent, AgentError, selectCheapestInStock } from './agent.js';
import { applyFraud, pickFraudMode, EXPECTED_REJECTION, type FraudMode } from './fraud.js';

export interface RunnerOptions {
  gatewayUrl: string;
  publisherIds: string[];
  queries: string[];
  concurrency: number;
  // Share of attempts that carry a deliberately invalid assertion, 0 to 1.
  fraudRate: number;
  // Pause between one agent finishing and starting again, which keeps a laptop
  // responsive and makes the dashboard readable as it updates.
  pauseMs: number;
}

export interface RunnerStats {
  running: boolean;
  started: number;
  settled: number;
  blocked: number;
  failed: number;
  concurrency: number;
  fraudRate: number;
  lastEvent: string;
  byReason: Record<string, number>;
}

const DEFAULT_PAUSE_MS = 400;

export class Runner {
  readonly #options: RunnerOptions;
  #running = false;
  #active = 0;
  #stats: RunnerStats;

  constructor(options: Partial<RunnerOptions> & { gatewayUrl: string }) {
    this.#options = {
      gatewayUrl: options.gatewayUrl,
      publisherIds: options.publisherIds ?? [],
      queries: options.queries ?? [],
      concurrency: options.concurrency ?? 4,
      fraudRate: options.fraudRate ?? 0,
      pauseMs: options.pauseMs ?? DEFAULT_PAUSE_MS,
    };

    this.#stats = this.#emptyStats();
  }

  #emptyStats(): RunnerStats {
    return {
      running: false,
      started: 0,
      settled: 0,
      blocked: 0,
      failed: 0,
      concurrency: this.#options.concurrency,
      fraudRate: this.#options.fraudRate,
      lastEvent: 'idle',
      byReason: {},
    };
  }

  get stats(): RunnerStats {
    return { ...this.#stats, running: this.#running, byReason: { ...this.#stats.byReason } };
  }

  // Filled in at runtime from whatever the catalog holds, because a list baked
  // in here would drift out of step with whatever got seeded.
  setPublishers(ids: string[]): void {
    this.#options.publisherIds = ids;
  }

  // Concurrency and fraud rate change while running, so an operator can turn
  // fraud on mid-demonstration and watch the blocked column move without
  // losing the settlements already on screen.
  configure(patch: { concurrency?: number; fraudRate?: number }): void {
    if (patch.concurrency !== undefined) {
      this.#options.concurrency = clamp(patch.concurrency, 1, 32);
      this.#stats.concurrency = this.#options.concurrency;
    }
    if (patch.fraudRate !== undefined) {
      this.#options.fraudRate = clamp(patch.fraudRate, 0, 1);
      this.#stats.fraudRate = this.#options.fraudRate;
    }
  }

  start(patch: { concurrency?: number; fraudRate?: number } = {}): void {
    this.configure(patch);
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#stats.lastEvent = 'started';

    for (let i = 0; i < this.#options.concurrency; i += 1) {
      void this.#loop();
    }
  }

  stop(): void {
    this.#running = false;
    this.#stats.lastEvent = 'stopped';
  }

  // Resolves once every in-flight agent has finished its current attempt, so a
  // test can stop the runner without leaving requests racing its assertions.
  async drain(): Promise<void> {
    this.stop();
    while (this.#active > 0) {
      await sleep(10);
    }
  }

  async #loop(): Promise<void> {
    this.#active += 1;
    try {
      while (this.#running) {
        await this.runOnce();
        // Re-checked after the attempt because stop() can land mid-flight.
        if (!this.#running) {
          break;
        }
        await sleep(this.#options.pauseMs);
      }
    } finally {
      this.#active -= 1;
    }
  }

  /**
   * One agent's full journey. Public so the dashboard can fire a single
   * transaction without starting a continuous run, which is the cheapest way
   * for someone to see what one purchase looks like.
   */
  async runOnce(): Promise<void> {
    const publisherId = pick(this.#options.publisherIds);
    const query = pick(this.#options.queries);

    if (!publisherId || !query) {
      this.#stats.failed += 1;
      this.#stats.lastEvent = 'no publishers or queries configured';
      return;
    }

    const fraudMode = Math.random() < this.#options.fraudRate ? pickFraudMode() : null;

    this.#stats.started += 1;

    const agent = new Agent({
      gatewayUrl: this.#options.gatewayUrl,
      account: privateKeyToAccount(generatePrivateKey()),
    });

    try {
      const results = await agent.search(query, publisherId);
      const selection = selectCheapestInStock(results);
      if (!selection) {
        this.#stats.failed += 1;
        this.#stats.lastEvent = `no purchasable offer for "${query}"`;
        return;
      }

      const requirements = await agent.requestChallenge(selection.product.product_id);
      const payment = await agent.signAuthorization(requirements);
      const assertion = fraudMode ? applyFraud(selection.assertion, fraudMode) : selection.assertion;

      const fulfillment = await agent.completePurchase(
        selection.product.product_id,
        assertion,
        payment,
      );

      if (fraudMode) {
        // The platform accepted an assertion it should have refused, which is
        // the one outcome that makes the whole demonstration wrong.
        this.#stats.failed += 1;
        this.#record(`accepted_fraud_${fraudMode}`);
        this.#stats.lastEvent = `SECURITY: ${fraudMode} settled as ${fulfillment.settlement_id}`;
        return;
      }

      this.#stats.settled += 1;
      this.#stats.lastEvent =
        `${publisherId} earned ${cents(fulfillment.publisher_commission_cents)}` +
        ` on ${cents(fulfillment.amount_cents)}`;
    } catch (error) {
      this.#handleFailure(error, fraudMode, publisherId);
    }
  }

  #handleFailure(error: unknown, fraudMode: FraudMode | null, publisherId: string): void {
    const reason = error instanceof AgentError ? reasonOf(error) : 'transport_error';

    if (fraudMode) {
      const expected = EXPECTED_REJECTION[fraudMode];
      this.#stats.blocked += 1;
      this.#record(reason);
      this.#stats.lastEvent =
        reason === expected
          ? `blocked ${fraudMode} on ${publisherId} (${reason})`
          : `blocked ${fraudMode} on ${publisherId}, expected ${expected} got ${reason}`;
      return;
    }

    this.#stats.failed += 1;
    this.#record(reason);
    this.#stats.lastEvent = `failed ${publisherId}: ${reason}`;
  }

  #record(reason: string): void {
    this.#stats.byReason[reason] = (this.#stats.byReason[reason] ?? 0) + 1;
  }
}

// A blank reason has to fall back the same way a missing one does, otherwise
// the counters grow a key with no name and the dashboard shows a tally nobody
// can act on.
function reasonOf(error: AgentError): string {
  const body = error.body as { reason?: string } | undefined;
  const reason = body?.reason?.trim();

  return reason ? reason : `http_${error.status}`;
}

// Exported so a test can drive the selection rather than hope a random draw
// covers both ends. Indexing past the end already yields undefined, so an
// empty list needs no guard of its own.
export function pick<T>(items: T[], random: () => number = Math.random): T | undefined {
  return items[Math.floor(random() * items.length)];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function cents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
