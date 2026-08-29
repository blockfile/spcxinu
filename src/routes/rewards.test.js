'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseQuery, presentPage, DEFAULT_LIMIT, MAX_LIMIT } = require('./rewards');

test('with no query string, serves a full Blockscout page from the top of the feed', () => {
  assert.deepStrictEqual(parseQuery({}), { cursor: null, limit: DEFAULT_LIMIT });
  assert.strictEqual(DEFAULT_LIMIT, 50); // the site polls /rewards bare and shows the whole list
});

test('clamps limit into 1..MAX and ignores junk', () => {
  assert.strictEqual(parseQuery({ limit: '0' }).limit, 1);
  assert.strictEqual(parseQuery({ limit: '-5' }).limit, 1);
  assert.strictEqual(parseQuery({ limit: '999' }).limit, MAX_LIMIT);
  assert.strictEqual(parseQuery({ limit: '7.9' }).limit, 7);
  assert.strictEqual(parseQuery({ limit: 'abc' }).limit, DEFAULT_LIMIT);
  assert.strictEqual(parseQuery({ limit: ['5', '6'] }).limit, DEFAULT_LIMIT);
});

test('passes a well-formed cursor through untouched', () => {
  assert.strictEqual(parseQuery({ cursor: '4760' }).cursor, '4760');
  assert.strictEqual(parseQuery({ cursor: '' }).cursor, null);
});

test('rejects a malformed cursor with a 400', () => {
  assert.throws(() => parseQuery({ cursor: 'nope' }), (err) => err.status === 400);
  assert.throws(() => parseQuery({ cursor: ['12'] }), (err) => err.status === 400);
  assert.throws(() => parseQuery({ cursor: '47607407-27' }), (err) => err.status === 400); // the old Blockscout form
});

test('presents the page as the site\'s `transactions` (ISO timestamp) and as `rows` (epoch ms)', () => {
  const row = { id: '0xabc-60', amount: 0.00031, wallet: '0xfF33', txHash: '0xabc', at: Date.UTC(2026, 7, 27, 17, 5, 22) };
  const out = presentPage({ rows: [row], nextCursor: '47607407-27' });
  assert.deepStrictEqual(out.transactions, [
    { id: '0xabc-60', wallet: '0xfF33', amount: 0.00031, txHash: '0xabc', timestamp: '2026-08-27T17:05:22.000Z' },
  ]);
  assert.deepStrictEqual(out.rows, [row]);
  assert.strictEqual(out.nextCursor, '47607407-27');
});

test('a row with no timestamp presents null, not an Invalid Date', () => {
  const out = presentPage({ rows: [{ id: 'x', amount: 1, wallet: 'w', txHash: 't', at: null }], nextCursor: null });
  assert.strictEqual(out.transactions[0].timestamp, null);
});

test('an empty feed presents empty lists', () => {
  assert.deepStrictEqual(presentPage({ rows: [], nextCursor: null }), { transactions: [], rows: [], nextCursor: null });
});
