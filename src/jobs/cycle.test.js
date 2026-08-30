'use strict';

process.env.DRY_RUN = 'true';
process.env.REWARD_PCT = '80';
process.env.BURN_PCT = '20';

const test = require('node:test');
const assert = require('node:assert');
const { splitClaim, summarizeReward, isFeeRecipientOk, feeRecipientWarning } = require('./cycle');

test('80/20 sends everything to holders and the buyback, with no dev cut', () => {
  const { rewardQuote, burnQuote, devQuote } = splitClaim(1);
  assert.strictEqual(rewardQuote, 0.8);
  assert.strictEqual(burnQuote, 0.2);
  assert.strictEqual(devQuote, 0, 'the dev cut only appears when the other two total under 100');
});

test('the three legs always re-add to the claim', () => {
  for (const claimed of [0.000001, 0.5, 3.7, 1234.56789]) {
    const { rewardQuote, burnQuote, devQuote } = splitClaim(claimed);
    assert.ok(
      Math.abs(rewardQuote + burnQuote + devQuote - claimed) < 1e-9,
      `legs must sum for ${claimed}`
    );
  }
});

test('splitting nothing yields nothing on every leg', () => {
  assert.deepStrictEqual(splitClaim(0), { rewardQuote: 0, burnQuote: 0, devQuote: 0 });
});

test('a dev cut appears exactly when REWARD_PCT + BURN_PCT falls under 100', () => {
  process.env.REWARD_PCT = '70';
  process.env.BURN_PCT = '20';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
  const { splitClaim: split } = require('./cycle');

  const { rewardQuote, burnQuote, devQuote } = split(10);
  assert.strictEqual(rewardQuote, 7);
  assert.strictEqual(burnQuote, 2);
  assert.strictEqual(devQuote, 1);

  process.env.REWARD_PCT = '80';
  process.env.BURN_PCT = '20';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
});

test('an all-to-holders split leaves nothing to buy back', () => {
  process.env.REWARD_PCT = '100';
  process.env.BURN_PCT = '0';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
  const { splitClaim: split } = require('./cycle');
  assert.deepStrictEqual(split(5), { rewardQuote: 5, burnQuote: 0, devQuote: 0 });

  process.env.REWARD_PCT = '80';
  process.env.BURN_PCT = '20';
  for (const m of ['../config', './cycle']) delete require.cache[require.resolve(m)];
});

test('the fee-recipient check is case-insensitive', () => {
  const launch = { creatorFeeRecipient: '0xABCDEF0000000000000000000000000000000001' };
  assert.strictEqual(isFeeRecipientOk(launch, '0xabcdef0000000000000000000000000000000001'), true);
});

test('a mismatched fee recipient produces a warning naming both addresses', () => {
  const launch = { creatorFeeRecipient: '0x1111111111111111111111111111111111111111' };
  const warning = feeRecipientWarning(launch, '0x2222222222222222222222222222222222222222');
  assert.match(warning, /0x1111111111111111111111111111111111111111/);
  assert.match(warning, /0x2222222222222222222222222222222222222222/);
});

test('the mismatch warning mentions the pons toggle that causes it', () => {
  // The overwhelmingly likely cause is someone switching on pons's
  // holder-fee-sharing, which reassigns creatorFeeRecipient to a distributor.
  // An operator reading this line at 3am should not have to go and find that out.
  const launch = { creatorFeeRecipient: '0x1111111111111111111111111111111111111111' };
  assert.match(feeRecipientWarning(launch, '0x2222222222222222222222222222222222222222'), /distributor|holders/i);
});

test('a matching fee recipient produces no warning at all', () => {
  const launch = { creatorFeeRecipient: '0xabc0000000000000000000000000000000000001' };
  assert.strictEqual(feeRecipientWarning(launch, '0xABC0000000000000000000000000000000000001'), null);
});

test('an unset fee recipient is a mismatch, not a pass', () => {
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: '' }, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk({}, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk(null, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: '0xabc' }, ''), false);
});

test('"nobody was eligible" completes and is not recorded as a failure', () => {
  const out = summarizeReward({ skipped: false, recipients: 0, sent: 0, failed: 0 });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /no eligible holders/);
});

test('"the airdrop reached nobody" is a failure, and says why', () => {
  const out = summarizeReward({ skipped: false, recipients: 40, sent: 0, failed: 40 });
  assert.strictEqual(out.status, 'failed');
  assert.match(out.error, /0 of 40/);
});

test('a partial airdrop completes but records the failures', () => {
  const out = summarizeReward({ skipped: false, recipients: 10, sent: 7, failed: 3 });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /7/);
  assert.match(out.note, /3 failed/);
});

test('a fully delivered airdrop is clean', () => {
  const out = summarizeReward({ skipped: false, recipients: 10, sent: 10, failed: 0 });
  assert.strictEqual(out.status, 'complete');
  assert.strictEqual(out.error, undefined);
});

test('a skipped reward leg completes and carries its reason', () => {
  const out = summarizeReward({ skipped: true, reason: 'reward share of this claim is zero' });
  assert.strictEqual(out.status, 'complete');
  assert.match(out.note, /zero/);
});
