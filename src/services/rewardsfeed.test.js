'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { parseCursor, toRow, txUrlFor } = require('./rewardsfeed');

test('an absent cursor means "start at the newest"', () => {
  assert.strictEqual(parseCursor(undefined), null);
  assert.strictEqual(parseCursor(null), null);
  assert.strictEqual(parseCursor(''), null);
});

test('a numeric cursor is accepted', () => {
  assert.strictEqual(parseCursor('42'), 42);
  assert.strictEqual(parseCursor('0'), 0);
});

test('a malformed cursor is a 400, not a crash', () => {
  assert.throws(() => parseCursor('not-a-number'), (err) => err.status === 400);
  // The old Blockscout "<block>-<logIndex>" form is no longer valid.
  assert.throws(() => parseCursor('47607407-27'), (err) => err.status === 400);
  assert.throws(() => parseCursor(['1']), (err) => err.status === 400);
  assert.throws(() => parseCursor({}), (err) => err.status === 400);
  assert.throws(() => parseCursor('-5'), (err) => err.status === 400);
});

test('an airdrop row becomes the shape the site renders', () => {
  const row = toRow({
    id: 7,
    recipient: '0xholder',
    amount_ui: 1.25,
    signature: `0x${'b'.repeat(64)}`,
    created_at: '2026-08-30T12:00:00.000Z',
  });
  assert.deepStrictEqual(row, {
    id: '7',
    wallet: '0xholder',
    amount: 1.25,
    txHash: `0x${'b'.repeat(64)}`,
    txUrl: `https://rh-scan.com/tx/0x${'b'.repeat(64)}`,
    at: Date.parse('2026-08-30T12:00:00.000Z'),
  });
});

test('a row with no amount reads as 0, never null — the site formats it', () => {
  const row = toRow({ id: 1, recipient: '0xa', amount_ui: null, signature: '0xc', created_at: '2026-08-30T00:00:00Z' });
  assert.strictEqual(row.amount, 0);
});

test('an unparseable timestamp is null, not NaN', () => {
  const row = toRow({ id: 1, recipient: '0xa', amount_ui: 1, signature: '0xc', created_at: 'not a date' });
  assert.strictEqual(row.at, null);
});

// ── explorer links ─────────────────────────────────────────────────────────

test('every payout row carries a link to THIS chain\'s explorer', () => {
  // The site only builds its own URL when the API omits txUrl, and its fallback
  // points at etherscan.io — the wrong chain entirely for these transactions.
  const hash = `0x${'a'.repeat(64)}`;
  const row = toRow(
    { id: 7, recipient: '0xabc', amount_ui: 1, signature: hash, created_at: '2026-08-30T14:29:24Z' },
    'https://rh-scan.com/tx/'
  );
  assert.strictEqual(row.txUrl, `https://rh-scan.com/tx/${hash}`);
});

test('a row with no hash gets no link rather than a broken one', () => {
  assert.strictEqual(txUrlFor(null, 'https://rh-scan.com/tx/'), null);
  assert.strictEqual(txUrlFor('0xabc', ''), null);
});

test('the configured base is normalised to exactly one trailing slash', () => {
  const config = require('./../config');
  assert.match(config.explorerTxBase, /\/$/);
  assert.doesNotMatch(config.explorerTxBase, /\/\/$/);
});
