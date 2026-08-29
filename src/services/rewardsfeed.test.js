'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCursor, encodeCursor, pageFeed, feedUrl, EMPTY_PAGE } = require('./rewardsfeed');

const DIST = '0x5aa38e88d15677781b00821fdbc2cdbb3409aeb2';
const TX = '0xeb614f31452376e18e94770dd698e2fcf166b780401132a0e03afd85e96ecc93';

// One Blockscout token-transfer item, as returned by
// GET /api/v2/addresses/{distributor}/token-transfers?type=ERC-20&filter=from&token=…
const item = (over = {}) => ({
  transaction_hash: TX,
  timestamp: '2026-08-27T17:05:22.000000Z',
  block_number: 47607407,
  log_index: 60,
  type: 'token_transfer',
  method: '0x16b2290f',
  from: { hash: DIST },
  to: { hash: '0xfF335B2C27f66910E67808382dE6A1fd2389321d' },
  token: { address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', symbol: 'SPCX', decimals: '18' },
  total: { decimals: '18', value: '311868936472759' },
  ...over,
});

// n items in Blockscout's order (newest first), distinct (block, log_index).
const items = (n) => Array.from({ length: n }, (_, i) => item({ block_number: 100 - Math.floor(i / 3), log_index: 90 - (i % 3) * 3 }));

// ── cursor ───────────────────────────────────────────────────────────────────

test('an absent cursor means "from the top"', () => {
  assert.strictEqual(parseCursor(undefined), null);
  assert.strictEqual(parseCursor(null), null);
  assert.strictEqual(parseCursor(''), null);
});

test('a cursor is the Blockscout (block_number, log_index) pair of the last row served', () => {
  assert.deepStrictEqual(parseCursor('47607407-27'), { blockNumber: 47607407, index: 27 });
  assert.strictEqual(encodeCursor(item({ block_number: 47607407, log_index: 27 })), '47607407-27');
});

test('a malformed cursor is a 400, not an upstream call', () => {
  for (const bad of ['abc', '1-', '-1', '1-2-3', '1:2', ' 1-2', '1-2 ', 12, ['1-2']]) {
    assert.throws(() => parseCursor(bad), (err) => /cursor/.test(err.message) && err.status === 400, String(bad));
  }
});

// ── row mapping ──────────────────────────────────────────────────────────────

test('maps a transfer onto the row the site renders', () => {
  const { rows } = pageFeed({ items: [item()], next_page_params: null }, 12, 18);
  assert.deepStrictEqual(rows, [
    {
      id: `${TX}-60`,
      amount: 311868936472759 / 1e18,
      wallet: '0xfF335B2C27f66910E67808382dE6A1fd2389321d',
      txHash: TX,
      at: Date.parse('2026-08-27T17:05:22.000Z'),
    },
  ]);
});

test('scales by the transfer\'s own decimals, then the token\'s, then the configured fallback', () => {
  const at = (it) => pageFeed({ items: [it], next_page_params: null }, 12, 6).rows[0].amount;
  assert.strictEqual(at(item({ total: { decimals: '2', value: '150' } })), 1.5);
  assert.strictEqual(at(item({ total: { value: '150' }, token: { decimals: '1' } })), 15);
  assert.strictEqual(at(item({ total: { value: '1500000' }, token: {} })), 1.5);
});

test('the id is tx hash + log index — one payout tx pays many wallets', () => {
  const { rows } = pageFeed({ items: [item({ log_index: 60 }), item({ log_index: 57 })], next_page_params: null }, 12, 18);
  assert.notStrictEqual(rows[0].id, rows[1].id);
});

test('a transfer missing its essentials is skipped rather than poisoning the page', () => {
  const data = {
    items: [item({ to: null }), item({ total: { value: 'x' } }), item({ transaction_hash: undefined }), item()],
    next_page_params: null,
  };
  assert.strictEqual(pageFeed(data, 12, 18).rows.length, 1);
});

test('an unparseable timestamp is null, not NaN', () => {
  const { rows } = pageFeed({ items: [item({ timestamp: 'soon' })], next_page_params: null }, 12, 18);
  assert.strictEqual(rows[0].at, null);
});

// ── paging ───────────────────────────────────────────────────────────────────

test('serves `limit` rows and points the cursor at the last one when Blockscout had more', () => {
  const all = items(50);
  const { rows, nextCursor } = pageFeed({ items: all, next_page_params: null }, 12, 18);
  assert.strictEqual(rows.length, 12);
  assert.strictEqual(nextCursor, encodeCursor(all[11]));
});

test('exactly `limit` rows with no further Blockscout page is the end of the feed', () => {
  const { rows, nextCursor } = pageFeed({ items: items(12), next_page_params: null }, 12, 18);
  assert.strictEqual(rows.length, 12);
  assert.strictEqual(nextCursor, null);
});

test('fewer than `limit` rows but a further Blockscout page continues from the last row', () => {
  const all = items(50);
  const npp = { block_number: all[49].block_number, index: all[49].log_index, filter: 'from' };
  const { rows, nextCursor } = pageFeed({ items: all, next_page_params: npp }, 50, 18);
  assert.strictEqual(rows.length, 50);
  assert.strictEqual(nextCursor, encodeCursor(all[49]));
});

test('no transfers yet is an empty page, not an error', () => {
  assert.deepStrictEqual(pageFeed({ items: [], next_page_params: null }, 12, 18), EMPTY_PAGE);
});

test('a malformed response throws so the cache keeps the last good page', () => {
  assert.throws(() => pageFeed(null, 12, 18), /malformed/);
  assert.throws(() => pageFeed('nope', 12, 18), /malformed/);
  assert.throws(() => pageFeed({ message: 'Not found' }, 12, 18), /malformed/);
});

// ── url ──────────────────────────────────────────────────────────────────────

test('asks Blockscout for reward-token transfers OUT of the distributor, after the cursor', () => {
  const base = 'https://robinhoodchain.blockscout.com';
  const token = '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea';
  const top = new URL(feedUrl(base, DIST, token, null));
  assert.strictEqual(top.pathname, `/api/v2/addresses/${DIST}/token-transfers`);
  assert.strictEqual(top.searchParams.get('type'), 'ERC-20');
  assert.strictEqual(top.searchParams.get('filter'), 'from');
  assert.strictEqual(top.searchParams.get('token'), token);
  assert.strictEqual(top.searchParams.has('block_number'), false);

  const next = new URL(feedUrl(base, DIST, token, { blockNumber: 47607407, index: 27 }));
  assert.strictEqual(next.searchParams.get('block_number'), '47607407');
  assert.strictEqual(next.searchParams.get('index'), '27');
});
