'use strict';

// One reward cycle:
//
//   sweep pending fees into the escrow   (best-effort — may need pons's operator)
//   claimToken(SPCX)                     -> SPCX in the wallet
//     -> REWARD_PCT: airdrop pro-rata to SPACEINU holders
//     -> remainder:  stays in the wallet as SPCX (the dev cut)
//
// There is NO buy leg. SPACEINU is quoted in SPCX, so the creator fees arrive
// already denominated in the asset holders are paid in — nothing is ever
// swapped, which removes slippage, quoting and the whole class of "bought the
// reward but failed to hand it out" failures.
//
// Each step is recorded as it completes; a thrown step fails the cycle without
// crashing the process.

const { formatEther, parseUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { getLaunch, describePhase } = require('../evm/launch');
const { sweepFees } = require('../evm/sweep');
const { claimQuoteFromEscrow } = require('../evm/escrow');
const { getDecimals, getTokenSupplyRaw } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');
const { toUnitString } = require('../evm/units');
const { provider } = require('../evm/provider');

/**
 * Split a claim into its two legs. Pure, so the invariant that the legs re-add
 * to the claim is directly testable. The dev cut needs no transaction — it is
 * already SPCX sitting in the wallet once the claim lands.
 */
function splitClaim(claimedQuote) {
  const rewardQuote = +(claimedQuote * (config.rewardPct / 100)).toFixed(9);
  const devQuote = +(claimedQuote - rewardQuote).toFixed(9);
  return { rewardQuote, devQuote };
}

/**
 * Is this wallet the address the launch actually pays creator fees to? Only
 * that address may sweep OR claim, so a mismatch means the cycle can never
 * collect anything — silently, with no error anywhere.
 * Case-insensitive: the factory returns EIP-55 checksummed addresses.
 */
function isFeeRecipientOk(launch, address) {
  const want = String(address || '').toLowerCase();
  const got = String((launch && launch.creatorFeeRecipient) || '').toLowerCase();
  return want !== '' && got !== '' && want === got;
}

/** The operator-facing warning for a mismatch, or null when it is fine. */
function feeRecipientWarning(launch, address) {
  if (isFeeRecipientOk(launch, address)) return null;
  const got = (launch && launch.creatorFeeRecipient) || '(unset)';
  return (
    `creatorFeeRecipient MISMATCH: the launch pays creator fees to ${got}, ` +
    `but this bot's wallet is ${address || '(unset)'}. This cycle cannot claim — ` +
    'only the creatorFeeRecipient may sweep or claim. The usual cause is that ' +
    "pons's \"route creator fees to holders\" toggle was switched on, which " +
    'reassigns the recipient to a fee distributor contract and leaves this bot ' +
    'with nothing. Switch it back off, or point WALLET_PRIVATE_KEY at the ' +
    'recipient the launch actually names.'
  );
}

// Last observed result of the check above, so the operator API can report it
// without making a chain call of its own. null until the first cycle runs.
let lastFeeRecipientCheck = null;
function getFeeRecipientCheck() {
  return lastFeeRecipientCheck;
}

/**
 * How a cycle finishes, given what the reward leg actually did. Pure, so both
 * the "airdrop reached nobody" and the "nobody was eligible" cases are directly
 * testable — they look identical in `sent` (0) and must not be recorded
 * identically. One is a quiet no-op; the other means the SPCX is stranded.
 */
function summarizeReward(reward) {
  if (reward.skipped) {
    return { status: 'complete', note: `reward leg skipped: ${reward.reason}` };
  }
  if (!(reward.recipients > 0)) {
    return { status: 'complete', note: 'no eligible holders — nothing to airdrop' };
  }
  if (!(reward.sent > 0)) {
    return {
      status: 'failed',
      note: `airdrop reached 0 of ${reward.recipients} recipients`,
      error:
        `airdrop delivered nothing: 0 of ${reward.recipients} recipients received SPCX ` +
        `(${reward.failed} failed). Likely causes: DISPERSE_ADDRESS is set but this wallet ` +
        'has never approve()d SPCX to it, the wallet is out of ETH for gas, or SPCX is ' +
        'paused. The SPCX claimed this cycle is still sitting in the wallet.',
    };
  }
  if (reward.failed > 0) {
    return { status: 'complete', note: `airdrop sent ${reward.sent}, ${reward.failed} failed` };
  }
  return { status: 'complete', note: `airdrop sent ${reward.sent}` };
}

/** Airdrop `quoteAmount` of SPCX pro-rata to eligible holders of the fee token. */
async function runRewardLeg(cycleId, { launch, quoteAmount }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  // MIN_HOLD is a whole-token figure; scale it by the TOKEN's own decimals
  // rather than assuming 18, or the eligibility threshold is wrong by orders of
  // magnitude on any token that is not 18-decimal — in whichever direction
  // makes the airdrop include everybody or nobody.
  const tokenDecimals = await getDecimals(launch.token);
  const minHoldRaw = (BigInt(Math.trunc(config.minHold)) * 10n ** BigInt(tokenDecimals)).toString();

  const exclude = await buildExcludeSet(launch);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: launch.token, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(launch.token)).toString();

  // The airdrop is denominated in SPCX base units.
  const totalRaw = parseUnits(toUnitString(quoteAmount, config.rewardDecimals), config.rewardDecimals);
  const allocations = computeWeightedAllocations(holders, totalRaw.toString(), {
    capPct,
    supplyRaw,
    clusters: config.clusters,
  });

  const air = await airdropToken({ rewardToken: config.rewardTokenAddress, allocations, cycleId });
  await repo.addStep({
    cycleId,
    name: 'airdrop',
    status: air.failed ? 'failed' : 'ok',
    detail: {
      token: config.rewardTokenAddress,
      quoteAmount,
      recipients: allocations.length,
      sent: air.sent,
      failed: air.failed,
    },
  });
  log(`airdrop SPCX sent=${air.sent} failed=${air.failed}`);

  return {
    recipients: allocations.length,
    sent: air.sent,
    failed: air.failed,
    eligibleHolders: holders.length,
    totalHolders,
  };
}

