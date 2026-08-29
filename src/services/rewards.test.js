'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseDistributor, EMPTY } = require('./rewards');

// Shape returned by GET {ponsApi}/api/pons-v2-market/{token}/distributor
const payload = (over = {}) => ({
  state: 'active',
  distributor: '0x5AA38e88d15677781b00821fdBc2Cdbb3409Aeb2',
  unallocatedQuote: '0',
  unallocatedCoin: '0',
  epochCount: 0,
  distributedQuote: '0',
  distributedCoin: '0',
  latestEpoch: null,
  ...over,
});

test('scales the distributedQuote wei string by the given decimals', () => {
  const out = parseDistributor(payload({ distributedQuote: '5000000000000000000' }), 18);
  assert.strictEqual(out.totalRewarded, 5);
});

test('honors non-18 decimals', () => {
  const out = parseDistributor(payload({ distributedQuote: '826700' }), 0);
  assert.strictEqual(out.totalRewarded, 826_700);
});

test('a real zero paid out is 0, not null', () => {
  const out = parseDistributor(payload({ distributedQuote: '0' }), 18);
  assert.strictEqual(out.totalRewarded, 0);
});

test('passes the distributor address through, lowercased', () => {
  const out = parseDistributor(payload(), 18);
  assert.strictEqual(out.distributor, '0x5aa38e88d15677781b00821fdbc2cdbb3409aeb2');
});

test('a token with no distributor yields nulls, never zeros', () => {
  assert.deepStrictEqual(parseDistributor({ state: 'none' }, 18), EMPTY);
  assert.deepStrictEqual(parseDistributor(payload({ distributedQuote: null, distributor: null }), 18), EMPTY);
});

test('a malformed response throws so the cache keeps the last good value', () => {
  assert.throws(() => parseDistributor(null, 18), /malformed/);
  assert.throws(() => parseDistributor('nope', 18), /malformed/);
  assert.throws(() => parseDistributor(payload({ distributedQuote: 'not-a-number' }), 18), /malformed/);
});
