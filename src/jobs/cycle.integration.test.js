'use strict';

// A whole cycle, end to end, against an in-memory MongoDB.
//
// The unit tests cover the pure decisions in isolation; this covers the thing
// that actually matters — that a claim becomes recorded payouts, that the
// amounts add up exactly, and that a dry run needs no network at all.

process.env.DRY_RUN = 'true';
process.env.REWARD_PCT = '80';
process.env.TOKEN_ADDRESS = '0x50d0d0da00ffd195d2d1d2448617ad039855ad2b';
process.env.TOKEN_SYMBOL = 'SPACEINU';
process.env.TOKEN_DECIMALS = '18';
process.env.MIN_HOLD = '100000';
process.env.WALLET_PRIVATE_KEY = '';

const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let db;
let repo;
let runCycle;
let simvault;
let config;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'spaceinu_cycle_test';
  for (const m of ['../config', '../db/index', '../db/repository', './cycle', '../evm/simvault']) {
    delete require.cache[require.resolve(m)];
  }
  config = require('../config');
  db = require('../db');
  repo = require('../db/repository');
  simvault = require('../evm/simvault');
  ({ runCycle } = require('./cycle'));
  await db.connect();
});

test.after(async () => {
  await db.close();
  await mongod.stop();
});

test('an empty vault completes as skipped, not as a failure', async () => {
  simvault.reset(0);
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'skipped');
  assert.strictEqual(cycle.note, 'nothing claimed');
  assert.strictEqual(cycle.quote_claimed, 0);
});

test('a funded vault claims, splits and airdrops to holders', async () => {
  simvault.reset(10); // 10 SPCX accrued
  const cycle = await runCycle();

  assert.strictEqual(cycle.status, 'complete', cycle.error || '');
  assert.strictEqual(cycle.quote_claimed, 10);
  assert.strictEqual(cycle.quote_distributed, 8, '80% goes to holders');

  const names = cycle.steps.map((s) => s.name);
  assert.deepStrictEqual(names, ['sweep', 'claim', 'airdrop'], 'no buy step exists in this bot');

  const airdropStep = cycle.steps.find((s) => s.name === 'airdrop');
  assert.strictEqual(airdropStep.status, 'ok');
  assert.ok(airdropStep.detail.sent > 0, 'the simulated holders were paid');
});

test('the vault is drained by the claim, so the next cycle finds nothing', async () => {
  simvault.reset(5);
  await runCycle();
  assert.strictEqual(simvault.peek(), 0, 'claiming empties the escrow');
  const next = await runCycle();
  assert.strictEqual(next.status, 'skipped');
});

test('recorded payouts sum EXACTLY to the amount distributed — no dust', async () => {
  simvault.reset(3.7); // deliberately not a round number
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'complete', cycle.error || '');

  const { rows } = await repo.getAirdropPage(500, null);
  const mine = rows.filter((r) => r.cycle_id === cycle.id);
  // DRY_RUN payouts carry a fabricated signature, so they are correctly absent
  // from the public page. Read them straight from the collection instead.
  assert.strictEqual(mine.length, 0, 'simulated payouts must never reach the public feed');

  const all = await db.getDb().collection('airdrops').find({ cycle_id: cycle.id }).toArray();
  assert.ok(all.length > 0, 'the payouts were still recorded for the operator');

  const decimals = config.rewardDecimals;
  const totalRaw = all.reduce((sum, r) => sum + BigInt(r.amount_raw), 0n);
  const expectedRaw = BigInt(Math.round(3.7 * 0.8 * 10 ** 9)) * 10n ** BigInt(decimals - 9);
  assert.strictEqual(totalRaw, expectedRaw, 'allocations must sum to the distributed amount exactly');
});

test('a dry run makes no network call — it completed with no RPC reachable', async () => {
  // The preceding tests all ran with DRY_RUN=true and no RPC available. If any
  // path had reached for the chain (decimals(), balanceOf(), getBalance()) they
  // would have hung or thrown rather than completing.
  assert.strictEqual(config.dryRun, true);
  simvault.reset(1);
  const cycle = await runCycle();
  assert.notStrictEqual(cycle.status, 'failed', cycle.error || '');
});
