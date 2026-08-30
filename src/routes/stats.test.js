'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildStats, supplyFallback, withSupplyFallback } = require('./stats');

const build = (market, token, rewards = {}, curve = {}, quote = {}, supply = null) =>
  buildStats({ market, token, rewards, curve, quote, symbol: 'SPACEINU', tokenAddress: '0xabc', supply });

// Blockscout-shaped supply: 1B tokens at 18 decimals.
const SUPPLY = { totalSupply: '1000000000000000000000000000', decimals: 18 };

// ── supply fallback (Blockscout unreachable) ────────────────────────────────

test('supplyFallback turns the configured whole-token supply into the explorer\'s wei shape', () => {
  assert.deepStrictEqual(supplyFallback({ tokenTotalSupply: 1_000_000_000, tokenDecimals: 18 }), SUPPLY);
  assert.deepStrictEqual(supplyFallback({ tokenTotalSupply: 5, tokenDecimals: 0 }), { totalSupply: '5', decimals: 0 });
});

test('supplyFallback is null when not configured or nonsense', () => {
  assert.strictEqual(supplyFallback({ tokenTotalSupply: null, tokenDecimals: 18 }), null);
  assert.strictEqual(supplyFallback({ tokenTotalSupply: 0, tokenDecimals: 18 }), null);
  assert.strictEqual(supplyFallback({ tokenTotalSupply: NaN, tokenDecimals: 18 }), null);
});

test('with Blockscout down, the curve market cap is computed from the configured supply', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 0.00001 }, {}, SUPPLY).marketCap, 10_000);
  assert.strictEqual(build({}, {}, {}, { priceUsd: 0.00001 }).marketCap, null); // no fallback configured
});

test('explorer supply wins over the configured fallback', () => {
  const explorer = { totalSupply: '2000000000000000000000000000', decimals: 18 }; // 2B
  assert.deepStrictEqual(withSupplyFallback(explorer, SUPPLY), explorer);
  assert.strictEqual(build({}, explorer, {}, { priceUsd: 0.00001 }, {}, SUPPLY).marketCap, 20_000);
});

test('the fallback fills only the missing halves and leaves holders alone', () => {
  const out = withSupplyFallback({ holders: 7, totalSupply: null, decimals: null }, SUPPLY);
  assert.deepStrictEqual(out, { holders: 7, ...SUPPLY });
});

test('returns the fields the site\'s BOOT window reads', () => {
  const out = build({ marketCap: 4_206_900 }, { holders: 6942 }, { totalRewarded: 826.7 }, {}, { priceUsd: 259.4 });
  assert.strictEqual(out.marketCap, 4_206_900);
  assert.strictEqual(out.ketDistributed, 826.7); // "Total $SPCX Distributed" — token amount, no "$"
  assert.strictEqual(out.totalHolders, 6942);
  // aliases for the other frontend templates
  assert.strictEqual(out.holders, 6942);
  assert.strictEqual(out.totalRewarded, 826.7);
  assert.strictEqual(out.spcxRewarded, 826.7 * 259.4);
});

test('ketDistributed and totalHolders are null (never 0) when unsourced, and keep a real 0', () => {
  assert.strictEqual(build({}, {}).ketDistributed, null);
  assert.strictEqual(build({}, {}).totalHolders, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }).ketDistributed, 0);
});

test('`rewarded` is the generic alias of spcxRewarded, null when missing', () => {
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 486.91 });
  assert.strictEqual(out.rewarded, out.spcxRewarded);
  assert.strictEqual(build({}, {}).rewarded, null);
});

test('falls back to the explorer market cap when DexScreener has none', () => {
  const out = build({ marketCap: null }, { circulatingMarketCap: 555 });
  assert.strictEqual(out.marketCap, 555);
});

test('prefers DexScreener over the explorer fallback', () => {
  const out = build({ marketCap: 1 }, { circulatingMarketCap: 999 });
  assert.strictEqual(out.marketCap, 1);
});

test('a dead upstream yields nulls, never zeros', () => {
  const out = build({}, {});
  assert.strictEqual(out.marketCap, null);
  assert.strictEqual(out.holders, null);
  assert.strictEqual(out.spcxRewarded, null);
  assert.strictEqual(out.price, null);
});

test('a real zero market cap is preserved, not treated as missing', () => {
  const out = build({ marketCap: 0 }, { circulatingMarketCap: 999 });
  assert.strictEqual(out.marketCap, 0);
});

test('includes the total SPCX rewarded from the distributor service', () => {
  const out = build({}, {}, { totalRewarded: 826.5 });
  assert.strictEqual(out.totalRewarded, 826.5);
});

test('a dead rewards upstream yields null, and a real zero is preserved', () => {
  assert.strictEqual(build({}, {}).totalRewarded, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }).totalRewarded, 0);
});

test('pre-graduation: priceUsd falls back to the curve price', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1.6929e-5 }).priceUsd, 1.6929e-5);
});

test('a live DexScreener price wins over the curve price', () => {
  assert.strictEqual(build({ priceUsd: 2 }, {}, {}, { priceUsd: 1 }).priceUsd, 2);
});

