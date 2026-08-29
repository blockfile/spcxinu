'use strict';

// Market cap for SPACEINU, from DexScreener's public API (no key required).
//
// Returns nulls rather than throwing when the token isn't listed yet or the API
// is unreachable, so /stats never breaks — the site hides a tile whose value is
// null instead of showing a misleading zero. The chain slug is configurable
// (DEXSCREENER_CHAIN_ID) because newly-supported chains get their slug over time.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');

const EMPTY = { marketCap: null, priceUsd: null, liquidityUsd: null, pairUrl: null };

const toNumber = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Pure: pick our token's deepest pair out of a DexScreener response.
 * @param {object} data raw DexScreener body
 * @param {string} token lowercased contract address
 * @param {string} chainId DexScreener chain slug
 */
function parsePairs(data, token, chainId) {
  const pairs = Array.isArray(data && data.pairs) ? data.pairs : [];

  // Pairs on our chain where our token is the base side; deepest liquidity wins.
  const ours = pairs
    .filter(
      (p) =>
        p.chainId === chainId &&
        p.baseToken &&
        p.baseToken.address &&
        p.baseToken.address.toLowerCase() === token
    )
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));

  const p = ours[0];
  if (!p) return EMPTY;
  return {
    // marketCap is DexScreener's circulating figure; fdv is the fully-diluted
    // one. Memecoins normally have their whole supply in circulation, so the
    // two agree — but fdv is the more reliably populated of the two.
    marketCap: toNumber(p.marketCap) ?? toNumber(p.fdv),
    priceUsd: toNumber(p.priceUsd),
    liquidityUsd: toNumber(p.liquidity && p.liquidity.usd),
    pairUrl: p.url || null,
  };
}

async function fetchMarketData() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing listed anywhere
  const url = `https://api.dexscreener.com/latest/dex/tokens/${config.tokenAddress}`;
  const data = await fetchJson(url, { headers: { accept: 'application/json' } });
  return parsePairs(data, config.tokenAddress, config.dexscreenerChainId);
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getMarketData = cached(config.marketTtlMs, fetchMarketData);

module.exports = { getMarketData, parsePairs, EMPTY };
