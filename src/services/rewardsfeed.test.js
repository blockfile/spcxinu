'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { parseCursor, toRow } = require('./rewardsfeed');

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