test('`price` mirrors priceUsd — the name the site\'s normalizer reads', () => {
  assert.strictEqual(build({ priceUsd: 2 }, {}).price, 2);
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1 }).price, 1);
});

test('pre-graduation: market cap is computed from curve price × explorer supply', () => {
  const out = build({}, SUPPLY, {}, { priceUsd: 0.00001 });
  assert.strictEqual(out.marketCap, 10_000); // 1e9 tokens × $0.00001
});

test('curve market cap loses to DexScreener and the explorer figure', () => {
  assert.strictEqual(build({ marketCap: 5 }, SUPPLY, {}, { priceUsd: 1 }).marketCap, 5);
  assert.strictEqual(build({}, { ...SUPPLY, circulatingMarketCap: 7 }, {}, { priceUsd: 1 }).marketCap, 7);
});

test('totalRewardedUsd is the SPCX amount at the SPCX/USD price', () => {
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 259.4 });
  assert.strictEqual(out.totalRewardedUsd, 11 * 259.4);
});

test('`spcxRewarded` — the tile the site formats as dollars — is the USD figure', () => {
  const out = build({}, {}, { totalRewarded: 11 }, {}, { priceUsd: 259.4 });
  assert.strictEqual(out.spcxRewarded, out.totalRewardedUsd);
});

test('totalRewardedUsd needs both legs, and a real zero stays 0', () => {
  assert.strictEqual(build({}, {}, { totalRewarded: 11 }).totalRewardedUsd, null);
  assert.strictEqual(build({}, {}, {}, {}, { priceUsd: 259.4 }).totalRewardedUsd, null);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }, {}, { priceUsd: 259.4 }).totalRewardedUsd, 0);
  assert.strictEqual(build({}, {}, { totalRewarded: 0 }, {}, { priceUsd: 259.4 }).spcxRewarded, 0);
});

test('curve market cap needs both a price and the supply — else null', () => {
  assert.strictEqual(build({}, {}, {}, { priceUsd: 1 }).marketCap, null);
  assert.strictEqual(build({}, { totalSupply: '10', decimals: null }, {}, { priceUsd: 1 }).marketCap, null);
  assert.strictEqual(build({}, SUPPLY, {}, {}).marketCap, null);
});

// ── buyback + burn ─────────────────────────────────────────────────────────

test('exposes the burned total the site renders', () => {
  const out = buildStats({
    market: { priceUsd: 0.00002 },
    token: {},
    burns: { totalBurned: 12345.6, burnQuoteSpent: 2.5, burns: 3 },
    symbol: 'SPACEINU',
  });
  assert.strictEqual(out.totalBurned, 12345.6);
  assert.strictEqual(out.burns, 3);
});

test('what the burns COST is kept separate from what they are worth now', () => {
  // burnQuoteSpent is SPCX actually spent; totalBurnedUsd is today's market
  // value of the destroyed tokens. Conflating them would let the site claim a
  // burn was worth more than was ever spent on it.
  const out = buildStats({
    market: { priceUsd: 2 },
    token: {},
    burns: { totalBurned: 100, burnQuoteSpent: 1.5, burns: 1 },
    symbol: 'SPACEINU',
  });
  assert.strictEqual(out.burnQuoteSpent, 1.5, 'cost, in SPCX');
  assert.strictEqual(out.totalBurnedUsd, 200, 'current value, in USD');
});

test('burn figures are null (never 0) when nothing has been burned yet', () => {
  const out = buildStats({ market: {}, token: {}, symbol: 'SPACEINU' });
  assert.strictEqual(out.totalBurned, null);
  assert.strictEqual(out.totalBurnedUsd, null);
  assert.strictEqual(out.burnedPctOfSupply, null);
});

test('a real zero burn total is preserved, not treated as missing', () => {
  const out = buildStats({
    market: { priceUsd: 2 },
    token: {},
    burns: { totalBurned: 0, burnQuoteSpent: 0, burns: 0 },
    symbol: 'SPACEINU',
  });
  assert.strictEqual(out.totalBurned, 0);
  assert.strictEqual(out.totalBurnedUsd, 0);
});

test('burned share of supply adds back what was destroyed', () => {
  // The explorer reports CIRCULATING supply, which the burn already reduced.
  // 900 remaining + 100 burned = 1000 originally, so 10%.
  const out = buildStats({
    market: {},
    token: { totalSupply: (900n * 10n ** 18n).toString(), decimals: 18 },
    burns: { totalBurned: 100, burnQuoteSpent: 1, burns: 1 },
    symbol: 'SPACEINU',
  });
  assert.ok(Math.abs(out.burnedPctOfSupply - 10) < 1e-9);
});

test('burned share needs the supply — without it, null rather than a wrong number', () => {
  const out = buildStats({
    market: {},
    token: {},
    burns: { totalBurned: 100, burnQuoteSpent: 1, burns: 1 },
    symbol: 'SPACEINU',
  });
  assert.strictEqual(out.burnedPctOfSupply, null);
});
