'use strict';

// Read-only preflight. Prints the resolved config, then calls every upstream
// once and shows exactly what /stats and /rewards would answer. Run it on the
// server after editing .env — it is the fastest way to tell a config mistake
// (wrong CA, wrong chain slug) apart from a token that simply isn't listed yet.

const config = require('../src/config');
const { getMarketData } = require('../src/services/marketdata');
const { getTokenInfo } = require('../src/services/holders');
const { getRewards } = require('../src/services/rewards');
const { getCurveMarket } = require('../src/services/curvemarket');
const { getQuotePrice } = require('../src/services/quoteprice');
const { getFeedPage } = require('../src/services/rewardsfeed');
const { buildStats } = require('../src/routes/stats');

const show = (v) => (v === null || v === undefined ? '—' : v);

async function main() {
  console.log('config');
  console.log(`  token      : ${config.tokenSymbol} ${config.tokenAddress || '(TOKEN_ADDRESS not set)'}`);
  console.log(`  explorer   : ${config.explorerApi}`);
  console.log(`  dexscreener: chain "${config.dexscreenerChainId}"`);
  console.log(`  pons api   : ${config.ponsApi}`);
  console.log(`  reward     : SPCX ${config.rewardTokenAddress} (${config.rewardDecimals} decimals)`);
  console.log(`  distributor: ${config.distributorAddress || '(resolved from Pons)'}`);
  console.log(`  cors       : ${config.corsOrigins.join(', ')}`);
  console.log(`  port       : ${config.port}`);
  console.log('');

  if (!config.tokenAddress && !config.distributorAddress) {
    console.log('TOKEN_ADDRESS is blank — /stats will answer null for every field and');
    console.log('/rewards an empty page. That is the correct pre-launch state; the site');
    console.log('hides the tiles and shows an empty feed.');
    return;
  }

  const [market, token, rewards, curve, quote, feed] = await Promise.allSettled([
    getMarketData(),
    getTokenInfo(),
    getRewards(),
    getCurveMarket(),
    getQuotePrice(),
    getFeedPage(null, 3),
  ]);

  console.log('dexscreener (market cap)');
  if (market.status === 'rejected') console.log(`  FAILED: ${market.reason.message}`);
  else if (market.value.marketCap === null) console.log('  no pair found on this chain yet');
  else {
    console.log(`  marketCap  : ${show(market.value.marketCap)}`);
    console.log(`  priceUsd   : ${show(market.value.priceUsd)}`);
    console.log(`  liquidity  : ${show(market.value.liquidityUsd)}`);
  }
  console.log('');

  console.log('blockscout (holders)');
  if (token.status === 'rejected') console.log(`  FAILED: ${token.reason.message}`);
  else {
    console.log(`  holders    : ${show(token.value.holders)}`);
    console.log(`  circMcap   : ${show(token.value.circulatingMarketCap)} (market cap fallback)`);
  }
  console.log('');

  console.log('dexscreener (SPCX/USD)');
  if (quote.status === 'rejected') console.log(`  FAILED: ${quote.reason.message}`);
  else console.log(`  priceUsd   : ${quote.value.priceUsd}`);
  console.log('');

  console.log('pons curve (pre-graduation price, via SPCX/USD)');
  if (curve.status === 'rejected') console.log(`  FAILED: ${curve.reason.message}`);
  else if (curve.value.priceUsd === null) console.log('  no curve price (no trades, or SPCX unlisted)');
  else console.log(`  priceUsd   : ${curve.value.priceUsd}`);
  console.log('');

  console.log('pons fee distributor (total SPCX rewarded)');
  if (rewards.status === 'rejected') console.log(`  FAILED: ${rewards.reason.message}`);
  else if (rewards.value.distributor === null) console.log('  no distributor found for this token yet');
  else {
    console.log(`  distributor  : ${rewards.value.distributor}`);
    console.log(`  totalRewarded: ${show(rewards.value.totalRewarded)}`);
  }
  console.log('');

  console.log('blockscout (rewards feed — first 3 rows of GET /rewards)');
  if (feed.status === 'rejected') console.log(`  FAILED: ${feed.reason.message}`);
  else if (feed.value.rows.length === 0) console.log('  no payouts yet (or no distributor)');
  else {
    for (const r of feed.value.rows) {
      const when = r.at === null ? '—' : new Date(r.at).toISOString();
      console.log(`  +${r.amount} SPCX -> ${r.wallet}  ${when}  ${r.txHash}`);
    }
    console.log(`  nextCursor : ${show(feed.value.nextCursor)}`);
  }
  console.log('');

  console.log('GET /stats would answer:');
  console.log(
    JSON.stringify(
      buildStats({
        market: market.status === 'fulfilled' ? market.value : {},
        token: token.status === 'fulfilled' ? token.value : {},
        rewards: rewards.status === 'fulfilled' ? rewards.value : {},
        curve: curve.status === 'fulfilled' ? curve.value : {},
        quote: quote.status === 'fulfilled' ? quote.value : {},
        symbol: config.tokenSymbol,
        tokenAddress: config.tokenAddress,
      }),
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('check failed:', err);
  process.exit(1);
});
