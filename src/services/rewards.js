'use strict';

// Total SPCX rewarded to holders, from the Pons fee distributor.
//
// SPACEINU launches on the Pons V2 launchpad paired with SPCX (tokenized SpaceX
// stock). Its 2% creator tax accrues in SPCX and routes — with no creator
// claim — to a per-token fee distributor contract, which pushes epoch-based
// payouts straight to holder wallets. The cumulative "paid to holders" number
// has no single on-chain getter (the contract is epoch-based; Pons sums it
// server-side), so this reads the same public API the Pons token page uses:
//
//   GET {ponsApi}/api/pons-v2-market/{token}/distributor
//   -> { state, distributor, distributedQuote, ... }   (wei strings)
//
// `distributedQuote` is the SPCX total, scaled here by REWARD_DECIMALS.
// The value is exposed as a TOKEN amount, deliberately not converted to USD.
// Pre-launch (no token address) or no distributor: null, never 0 — the site
// hides a null tile. A zero from an active distributor is a REAL zero (no
// payout epoch has run yet) and is preserved. A malformed response throws so
// the cache keeps serving the last good value (see cache.js) and /stats
// degrades this field to null.

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cached } = require('./cache');

const EMPTY = { totalRewarded: null, distributor: null };

/** Pure: map the Pons distributor API payload onto {totalRewarded, distributor}. */
function parseDistributor(data, decimals) {
  if (!data || typeof data !== 'object') {
    throw new Error(`malformed distributor response: ${String(data).slice(0, 80)}`);
  }
  if (data.distributedQuote == null) return EMPTY; // token has no distributor
  if (typeof data.distributedQuote !== 'string' || !/^\d+$/.test(data.distributedQuote)) {
    throw new Error(`malformed distributedQuote: ${String(data.distributedQuote).slice(0, 80)}`);
  }
  return {
    totalRewarded: Number(BigInt(data.distributedQuote)) / 10 ** decimals,
    distributor: data.distributor ? String(data.distributor).toLowerCase() : null,
  };
}

async function fetchRewards() {
  if (!config.tokenAddress) return EMPTY; // pre-launch: nothing to ask about
  const url = `${config.ponsApi}/api/pons-v2-market/${config.tokenAddress}/distributor`;
  const data = await fetchJson(url, { headers: { accept: 'application/json' } });
  return parseDistributor(data, config.rewardDecimals);
}

// Cached read. On failure the last good value keeps being served (see cache.js).
const getRewards = cached(config.rewardsTtlMs, fetchRewards);

module.exports = { getRewards, parseDistributor, EMPTY };
