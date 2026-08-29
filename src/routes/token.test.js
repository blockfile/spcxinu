'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildToken } = require('./token');

test('ticker carries the "$" the site displays; symbol does not', () => {
  const out = buildToken({ name: 'Space Inu', symbol: 'SPACEINU', tokenAddress: '0xabc' });
  assert.strictEqual(out.ticker, '$SPACEINU');
  assert.strictEqual(out.symbol, 'SPACEINU');
  assert.strictEqual(out.name, 'Space Inu');
  assert.strictEqual(out.contractAddress, '0xabc');
  assert.strictEqual(out.chain, 'Robinhood Chain');
});

test('pre-launch the contract address is null, not an empty string', () => {
  assert.strictEqual(buildToken({ name: 'Space Inu', symbol: 'SPACEINU', tokenAddress: null }).contractAddress, null);
});
