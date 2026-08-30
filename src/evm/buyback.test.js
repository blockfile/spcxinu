'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { applySlippage, describeOutcome, buybackAndBurn } = require('./buyback');
const { permit2AllowanceIsSufficient, MAX_UINT160, EXPIRY_MARGIN_SEC } = require('./permit2');

// ── slippage ───────────────────────────────────────────────────────────────

test('slippage lowers the minimum output by the configured percent', () => {
  assert.strictEqual(applySlippage(10000n, 5), 9500n);
  assert.strictEqual(applySlippage(10000n, 1), 9900n);
});

test('zero slippage demands the whole quote', () => {
  assert.strictEqual(applySlippage(10000n, 0), 10000n);
});

test('fractional slippage is honoured to two decimals', () => {
  assert.strictEqual(applySlippage(1000000n, 0.5), 995000n);
});

test('a nonsensical slippage is refused rather than silently accepting any price', () => {
  // 100% slippage means minimumOut = 0, i.e. accept literally anything back.
  assert.throws(() => applySlippage(1000n, 100), /SLIPPAGE_PCT/);
  assert.throws(() => applySlippage(1000n, -1), /SLIPPAGE_PCT/);
});

// ── outcome reporting ──────────────────────────────────────────────────────

test('a completed buyback reports what was bought and burned', () => {
  const out = describeOutcome({ burned: true, bought: true, tokensBought: 1234, quoteSpent: 2 });
  assert.match(out, /1234/);
  assert.match(out, /burned/);
});

test('a bought-but-not-burned outcome says the tokens are in the wallet', () => {
  // This is the dangerous middle state: real money was spent, so it must not
  // read like a clean failure.
  const out = describeOutcome({ bought: true, burned: false, tokensBought: 99, error: 'burn reverted' });
  assert.match(out, /BURN failed/);
  assert.match(out, /wallet/);
});

test('a failed buy says the SPCX is retried next cycle', () => {
  const out = describeOutcome({ bought: false, burned: false, error: 'quoted zero' });
  assert.match(out, /quoted zero/);
  assert.match(out, /next cycle/);
});

test('a zero burn share is a clean skip', () => {
  const out = describeOutcome({ skipped: true, reason: 'burn share of this claim is zero' });
  assert.match(out, /skipped/);
});

// ── the leg itself, in DRY_RUN ─────────────────────────────────────────────

test('a zero burn share never touches a venue', async () => {
  const r = await buybackAndBurn({ launch: {}, quoteAmount: 0 });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.bought, false);
  assert.strictEqual(r.burned, false);
});

test('DRY_RUN simulates a full buy and burn without a chain', async () => {
  const r = await buybackAndBurn({ launch: { token: '0xabc', graduated: true }, quoteAmount: 2 });
  assert.strictEqual(r.bought, true);
  assert.strictEqual(r.burned, true);
  assert.ok(r.tokensBought > 0);
  assert.strictEqual(r.quoteSpent, 2);
  assert.match(r.buySignature, /^buyback_/);
  assert.match(r.burnSignature, /^burn_/);
});

// ── Permit2 allowance freshness ────────────────────────────────────────────

const NOW = 1_800_000_000;

test('a large, long-lived Permit2 allowance is sufficient', () => {
  const ok = permit2AllowanceIsSufficient({
    amount: MAX_UINT160,
    expiration: NOW + 86400,
    needed: 10n ** 18n,
    nowSec: NOW,
  });
  assert.strictEqual(ok, true);
});

test('an allowance smaller than the swap is not sufficient', () => {
  const ok = permit2AllowanceIsSufficient({ amount: 5n, expiration: NOW + 86400, needed: 10n, nowSec: NOW });
  assert.strictEqual(ok, false);
});

test('an EXPIRED Permit2 allowance is not sufficient, however large', () => {
  // The classic failure: the amount looks fine, but Permit2 allowances carry a
  // uint48 expiry and silently stop working when it lapses.
  const ok = permit2AllowanceIsSufficient({
    amount: MAX_UINT160,
    expiration: NOW - 1,
    needed: 1n,
    nowSec: NOW,
  });
  assert.strictEqual(ok, false);
});

test('an allowance expiring within the margin is refreshed early', () => {
  const ok = permit2AllowanceIsSufficient({
    amount: MAX_UINT160,
    expiration: NOW + EXPIRY_MARGIN_SEC - 1,
    needed: 1n,
    nowSec: NOW,
  });
  assert.strictEqual(ok, false, 'must not swap into an allowance about to lapse');
});

test('expiration 0 means "no allowance", not "never expires"', () => {
  const ok = permit2AllowanceIsSufficient({ amount: MAX_UINT160, expiration: 0, needed: 1n, nowSec: NOW });
  assert.strictEqual(ok, false);
});
