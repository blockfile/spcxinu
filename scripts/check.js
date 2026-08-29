'use strict';

// Read-only preflight. Sends NO transactions.
//
// Prints the resolved config, calls every upstream once, and shows exactly what
// /stats and /rewards would answer — plus the four things that decide whether a
// cycle can actually run: the launch record, the creatorFeeRecipient verdict,
// what is claimable right now, and whether the wallet has gas.
//
// Run it on the server after editing .env. It is the fastest way to tell a
// config mistake (wrong CA, wrong chain slug, wrong wallet) apart from a token
// that simply has not launched yet.

const { formatEther } = require('ethers');
const config = require('../src/config');
const db = require('../src/db');
const { getMarketData } = require('../src/services/marketdata');
const { getTokenInfo } = require('../src/services/holders');
const { getRewards } = require('../src/services/rewards');
const { getCurveMarket } = require('../src/services/curvemarket');
const { getQuotePrice } = require('../src/services/quoteprice');
const { getFeedPage } = require('../src/services/rewardsfeed');
const { buildStats } = require('../src/routes/stats');
const { getLaunch, describePhase } = require('../src/evm/launch');
const { escrowBalanceQuote } = require('../src/evm/escrow');
const { sweepableQuote } = require('../src/evm/sweep');
const { isFeeRecipientOk } = require('../src/jobs/cycle');
const { provider, walletAddress } = require('../src/evm/provider');

