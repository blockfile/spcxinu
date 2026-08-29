'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parsePairs, EMPTY } = require('./marketdata');

const TOKEN = '0xabc0000000000000000000000000000000000001';

const pair = (over = {}) => ({
  chainId: 'robinhood',
  baseToken: { address: TOKEN },
  marketCap: 4_206_900,
  priceUsd: '0.0042',
  liquidity: { usd: 120_000 },
  url: 'https://dexscreener.com/robinhood/x',
  ...over,
});

test('picks the deepest-liquidity pair on our chain', () => {
  const data = {
    pairs: [
      pair({ marketCap: 100, liquidity: { usd: 10 } }),
      pair({ marketCap: 4_206_900, liquidity: { usd: 999_999 } }),
    ],
  };
  assert.strictEqual(parsePairs(data, TOKEN, 'robinhood').marketCap, 4_206_900);
});

test('ignores pairs on other chains and pairs where we are the quote side', () => {
  const data = {
    pairs: [
      pair({ chainId: 'base' }),
      pair({ baseToken: { address: '0xdead000000000000000000000000000000000000' } }),
    ],
  };
  assert.deepStrictEqual(parsePairs(data, TOKEN, 'robinhood'), EMPTY);
});

test('falls back to fdv when marketCap is absent', () => {
  const data = { pairs: [pair({ marketCap: null, fdv: 777 })] };
  assert.strictEqual(parsePairs(data, TOKEN, 'robinhood').marketCap, 777);
});

test('an unlisted token (no pairs) yields nulls, not zeros', () => {
  assert.deepStrictEqual(parsePairs({ pairs: [] }, TOKEN, 'robinhood'), EMPTY);
  assert.deepStrictEqual(parsePairs({}, TOKEN, 'robinhood'), EMPTY);
});
