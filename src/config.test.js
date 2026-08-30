'use strict';

const test = require('node:test');
const assert = require('node:assert');

// config reads process.env at require time, so each case re-requires it.
//
// The keys below are CLEARED before each case rather than merely overridden.
// Without that, a case asserting a rejected value leaves that value in the
// environment and every later case inherits it — which showed up as three
// unrelated tests failing after a split-validation test was added.
const OWNED = ['REWARD_PCT', 'BURN_PCT', 'TRIGGER_MODE', 'CLAIM_EVERY_USD', 'DEV_PAYOUT_ADDRESS'];

function loadConfig(env = {}) {
  for (const k of OWNED) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('the default 80/20 split leaves no dev cut at all', () => {
  const config = loadConfig({ REWARD_PCT: '80', BURN_PCT: '20', DRY_RUN: 'true' });
  assert.strictEqual(config.rewardPct, 80);
  assert.strictEqual(config.burnPct, 20);
  assert.strictEqual(config.devPct, 0);
});

test('the dev cut is whatever the other two legs leave behind', () => {
  const config = loadConfig({ REWARD_PCT: '70', BURN_PCT: '20', DRY_RUN: 'true' });
  assert.strictEqual(config.devPct, 10);
});

test('a fractional split leaves no floating-point dust in the dev cut', () => {
  const config = loadConfig({ REWARD_PCT: '80.1', BURN_PCT: '0', DRY_RUN: 'true' });
  assert.strictEqual(config.devPct, 19.9); // not 19.900000000000006
});

test('an out-of-range split is rejected outright', () => {
  assert.throws(() => loadConfig({ REWARD_PCT: '140', BURN_PCT: '0', DRY_RUN: 'true' }), /REWARD_PCT/);
  assert.throws(() => loadConfig({ REWARD_PCT: '10', BURN_PCT: '140', DRY_RUN: 'true' }), /BURN_PCT/);
});

test('legs that together exceed the claim are refused', () => {
  // Otherwise the bot would try to spend 110% of what it claimed and the third
  // leg would silently go negative.
  assert.throws(
    () => loadConfig({ REWARD_PCT: '80', BURN_PCT: '30', DRY_RUN: 'true' }),
    /exceeds 100/
  );
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