const show = (v) => (v === null || v === undefined ? '—' : v);
const hr = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`);

async function botSection(quotePriceUsd) {
  hr('BOT — can a cycle actually run?');

  if (config.dryRun) {
    console.log('  DRY_RUN=true — the bot simulates everything and needs no chain access.');
    console.log('  Set DRY_RUN=false to preflight the live path.');
    return;
  }
  if (!config.tokenAddress) {
    console.log('  TOKEN_ADDRESS is blank — the bot cannot run a cycle yet.');
    return;
  }

  const me = walletAddress();
  console.log(`  wallet     : ${me}${config.walletIsEphemeral ? '  ⚠️ EPHEMERAL — set WALLET_PRIVATE_KEY' : ''}`);

  let launch;
  try {
    launch = await getLaunch();
  } catch (err) {
    console.log(`  ⚠️ launch record unreadable: ${err.message}`);
    return;
  }

  console.log(`  phase      : ${describePhase(launch)}`);
  console.log(`  pairToken  : ${launch.pairToken}  (fees accrue in this asset)`);
  console.log(`  creatorTax : ${launch.creatorTaxBps} bps`);
  console.log(`  buyback    : ${launch.buybackEnabled}${launch.buybackEnabled ? '  ⚠️ sweeps will be skipped' : ''}`);

  const ok = isFeeRecipientOk(launch, me);
  console.log(
    `  feeRecip.  : ${launch.creatorFeeRecipient} ${
      ok
        ? '✓ (this wallet — authorized to sweep AND claim)'
        : '⚠️ NOT this wallet — the bot can never claim. Is pons\'s "route fees to holders" toggle on?'
    }`
  );

  const [inEscrow, pending, gasWei] = await Promise.all([
    escrowBalanceQuote(),
    sweepableQuote(launch).catch(() => 0),
    provider.getBalance(me).catch(() => null),
  ]);
  const claimable = inEscrow + pending;
  const usd = typeof quotePriceUsd === 'number' ? claimable * quotePriceUsd : null;

  console.log(`  in escrow  : ${inEscrow} SPCX (claimable now)`);
  console.log(`  unswept    : ${pending} SPCX (needs a sweep first)`);
  console.log(
    `  total      : ${claimable} SPCX${usd === null ? '' : ` ≈ $${usd.toFixed(2)}`}` +
      (config.triggerMode === 'accumulation'
        ? `  (fires at $${config.claimEveryUsd}${usd === null ? '' : usd >= config.claimEveryUsd ? ' — READY' : ' — holding'})`
        : '  (interval mode — fires every tick)')
  );

  if (gasWei === null) {
    console.log('  gas (ETH)  : ⚠️ could not read the balance');
  } else {
    const gasEth = Number(formatEther(gasWei));
    console.log(
      `  gas (ETH)  : ${gasEth}${gasEth < config.gasReserveEth ? `  ⚠️ BELOW GAS_RESERVE_ETH (${config.gasReserveEth}) — cycles will refuse to start` : ''}`
    );
  }
}

async function main() {
  hr('CONFIG');
  console.log(`  token      : ${config.tokenSymbol} ${config.tokenAddress || '(TOKEN_ADDRESS not set)'}`);
  console.log(`  reward     : SPCX ${config.rewardTokenAddress} (${config.rewardDecimals} decimals)`);
  console.log(`  explorer   : ${config.explorerApi}`);
  console.log(`  dexscreener: chain "${config.dexscreenerChainId}"`);
  console.log(`  pons api   : ${config.ponsApi}`);
  console.log(`  split      : ${config.rewardPct}% holders / ${config.devPct}% dev`);
  console.log(
    `  dev payout : ${config.devPayoutAddress || '⚠️ not set — the dev cut accumulates in the bot wallet'}`
  );
  console.log(`  minHold    : ${config.minHold} ${config.tokenSymbol} to qualify`);
  console.log(`  trigger    : ${config.triggerMode}${config.triggerMode === 'accumulation' ? ` at $${config.claimEveryUsd}` : ''} on "${config.pollSchedule}"`);
  console.log(`  dryRun     : ${config.dryRun}`);
  console.log(`  cors       : ${config.corsOrigins.join(', ')}`);
  console.log(`  ports      : api ${config.port}, bot ${config.botPort} (localhost only)`);

  // The rewards total and the feed come from our own ledger now, so the
  // preflight needs the database the bot writes to.
  await db.connect();

  if (!config.tokenAddress) {
    hr('PRE-LAUNCH');
    console.log('  TOKEN_ADDRESS is blank — /stats answers null for every field and');
    console.log('  /rewards an empty page. That is the correct pre-launch state: the site');
    console.log('  hides the tiles and shows an empty feed.');
    await db.close();
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

  hr('DEXSCREENER (market cap)');
  if (market.status === 'rejected') console.log(`  FAILED: ${market.reason.message}`);
  else if (market.value.marketCap === null) console.log('  no pair found on this chain yet');
  else {
    console.log(`  marketCap  : ${show(market.value.marketCap)}`);
    console.log(`  priceUsd   : ${show(market.value.priceUsd)}`);
    console.log(`  liquidity  : ${show(market.value.liquidityUsd)}`);
  }

  hr('BLOCKSCOUT (holders)');
  if (token.status === 'rejected') console.log(`  FAILED: ${token.reason.message}`);
  else {
    console.log(`  holders    : ${show(token.value.holders)}`);
    console.log(`  circMcap   : ${show(token.value.circulatingMarketCap)} (market cap fallback)`);
  }

  hr('DEXSCREENER (SPCX/USD — prices the trigger and the rewards tile)');
  if (quote.status === 'rejected') console.log(`  FAILED: ${quote.reason.message}  ⚠️ the bot HOLDS without this`);
  else console.log(`  priceUsd   : ${quote.value.priceUsd}`);

  hr('PONS CURVE (pre-graduation price, via SPCX/USD)');
  if (curve.status === 'rejected') console.log(`  FAILED: ${curve.reason.message}`);
  else if (curve.value.priceUsd === null) console.log('  no curve price (no trades, or SPCX unlisted)');
  else console.log(`  priceUsd   : ${curve.value.priceUsd}`);

  hr('OUR LEDGER (total SPCX rewarded)');
  if (rewards.status === 'rejected') console.log(`  FAILED: ${rewards.reason.message}`);
  else console.log(`  totalRewarded: ${show(rewards.value.totalRewarded)} SPCX (real payouts only)`);

  hr('OUR LEDGER (first 3 rows of GET /rewards)');
  if (feed.status === 'rejected') console.log(`  FAILED: ${feed.reason.message}`);
  else if (feed.value.rows.length === 0) console.log('  no payouts yet');
  else {
    for (const r of feed.value.rows) {
      const when = r.at === null ? '—' : new Date(r.at).toISOString();
      console.log(`  +${r.amount} SPCX -> ${r.wallet}  ${when}  ${r.txHash}`);
    }
    console.log(`  nextCursor : ${show(feed.value.nextCursor)}`);
  }

  await botSection(quote.status === 'fulfilled' ? quote.value.priceUsd : null);

  hr('GET /stats would answer');
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

  console.log('\n✅ preflight complete (no transactions sent)');
  await db.close();
}

main().catch(async (err) => {
  console.error('\n❌ check failed:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
