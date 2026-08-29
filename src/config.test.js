'use strict';

const test = require('node:test');
const assert = require('node:assert');

// config reads process.env at require time, so each case re-requires it.
function loadConfig(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('the split is REWARD_PCT with the remainder as the dev cut', () => {
  const config = loadConfig({ REWARD_PCT: '80', DRY_RUN: 'true' });
  assert.strictEqual(config.rewardPct, 80);
  assert.strictEqual(config.devPct, 20);
});

test('a fractional split leaves no floating-point dust in the dev cut', () => {
  const config = loadConfig({ REWARD_PCT: '80.1', DRY_RUN: 'true' });
  assert.strictEqual(config.devPct, 19.9); // not 19.900000000000006
});

test('an out-of-range split is rejected outright', () => {
  assert.throws(() => loadConfig({ REWARD_PCT: '140', DRY_RUN: 'true' }), /REWARD_PCT/);
});

test('the trigger defaults to a 100 USD accumulation gate', () => {
  const config = loadConfig({ REWARD_PCT: '80', DRY_RUN: 'true' });
  assert.strictEqual(config.triggerMode, 'accumulation');
  assert.strictEqual(config.claimEveryUsd, 100);
});

test('an unknown TRIGGER_MODE falls back to accumulation rather than throwing', () => {
  const config = loadConfig({ TRIGGER_MODE: 'nonsense', DRY_RUN: 'true' });
  assert.strictEqual(config.triggerMode, 'accumulation');
});

test('DRY_RUN generates an ephemeral wallet when no key is set', () => {
  process.env.WALLET_PRIVATE_KEY = '';
  const config = loadConfig({ DRY_RUN: 'true' });
  assert.ok(config.wallet);
  assert.strictEqual(config.walletIsEphemeral, true);
});

test('a live run with no key is refused', () => {
  process.env.WALLET_PRIVATE_KEY = '';
  assert.throws(() => loadConfig({ DRY_RUN: 'false' }), /WALLET_PRIVATE_KEY/);
  process.env.DRY_RUN = 'true';
});
