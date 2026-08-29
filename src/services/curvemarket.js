'use strict';

// Pre-graduation SPACEINU price, computed from the Pons bonding curve.
//
// Until SPACEINU graduates off the Pons V2 bonding curve there is no Uniswap pool,
// so DexScreener has nothing to say about it. But the curve itself trades all
// day, and Pons's chart API (same host as the rewards distributor API) reports
// the curve price denominated in SPCX — while SPCX, the tokenized-SpaceX quote
// asset, IS listed on DexScreener with deep pools. Multiplying the two gives a
// real USD price for SPACEINU today:
//
//   GET {ponsApi}/api/pons-v2-market/{token}/chart?range=1d
//     -> { points: [{ t, price, ... }] }        price = SPCX per SPACEINU
//   GET dexscreener /latest/dex/tokens/{SPCX}   -> SPCX price in USD
//
//   priceUsd = latest curve price × SPCX priceUsd
//
// /stats uses this as a FALLBACK: once the token graduates, the DexScreener
// pair for SPACEINU itself takes over (see routes/stats.js merge order) and this
// service quietly stops mattering. No trades yet or an unlisted quote asset
// degrade to null, never 0; malformed responses throw so the stale-while-error
// cache keeps the last good value.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');
const { getQuotePrice } = require('./quoteprice');

const EMPTY = { priceUsd: null };

/** Pure: latest curve price (SPCX per SPACEINU) out of a Pons chart payload, or null. */
function parseCurvePrice(data) {
  if (!data || typeof data !== 'object') {
    throw new Error(`malformed chart response: ${String(data).slice(0, 80)}`);
  }
  const points = Array.isArray(data.points) ? data.points : [];
  if (points.length === 0) return null; // no trades in the window
  const price = points[points.length - 1].price;
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error(`malformed chart price: ${String(price).slice(0, 80)}`);
  }
  return price;
}

/**
 * Pure: combine the two legs. No curve trades (null curve price) is a REAL
 * empty — the token simply has no price yet. But a missing SPCX/USD price is
 * always an upstream glitch (SPCX is a major listed asset), so it THROWS:
 * a fulfilled empty would overwrite the cached good value for a whole TTL,
 * while a throw makes the cache keep serving it (see cache.js).
 */
function combinePrices(curvePrice, quoteUsd) {
  if (curvePrice === null) return EMPTY;
  if (quoteUsd === null) throw new Error('SPCX price unavailable from DexScreener');
  return { priceUsd: curvePrice * quoteUsd };
}

async function fetchCurveMarket() {
  if (!config.tokenAddress || !config.rewardTokenAddress) return EMPTY;

  const chartUrl = `${config.ponsApi}/api/pons-v2-market/${config.tokenAddress}/chart?range=1d`;
  const [chart, quote] = await Promise.all([
    fetchJson(chartUrl, { headers: { accept: 'application/json' } }),
    getQuotePrice(), // shared cached SPCX/USD read (see quoteprice.js)
  ]);

  return combinePrices(parseCurvePrice(chart), quote.priceUsd);
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getCurveMarket = cached(config.marketTtlMs, fetchCurveMarket);

module.exports = { getCurveMarket, parseCurvePrice, combinePrices, EMPTY };