async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (SPACEINU) is required');

    const launch = await getLaunch();
    const phase = describePhase(launch);
    log(`phase=${phase}${launch.graduated ? ` pool=${String(launch.poolId).slice(0, 10)}…` : ` curve=${launch.curve}`}`);

    // Gas is NOT self-funding here: the dev cut is SPCX while gas is ETH, so
    // the wallet cannot refill itself from what it collects. Refuse to start
    // rather than emptying the escrow and then failing to pay anyone out.
    if (!config.dryRun) {
      const gasEth = Number(formatEther(await provider.getBalance(config.wallet.address)));
      if (gasEth < config.gasReserveEth) {
        throw new Error(
          `wallet ETH ${gasEth} is below GAS_RESERVE_ETH (${config.gasReserveEth}) — ` +
          'top up the wallet with ETH for gas; the fees stay safe in the escrow until then'
        );
      }
    }

    // The one thing that must not be wrong. Warn, never throw: an operator may
    // be mid-migration, and the cycle below still reports what it finds.
    const walletAddress = config.wallet.address;
    const feeWarning = feeRecipientWarning(launch, walletAddress);
    lastFeeRecipientCheck = {
      ok: feeWarning === null,
      expected: walletAddress,
      actual: launch.creatorFeeRecipient || null,
      at: new Date().toISOString(),
    };
    if (feeWarning) console.warn(`[cycle ${id}] ⚠️  ${feeWarning}`);

    // 1. Sweep pending fees into the escrow. Never fatal.
    const sweep = await sweepFees(launch);
    await repo.addStep({
      cycleId: id,
      name: 'sweep',
      status: sweep.swept ? 'ok' : 'skipped',
      signature: sweep.signature,
      detail: { phase, reason: sweep.reason },
    });
    if (sweep.skipped) log(`sweep skipped: ${sweep.reason}`);

    // 2. Claim the escrow, as SPCX.
    const claim = await claimQuoteFromEscrow();
    await repo.addStep({
      cycleId: id,
      name: 'claim',
      status: 'ok',
      signature: claim.signature,
      detail: { quoteClaimed: claim.quoteClaimed },
    });
    log(`claimed ${claim.quoteClaimed} SPCX`);

    const claimed = claim.quoteClaimed;
    if (!(claimed > 0)) {
      await repo.finishCycle(id, {
        status: 'skipped',
        phase,
        quote_claimed: 0,
        sweep_skipped: sweep.skipped ? 1 : 0,
        sweep_reason: sweep.reason,
        note: 'nothing claimed',
      });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    // 3. Split.
    const { rewardQuote, devQuote } = splitClaim(claimed);
    log(`split: ${rewardQuote} SPCX to holders (${config.rewardPct}%), keep ${devQuote} for dev`);

    // 4. Reward leg — airdrop the claimed SPCX directly. Nothing is bought.
    let reward = { skipped: false, sent: 0, failed: 0, recipients: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardQuote > 0) {
      reward = { skipped: false, ...(await runRewardLeg(id, { launch, quoteAmount: rewardQuote })) };
    } else {
      const reason = 'reward share of this claim is zero';
      reward = { ...reward, skipped: true, reason };
      await repo.addStep({ cycleId: id, name: 'reward', status: 'skipped', detail: { reason, rewardQuote } });
      log(`reward leg skipped: ${reason}`);
    }

    // 5. The dev cut needs no transaction: it is already SPCX in the wallet.

    const outcome = summarizeReward(reward);
    await repo.finishCycle(id, {
      status: outcome.status,
      mode: 'reward',
      phase,
      quote_claimed: claimed,
      quote_distributed: reward.skipped ? 0 : rewardQuote,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      sweep_skipped: sweep.skipped ? 1 : 0,
      sweep_reason: sweep.reason,
      note: outcome.note,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    if (outcome.status === 'complete') log(`complete — ${outcome.note}`);
    else console.warn(`[cycle ${id}] FAILED: ${outcome.error}`);
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = {
  runCycle,
  runRewardLeg,
  splitClaim,
  summarizeReward,
  isFeeRecipientOk,
  feeRecipientWarning,
  getFeeRecipientCheck,
};
