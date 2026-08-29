'use strict';

const { getDb } = require('./index');

const NO_ID = { projection: { _id: 0 } };

/** Atomic numeric auto-increment, mirroring simple rowids. */
async function nextId(name) {
  const db = getDb();
  const doc = await db.collection('counters').findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  // mongodb v6 returns the document directly; older shapes nest it under .value
  return (doc && doc.seq) ?? (doc && doc.value && doc.value.seq);
}

async function createCycle({ dryRun }) {
  const db = getDb();
  const id = await nextId('cycles');
  await db.collection('cycles').insertOne({
    id,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    phase: null,
    // Amounts are SPCX, the launch's quote asset — there is no ETH in this
    // flow and nothing is ever bought, so no *_eth or *_bought columns.
    quote_claimed: null,
    quote_distributed: null,
    sweep_skipped: 0,
    sweep_reason: null,
    dry_run: dryRun ? 1 : 0,
    note: null,
    error: null,
  });
  return id;
}

/** Set only the provided fields; finished_at defaults to now. */
async function finishCycle(id, fields) {
  const db = getDb();
  const allowed = [
    'status', 'mode', 'phase', 'quote_claimed', 'quote_distributed',
    'eligible_holders', 'total_holders',
    'sweep_skipped', 'sweep_reason',
    'note', 'error',
  ];
  const $set = { finished_at: fields.finished_at ?? new Date().toISOString() };
  for (const key of allowed) {
    if (fields[key] !== undefined) $set[key] = fields[key];
  }
  await db.collection('cycles').updateOne({ id }, { $set });
}

async function addStep({ cycleId, name, status, signature, detail }) {
  const db = getDb();
  const id = await nextId('steps');
  const doc = {
    id,
    cycle_id: cycleId,
    name,
    status,
    signature: signature ?? null,
    detail: detail ?? null,
    created_at: new Date().toISOString(),
  };
  await db.collection('steps').insertOne(doc);
}

async function getCycleWithSteps(id) {
  const db = getDb();
  const cycle = await db.collection('cycles').findOne({ id }, NO_ID);
  if (!cycle) return null;
  const steps = await db
    .collection('steps')
    .find({ cycle_id: id }, NO_ID)
    .sort({ id: 1 })
    .toArray();
  return { ...cycle, steps };
}

async function getCycles(limit, offset) {
  const db = getDb();
  const total = await db.collection('cycles').countDocuments();
  const items = await db
    .collection('cycles')
    .find({}, NO_ID)
    .sort({ id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();
  return { total, items };
}

async function getLastCycle() {
  const db = getDb();
  const last = await db.collection('cycles').find({}, NO_ID).sort({ id: -1 }).limit(1).toArray();
  return last.length ? getCycleWithSteps(last[0].id) : null;
}

async function getStats() {
  const db = getDb();
  const [row] = await db
    .collection('cycles')
    .aggregate([
      {
        $group: {
          _id: null,
          cycles: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'complete'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
          total_quote_distributed: { $sum: { $ifNull: ['$quote_distributed', 0] } },
        },
      },
    ])
    .toArray();

  // Sum claimed SPCX from the claim STEPS, not the cycles: a step is recorded
  // the moment a claim succeeds, while cycles.quote_claimed is only set at
  // finish — a cycle that claims and then fails would silently drop its claim
  // from the total.
  const [claimRow] = await db
    .collection('steps')
    .aggregate([
      { $match: { name: 'claim', status: 'ok' } },
      { $group: { _id: null, quote: { $sum: { $ifNull: ['$detail.quoteClaimed', 0] } } } },
    ])
    .toArray();

  return {
    ...(row || {
      cycles: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      total_quote_distributed: 0,
    }),
    total_quote_claimed: claimRow ? claimRow.quote : 0,
  };
}

async function addAirdrop({ cycleId, rewardToken, recipient, amountRaw, amountUi, signature, status }) {
  const db = getDb();
  const id = await nextId('airdrops');
  const doc = {
    id,
    cycle_id: cycleId,
    reward_token: rewardToken,
    recipient,
    amount_raw: String(amountRaw),
    amount_ui: amountUi ?? null,
    signature: signature ?? null,
    status: status ?? 'ok',
    created_at: new Date().toISOString(),
  };
  await db.collection('airdrops').insertOne(doc);
  return id;
}

// A real on-chain transaction hash. DRY_RUN records airdrops with status 'ok'
// and a fabricated `airdrop_ka9f2x` signature, so status alone cannot tell a
// simulated payout from a real one.
const REAL_TX_HASH = '^0x[0-9a-fA-F]{64}$';

/**
 * One page of real (on-chain) payouts, newest first, for the public feed.
 *
 * The cursor is the numeric row id of the last row served — ids are monotonic,
 * so "older than this" is a plain `$lt`. Simulated DRY_RUN payouts are excluded
 * HERE rather than at the route, so no caller can forget: their fabricated
 * signature fails the real-hash test.
 *
 * @param {number} limit
 * @param {string|number|null} afterId
 * @returns {Promise<{rows: object[], nextCursor: string|null}>}
 */
async function getAirdropPage(limit, afterId = null) {
  const db = getDb();
  const filter = { status: 'ok', signature: { $regex: REAL_TX_HASH } };
  if (afterId !== null && afterId !== undefined && afterId !== '') {
    filter.id = { $lt: Number(afterId) };
  }
  // Fetch one extra row to learn whether a further page exists, without a
  // second count query on every visitor poll.
  const found = await db
    .collection('airdrops')
    .find(filter, NO_ID)
    .sort({ id: -1 })
    .limit(limit + 1)
    .toArray();

  const rows = found.slice(0, limit);
  const more = found.length > limit;
  const last = rows[rows.length - 1];
  return { rows, nextCursor: more && last ? String(last.id) : null };
}

/**
 * Total for ONE reward token, counting only payouts that actually landed on
 * chain. Counting a simulated payout as distributed would inflate the headline
 * number the site shows to visitors, and link them to a nonexistent tx.
 * @returns {Promise<{totalUi:number, sends:number, holders:number}>}
 */
async function getDistributedTotal(rewardToken) {
  const db = getDb();
  const [row] = await db
    .collection('airdrops')
    .aggregate([
      { $match: { reward_token: rewardToken, status: 'ok', signature: { $regex: REAL_TX_HASH } } },
      {
        $group: {
          _id: null,
          sends: { $sum: 1 },
          totalUi: { $sum: { $ifNull: ['$amount_ui', 0] } },
          recipients: { $addToSet: '$recipient' },
        },
      },
      { $project: { _id: 0, sends: 1, totalUi: 1, holders: { $size: '$recipients' } } },
    ])
    .toArray();
  return row || { totalUi: 0, sends: 0, holders: 0 };
}

module.exports = {
  createCycle,
  finishCycle,
  addStep,
  getCycleWithSteps,
  getCycles,
  getLastCycle,
  getStats,
  addAirdrop,
  getAirdropPage,
  getDistributedTotal,
};
