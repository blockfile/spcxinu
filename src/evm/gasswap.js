'use strict';

// Swap part of each claim from SPCX into native ETH, to pay for gas.
//
// This exists because the bot's income and its costs are different assets:
// everything it collects is SPCX, while every transaction it sends costs ETH.
// Without this leg the wallet cannot refill its own gas and needs topping up by
// hand forever — and running dry stops cycles entirely, stranding fees in the
// escrow.
//
// The route is an INDEPENDENT Uniswap v4 pool, not the pons launch pool: SPCX
// is a tokenized equity that trades on its own markets. Its key is therefore
// configured rather than derived from the launch record. Defaults are the pool
// verified on chain 2026-08-30 — poolId 0x39910df8…, fee 10000, tickSpacing
// 200, no hook, ~$103k liquidity, quoting 0.07 SPCX -> 0.00397 ETH.
//
// This is the one place the bot SELLS. Both other legs only ever pay out or
// buy, so the direction matters: currencyIn is SPCX (an ERC-20), which means
// the router pulls it through Permit2 exactly as the buyback does.
//
// Non-fatal, like every leg after the claim: by the time it runs the SPCX is
// already ours, so a failed swap leaves it in the wallet rather than losing the
// cycle. The gas position simply does not improve until the next one.

const { formatEther, parseUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle, NATIVE } = require('./pool');
const { swapExactInSingle } = require('./v4router');
const { applySlippage } = require('./buyback');
const { toUnitString } = require('./units');

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** The SPCX/ETH pool this leg trades through. */
function gasPoolKey() {
  return buildPoolKey({
    token: config.rewardTokenAddress,
    quoteToken: NATIVE,
    fee: config.gasPoolFee,
    tickSpacing: config.gasPoolTickSpacing,
    hooks: config.gasPoolHooks,
  });
}

/** Pure: a one-line description of what the gas leg did. */
function describeOutcome(r) {
  if (r.skipped) return `gas swap skipped: ${r.reason}`;
  if (r.swapped) return `gas swap sold ${r.quoteSpent} SPCX for ${r.ethReceived} ETH`;
  return `gas swap FAILED (${r.error}) — the SPCX stays in the wallet and is retried next cycle`;
}

/**
 * Sell `quoteAmount` SPCX for native ETH.
 *
 * @param {{quoteAmount: number}} opts
 * @returns {Promise<{swapped:boolean, skipped:boolean, reason?:string, error?:string,
 *                    signature:string|null, quoteSpent:number, ethReceived:number}>}
 */
async function swapQuoteForGas({ quoteAmount }) {
  const base = {
    swapped: false,
    skipped: false,
    signature: null,
    quoteSpent: quoteAmount,
    ethReceived: 0,
  };

  if (!(quoteAmount > 0)) {
    return { ...base, skipped: true, reason: 'gas share of this claim is zero' };
  }

  if (config.dryRun) {
    // Roughly the live rate at the time of writing, so a dry run's numbers are
    // the right order of magnitude rather than invented.
    return {
      ...base,
      swapped: true,
      ethReceived: +(quoteAmount * 0.0567).toFixed(9),
      signature: fakeSig('gasswap'),
    };
  }

  // Stop converting once there is plainly enough gas banked. 0 disables the
  // ceiling, which is the default — always swap.
  if (config.gasCeilingEth > 0) {
    const held = Number(formatEther(await provider.getBalance(wallet.address)));
    if (held >= config.gasCeilingEth) {
      return {
        ...base,
        skipped: true,
        reason: `wallet already holds ${held} ETH (GAS_CEILING_ETH ${config.gasCeilingEth})`,
      };
    }
  }

  const amountIn = parseUnits(toUnitString(quoteAmount, config.rewardDecimals), config.rewardDecimals);
  if (amountIn <= 0n) {
    return { ...base, skipped: true, reason: 'gas share rounds to zero base units' };
  }

  try {
    const poolKey = gasPoolKey();
    // Selling SPCX: currencyIn is SPCX, so the direction is whichever side it
    // sorts to. Native ETH is address(0) and therefore always currency0, which
    // makes this false — but derive it rather than hardcoding, so a future
    // WETH-quoted pool does not silently swap backwards.
    const zeroForOne = isZeroForOne(poolKey, config.rewardTokenAddress);
    const quoted = await quoteExactInSingle({ poolKey, zeroForOne, amountIn });
    if (quoted <= 0n) throw new Error('the SPCX/ETH pool quoted zero');

    const before = await provider.getBalance(wallet.address);
    const tx = await swapExactInSingle({
      poolKey,
      zeroForOne,
      amountIn,
      amountOutMinimum: applySlippage(quoted, config.slippagePct),
    });
    const receipt = await tx.wait();
    const after = await provider.getBalance(wallet.address);

    // The balance delta is NET of the gas this very transaction burned, so add
    // that back to report what the swap actually returned.
    const gasCost = receipt.gasUsed * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
    const received = after - before + gasCost;

    console.log(`[tx] gas swap ${quoteAmount} SPCX -> ETH (pool ${poolIdOf(poolKey).slice(0, 10)}…): ${tx.hash}`);
    return {
      ...base,
      swapped: true,
      ethReceived: Number(formatEther(received > 0n ? received : 0n)),
      signature: tx.hash,
    };
  } catch (err) {
    const error = err && (err.shortMessage || err.message) ? err.shortMessage || err.message : String(err);
    console.error(`[gasswap] ${error}`);
    return { ...base, error };
  }
}

module.exports = { swapQuoteForGas, describeOutcome, gasPoolKey };
