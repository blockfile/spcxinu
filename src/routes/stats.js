'use strict';

// GET /stats returns what the site's BOOT window reads (src/api/mockData.js
// in the frontend documents the shape; VideoTV.jsx renders it):
//
//   { "marketCap": 4189702,        -> "Market Cap" panel, formatted with a "$"
//     "ketDistributed": 826.7,     -> "Total $SPCX Distributed" panel, SPCX token amount
//     "totalHolders": 12879 }
//
// The remaining fields are aliases and extras for sites built from the other
// templates in this lineage (`spcxRewarded`/`rewarded` = USD figure, `price`,
// `holders`), so any of those frontends works against this API unchanged.
// A field that cannot be sourced is null, never 0 — the site renders a null
// as "—", but would render a 0 as a real number.

const express = require('express');
const config = require('../config');
const { getMarketData } = require('../services/marketdata');
const { getTokenInfo } = require('../services/holders');
const { getRewards } = require('../services/rewards');
const { getCurveMarket } = require('../services/curvemarket');
const { getQuotePrice } = require('../services/quoteprice');

const router = express.Router();

/** Pure: USD value of the SPCX paid to holders, or null if either leg is missing. */
function rewardedUsd(rewards, quote) {
  if (typeof rewards.totalRewarded !== 'number' || typeof quote.priceUsd !== 'number') return null;
  return rewards.totalRewarded * quote.priceUsd;
}

/**
 * Pure: market cap computed from the bonding-curve price and the token's
 * total supply, for the window before the token graduates to a real pool.
 * Needs both halves — a price with no supply (or vice versa) is null.
 */
function curveMarketCap(curve, token) {
  if (typeof curve.priceUsd !== 'number') return null;
  if (token.totalSupply == null || token.decimals == null) return null;
  return (Number(BigInt(token.totalSupply)) / 10 ** token.decimals) * curve.priceUsd;
}

/**
 * Pure: the configured supply as Blockscout would report it (a wei string plus
 * decimals), or null when TOKEN_TOTAL_SUPPLY is not set.
 */
function supplyFallback({ tokenTotalSupply, tokenDecimals }) {
  if (tokenTotalSupply == null || !Number.isFinite(tokenTotalSupply) || tokenTotalSupply <= 0) return null;
  const decimals = Number.isFinite(tokenDecimals) ? tokenDecimals : 18;
  return {
    totalSupply: (BigInt(Math.round(tokenTotalSupply)) * 10n ** BigInt(decimals)).toString(),
    decimals,
  };
}

/**
 * Pure: fill in supply/decimals from the fallback when the explorer could not
 * provide them, so the bonding-curve market cap survives a Blockscout outage
 * (its Cloudflare front intermittently refuses API calls). Explorer values
 * always win when present.
 */
function withSupplyFallback(token, fallback) {
  if (!fallback) return token;
  return {
    ...token,
    totalSupply: token.totalSupply ?? fallback.totalSupply,
    decimals: token.decimals ?? fallback.decimals,
  };
}

/**
 * Pure: merge the five upstreams into the response body.
 *
 * Market cap prefers DexScreener (live pool pricing, exists only after the
 * token graduates), then Blockscout's circulating_market_cap (populated only
 * once the explorer has an exchange rate), then the bonding-curve computation
 * — so the tile shows a real number at every stage of the token's life.
 */
function buildStats({ market, token: explorerToken, rewards = {}, curve = {}, quote = {}, symbol, tokenAddress, supply = null }) {
  const token = withSupplyFallback(explorerToken, supply);
  const priceUsd = market.priceUsd ?? curve.priceUsd ?? null;
  const totalRewarded = rewards.totalRewarded ?? null; // SPCX token amount
  const totalRewardedUsd = rewardedUsd(rewards, quote);
  const holders = token.holders ?? null;
  return {
    marketCap: market.marketCap ?? token.circulatingMarketCap ?? curveMarketCap(curve, token),
    holders,
    totalHolders: holders, // the name this site's mock shape uses
    totalRewarded,
    // "Total $SPCX Distributed" panel — the site shows this without a "$", so
    // it is the SPCX token amount, not USD. (Field name inherited from the
    // template's original token.)
    ketDistributed: totalRewarded,
    totalRewardedUsd,
    // USD figure under the names the other frontend templates read
    // (`raw.<asset>Rewarded ?? raw.<asset>_rewarded ?? raw.rewarded`).
    spcxRewarded: totalRewardedUsd,
    rewarded: totalRewardedUsd,
    priceUsd,
    price: priceUsd,
    liquidityUsd: market.liquidityUsd ?? null,
    symbol,
    tokenAddress: tokenAddress ?? null,
    updatedAt: new Date().toISOString(),
  };
}

router.get('/stats', async (req, res, next) => {
  try {
    // Independent upstreams — one being down must not delay or fail the other,
    // so all settle and a rejection degrades to nulls for its own fields only.
    const [marketResult, tokenResult, rewardsResult, curveResult, quoteResult] = await Promise.allSettled([
      getMarketData(),
      getTokenInfo(),
      getRewards(),
      getCurveMarket(),
      getQuotePrice(),
    ]);

    const market = marketResult.status === 'fulfilled' ? marketResult.value : {};
    const token = tokenResult.status === 'fulfilled' ? tokenResult.value : {};
    const rewards = rewardsResult.status === 'fulfilled' ? rewardsResult.value : {};
    const curve = curveResult.status === 'fulfilled' ? curveResult.value : {};
    const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : {};

    if (marketResult.status === 'rejected') {
      console.warn('[spaceinu] market data unavailable:', marketResult.reason?.message);
    }
    if (tokenResult.status === 'rejected') {
      console.warn('[spaceinu] holder count unavailable:', tokenResult.reason?.message);
    }
    if (rewardsResult.status === 'rejected') {
      console.warn('[spaceinu] rewards unavailable:', rewardsResult.reason?.message);
    }
    if (curveResult.status === 'rejected') {
      console.warn('[spaceinu] curve price unavailable:', curveResult.reason?.message);
    }
    if (quoteResult.status === 'rejected') {
      console.warn('[spaceinu] SPCX price unavailable:', quoteResult.reason?.message);
    }

    res.json(
      buildStats({
        market,
        token,
        rewards,
        curve,
        quote,
        symbol: config.tokenSymbol,
        tokenAddress: config.tokenAddress,
        supply: supplyFallback(config),
      })
    );
  } catch (err) {
    next(err);
  }
});

module.exports = { router, buildStats, supplyFallback, withSupplyFallback };
