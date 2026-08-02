import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

import { Agent, AgentError, type Fulfillment, type Selection } from './agent.js';

const DEFAULT_GATEWAY = 'http://localhost:8080';
const DEFAULT_QUERY = 'trail running shoes';
const DEFAULT_PUBLISHER = 'pub_000001';

function envOr(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function reportChain(selection: Selection, fulfillment: Fulfillment): void {
  console.log('\nAttribution chain');
  line('search request', selection.assertion.search_request_id);
  line('assertion', selection.assertion.assertion_id);
  line('product', `${selection.product.canonical_title} (${fulfillment.product_id})`);
  line('merchant', selection.offer.merchant_id);
  line('paid', money(fulfillment.amount_cents));
  line('settlement', fulfillment.settlement_id);
  line('transaction', fulfillment.tx_hash);
  line('attributed publisher', fulfillment.attributed_publisher_id);
  line('publisher commission', money(fulfillment.publisher_commission_cents));
}

// A private key generated per run unless one is supplied. Nothing in the
// default path holds funds, and a key that lived in the repository would be a
// key someone eventually funded by accident.
const privateKey = envOr('AGENT_PRIVATE_KEY', generatePrivateKey());
const account = privateKeyToAccount(privateKey as `0x${string}`);

const agent = new Agent({ gatewayUrl: envOr('GATEWAY_URL', DEFAULT_GATEWAY), account });

const query = process.argv[2] ?? envOr('DEMO_QUERY', DEFAULT_QUERY);
const publisherId = envOr('DEMO_PUBLISHER_ID', DEFAULT_PUBLISHER);

console.log(`Agent ${account.address}`);
console.log(`Searching "${query}" as publisher ${publisherId}`);

const { selection, fulfillment } = await agent.purchase(query, publisherId);
reportChain(selection, fulfillment);

// Replaying the same assertion is the point of the exercise, not an afterthought.
// A single-use guarantee nobody exercises is a claim rather than a property.
console.log('\nReplaying the same assertion, which must fail');

try {
  const requirements = await agent.requestChallenge(selection.product.product_id);
  const payment = await agent.signAuthorization(requirements);

  await agent.completePurchase(selection.product.product_id, selection.assertion, payment);

  console.error('  FAILED: the replay succeeded, so single-use enforcement is broken');
  process.exit(1);
} catch (error) {
  if (error instanceof AgentError && error.status === 409) {
    const body = error.body as { reason?: string };
    line('rejected with', `${error.status} ${body.reason ?? ''}`);
    console.log('\nDone.');
  } else {
    console.error('  FAILED: the replay was rejected for the wrong reason');
    console.error(error);
    process.exit(1);
  }
}
