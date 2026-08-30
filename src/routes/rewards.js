'use strict';

// GET /rewards?cursor=<rowId>&limit=<1..50> — the live payout feed.
//
// The site's REWARDS window (RewardsScene.jsx) polls this every 15s with no
// query string and renders `transactions` as one scrollable ledger, so the
// default page is the full 50. Shape, per its mockData.js:
//
//   { "transactions": [{ "id", "wallet", "amount", "txHash", "timestamp" }], ... }
//
// `amount` is an SPCX token amount (the site formats it and appends its own
// reward ticker), `timestamp` is ISO-8601, `txHash` is linked to the Robinhood
// Chain explorer by the site. `symbol`/`txUrl` are deliberately omitted so the
// site's own SITE.rewardTicker / SITE.explorerTxBase apply.
//
// The same page is also returned as `rows` (+ `nextCursor`) for the
// cursor-paging frontends in this lineage — `at` there is epoch ms. See
// services/rewardsfeed.js for where the rows come from.

const express = require('express');
const { getFeedPage, parseCursor } = require('../services/rewardsfeed');

const router = express.Router();

const MAX_LIMIT = 50; // one Blockscout page
const DEFAULT_LIMIT = MAX_LIMIT; // the site asks for "the feed", not a page

/**
 * Pure: query string -> { cursor, limit }. Limit is clamped into 1..MAX and
 * junk falls back to the default; a malformed cursor throws with status 400.
 */
function parseQuery(query = {}) {
  const raw = typeof query.limit === 'string' ? Number(query.limit) : NaN;
  const limit = Number.isFinite(raw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw))) : DEFAULT_LIMIT;

  let cursor = query.cursor;
  if (cursor === undefined || cursor === '') cursor = null;
  parseCursor(cursor); // validates (arrays and garbage included) — throws 400
  return { cursor, limit };
}

/** Pure: a feed row (`at` in epoch ms) -> the site's transaction (ISO `timestamp`). */
function toTransaction(row) {
  return {
    id: row.id,
    wallet: row.wallet,
    amount: row.amount,
    txHash: row.txHash,
    timestamp: row.at === null ? null : new Date(row.at).toISOString(),
  };
}

/** Pure: the cached page -> the response body, serving both shapes. */
function presentPage(page) {
  const transactions = page.rows.map(toTransaction);
  return {
    // Three names for one list, because the frontends in this lineage disagree
    // about which to read and none of them falls back to the others:
    //   `transactions` — the space-inu RewardsScene
    //   `items`        — the space-inu-site rewards feed, which checks
    //                    items -> rewards -> data and would otherwise render
    //                    an empty feed against a perfectly healthy API
    //   `rows`         — the cursor-paging frontends (epoch-ms `at`)
    transactions,
    items: transactions,
    rows: page.rows,
    nextCursor: page.nextCursor,
  };
}

router.get('/rewards', async (req, res) => {
  let q;
  try {
    q = parseQuery(req.query);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  try {
    res.json(presentPage(await getFeedPage(q.cursor, q.limit)));
  } catch (err) {
    // Nothing cached for this page and the upstream is down. A 502 makes the
    // site show its retry state; an empty 200 would read as "no payouts yet".
    console.warn('[spaceinu] rewards feed unavailable:', err.message);
    res.status(502).json({ error: 'rewards feed unavailable' });
  }
});

module.exports = { router, parseQuery, presentPage, DEFAULT_LIMIT, MAX_LIMIT };
