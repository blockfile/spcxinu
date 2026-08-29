'use strict';

// Forward the dev cut to a cold address at the end of each cycle.
//
// Without this the dev cut simply accumulates in the bot wallet — the one whose
// private key sits in a .env file on an internet-facing server. Over months that
// turns a disposable hot wallet into the project treasury. Sending it out every
// cycle means the server wallet only ever holds gas plus the cut of the cycle
// currently in flight.
//
// DEV_PAYOUT_ADDRESS is an ADDRESS, never a key: the destination only receives,
// so its key can stay in a hardware wallet and never touch the server.
//
// This is deliberately NOT part of the airdrop:
//   - the dev cut is not a holder reward, and recording it as one would publish
//     it in the public /rewards feed and inflate `totalRewarded`;
//   - it must not disturb the invariant that airdrop allocations sum exactly to
//     the amount distributed to holders.
//
// It is also deliberately non-fatal. By the time it runs the escrow has been
// claimed and the holders have been paid; a failure here means the cut is still
// ours, just sitting in the hot wallet instead of the cold one. Failing the
// cycle over that would mark a successful airdrop as failed.

const { parseUnits } = require('ethers');
const config = require('../config');
const { wallet } = require('./provider');
const { erc20 } = require('./erc20');
const { sendTx } = require('./send');
const { toUnitString } = require('./units');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Pure: a one-line log/description of what the dev payout did. */
function describeOutcome(result) {
  if (result.skipped) return `dev payout skipped: ${result.reason}`;
  if (result.sent) return `dev payout sent ${result.amount} SPCX -> ${result.to}`;
  return `dev payout FAILED (${result.error}) — the cut stays in the bot wallet and is retried next cycle`;
}

/**
 * Send `quoteAmount` SPCX to DEV_PAYOUT_ADDRESS.
 *
 * @param {{quoteAmount: number}} opts
 * @returns {Promise<{sent:boolean, skipped:boolean, reason?:string, error?:string,
 *                    signature:string|null, amount:number, to:string|null}>}
 */
async function sendDevPayout({ quoteAmount }) {
  const to = config.devPayoutAddress;
  const base = { sent: false, skipped: false, signature: null, amount: quoteAmount, to };

  if (!to) {
    return {
      ...base,
      skipped: true,
      reason: 'DEV_PAYOUT_ADDRESS not set — the dev cut stays in the bot wallet',
    };
  }
  if (!(quoteAmount > 0)) {
    return { ...base, skipped: true, reason: 'dev cut is zero' };
  }

  if (config.dryRun) {
    return { ...base, sent: true, signature: fakeSig('devpayout') };
  }

  const raw = parseUnits(toUnitString(quoteAmount, config.rewardDecimals), config.rewardDecimals);
  if (raw <= 0n) {
    return { ...base, skipped: true, reason: 'dev cut rounds to zero base units' };
  }

  try {
    const token = erc20(config.rewardTokenAddress, wallet);
    const tx = await sendTx(() => token.transfer(to, raw));
    await tx.wait();
    console.log(`[tx] dev payout ${quoteAmount} SPCX -> ${to}: ${tx.hash}`);
    return { ...base, sent: true, signature: tx.hash };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    console.error(`[devpayout] ${error}`);
    return { ...base, sent: false, error };
  }
}

module.exports = { sendDevPayout, describeOutcome };
