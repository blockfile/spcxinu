'use strict';
require('dotenv').config();
const { Wallet, isAddress } = require('ethers');

function num(v, d) {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);
const lowerOr = (v, d) => lowerOrNull(v) || d;

function parseClusters(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(Array.isArray)
      .map((g) => g.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))
      .filter((g) => g.length > 0);
  } catch (_err) {
    console.warn('[spaceinu] CLUSTERS is not valid JSON — ignoring');
    return [];
  }
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

// The signing wallet lives here so bot.js can use it and server.js never
// touches it. In DRY_RUN an ephemeral wallet stands in, so a dry run needs no
// key at all; a live run without one is refused rather than silently signing
// with a throwaway address that owns nothing.
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
  try {
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}
const { wallet, ephemeral: walletIsEphemeral } = loadWallet();

// Where the dev cut is sent at the end of each cycle. Optional: blank leaves it
// in the bot wallet, which is the old behaviour.
//
// Validated HERE rather than at send time on purpose. A typo'd address would
// otherwise be discovered only once a cycle had already claimed and paid the
// holders, and — if the typo happened to be a valid-looking address — would send
// the dev cut somewhere unrecoverable, every cycle, silently.
const devPayoutAddress = lowerOrNull(process.env.DEV_PAYOUT_ADDRESS);
if (devPayoutAddress && !isAddress(devPayoutAddress)) {
  throw new Error(`DEV_PAYOUT_ADDRESS is not a valid address: ${process.env.DEV_PAYOUT_ADDRESS}`);
}

const rewardPct = num(process.env.REWARD_PCT, 80);
if (!(rewardPct >= 0 && rewardPct <= 100)) {
  throw new Error(`invalid split: REWARD_PCT(${rewardPct}) must be within [0, 100]`);
}
// The dev cut is the remainder. toFixed(6) keeps a fractional share from
// leaving float dust behind (100 - 80.1 is 19.900000000000006 in FP).
const devPct = +(100 - rewardPct).toFixed(6);

// Accumulation is the default: this launch's fees are worth hundreds of dollars
// per token, so firing on every tick would pay gas to move dust.
const triggerMode = ['interval', 'accumulation'].includes(String(process.env.TRIGGER_MODE || '').toLowerCase())
  ? String(process.env.TRIGGER_MODE).toLowerCase()
  : 'accumulation';

// Blockscout instance for Robinhood Chain — the holder count comes from here.
const explorerApi = (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, '');

const config = {
  port: num(process.env.PORT, 3000),

  // SPACEINU's contract address. Blank until the token is launched — every stat
  // then resolves to null, which the site renders as "—" rather than a zero.
  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  // The site's ticker is $SPACEINU (SITE.ticker in its config/site.js).
  tokenSymbol: process.env.TOKEN_SYMBOL || 'SPACEINU',
  tokenName: process.env.TOKEN_NAME || 'Space Inu',
  // Whole-token total supply, used ONLY to compute the pre-graduation market
  // cap when Blockscout (the normal source of supply + decimals) is
  // unreachable. Blank = no fallback. Pons V2 launches mint 1,000,000,000.
  tokenTotalSupply: num(process.env.TOKEN_TOTAL_SUPPLY, null),
  tokenDecimals: num(process.env.TOKEN_DECIMALS, 18),

  explorerApi,
  // DexScreener's slug for the chain — the market cap comes from here.
  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',

  // How long a fetched value is served before refreshing. The site polls /stats
  // every 30s per browser tab, so without this the upstreams would see one
  // request per visitor per 30s.
  marketTtlMs: num(process.env.MARKET_TTL_MS, 30_000),
  holdersTtlMs: num(process.env.HOLDERS_TTL_MS, 120_000),

  // ── Pons rewards ("Total SPCX Rewarded") ───────────────────────────────────
  // SPACEINU's 2% creator tax accrues in SPCX (tokenized SpaceX stock) and routes to a
  // per-token fee distributor that pushes payouts to holder wallets. The
  // cumulative "paid to holders" total comes from Pons's public API — the same
  // source their token page renders (see src/services/rewards.js).
  ponsApi: (process.env.PONS_API || 'https://www.ponsfamily.com').replace(/\/$/, ''),
  // SPCX (tokenized SpaceX stock) — the curve's quote asset and the reward asset.
  // Its DexScreener USD price converts the bonding-curve price to USD.
  rewardTokenAddress: lowerOrNull(process.env.REWARD_TOKEN_ADDRESS) || '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
  // Decimals of the SPCX reward asset.
  rewardDecimals: num(process.env.REWARD_DECIMALS, 18),
  rewardsTtlMs: num(process.env.REWARDS_TTL_MS, 60_000),

  // ── Rewards feed (GET /rewards) ────────────────────────────────────────────
  // Every payout is one this bot made, read straight from its own ledger (see
  // src/services/rewardsfeed.js). There is no DISTRIBUTOR_ADDRESS here on
  // purpose: pons's fee distributor and this bot are mutually exclusive, and
  // keeping the key around would suggest they can coexist.
  feedTtlMs: num(process.env.FEED_TTL_MS, 30_000),

  // Comma-separated allowlist of browser origins. Non-browser requests (no
  // Origin header) always pass; "*" allows any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Bot: chain access ──────────────────────────────────────────────────────
  dryRun: DRY_RUN,
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  wallet,
  walletIsEphemeral,

  // pons v2 wiring (verified on chain; all overridable per deployment).
  v2Factory: lowerOr(process.env.PONS_V2_FACTORY, '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'),
  memeHook: lowerOr(process.env.MEME_HOOK, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'),
  feeEscrow: lowerOr(process.env.FEE_ESCROW, '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'),
  buybackVault: lowerOr(process.env.BUYBACK_VAULT, '0x42df2a798f82289e177311362e8f5ccc45c1219c'),
  poolManager: lowerOr(process.env.POOL_MANAGER, '0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  deadAddress: lowerOr(process.env.DEAD_ADDRESS, '0x000000000000000000000000000000000000dead'),

  // ── Bot: split and eligibility ─────────────────────────────────────────────
  rewardPct,
  devPct,
  minHold: num(process.env.MIN_HOLD, 100000),
  rewardCapPct: num(process.env.REWARD_CAP_PCT, 0),
  clusters: parseClusters(process.env.CLUSTERS),
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 30),
  airdropGasLimit: num(process.env.AIRDROP_GAS_LIMIT, 120000),
  disperseAddress: lowerOrNull(process.env.DISPERSE_ADDRESS),
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean),

  // ── Bot: trigger ───────────────────────────────────────────────────────────
  triggerMode,
  pollSchedule: process.env.POLL_SCHEDULE || '*/5 * * * *',
  // The gate is denominated in USD, not tokens: fees accrue in SPCX and one
  // SPCX is worth hundreds of dollars, so a token threshold is unusable.
  claimEveryUsd: num(process.env.CLAIM_EVERY_USD, 100),
  // DRY_RUN only: simulated SPCX accrued to the vault per tick.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.05),
  // Gas is NOT self-funding here: the dev cut is SPCX while gas is ETH. Below
  // this balance a cycle refuses to start rather than claiming and then failing
  // to pay anyone out.
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.01),
  // Cold address that receives the dev cut each cycle. Blank = it stays in the
  // bot wallet. Only an ADDRESS is needed, never a key: this wallet only
  // receives, so its key never has to touch the server.
  devPayoutAddress,

  // ── Bot: storage and control ───────────────────────────────────────────────
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'spaceinu',
  apiKey: process.env.API_KEY || null,
  botPort: num(process.env.BOT_PORT, 3100),
};

module.exports = config;
