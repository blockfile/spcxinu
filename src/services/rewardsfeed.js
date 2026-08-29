'use strict';

// The rewards feed: individual SPCX payouts to holder wallets, newest first.
//
// Pons publishes only epoch totals for a token's fee distributor — there is no
// per-payout endpoint. But every payout IS an on-chain ERC-20 transfer of the
// reward asset out of the distributor contract, and Blockscout lists an
// address's token transfers with cursor pagination:
//
//   GET {explorerApi}/api/v2/addresses/{distributor}/token-transfers
//       ?type=ERC-20&filter=from&token={rewardToken}[&block_number=&index=]
//   -> { items: [{ transaction_hash, timestamp, block_number, log_index,
//                  to: { hash }, total: { value, decimals } }, …],   (≤50, newest first)
//        next_page_params: { block_number, index, … } | null }
//
// Blockscout's own cursor is just the last item's (block_number, log_index),
// and it accepts ANY item's pair — verified live — so the cursor handed to the
// site is "<block>-<logIndex>" of the last row served, whatever the page size.
// The site asks for 12 rows at a time; Blockscout answers 50; the surplus is
// simply not served (the next cursor points inside that page).
//
// The distributor address comes from the Pons /distributor response the
// rewards service already fetches, unless DISTRIBUTOR_ADDRESS pins it.
// Pre-launch (no token, no distributor) is an empty page, never an error.
// A malformed Blockscout response throws so the per-page cache keeps the last
// good page (see cache.js); a page that never loaded surfaces as a 502 so the
// site shows "retry" instead of "end of feed".

const config = require('./../config');
const { fetchJson } = require('./fetchJson');
const { cachedByKey } = require('./cache');
const { getRewards } = require('./rewards');

const EMPTY_PAGE = { rows: [], nextCursor: null };
const CURSOR_RE = /^(\d+)-(\d+)$/;

function badCursor() {
  const err = new Error('malformed cursor — expected "<block>-<logIndex>"');
  err.status = 400;
  return err;
}

/** Pure: "<block>-<logIndex>" -> { blockNumber, index }; absent -> null; malformed -> throws 400. */
function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string') throw badCursor();
  const m = CURSOR_RE.exec(cursor);
  if (!m) throw badCursor();
  return { blockNumber: Number(m[1]), index: Number(m[2]) };
}

/** Pure: the cursor that continues AFTER this Blockscout item. */
function encodeCursor(item) {
  return `${item.block_number}-${item.log_index}`;
}

/** Pure: Blockscout URL for reward-token transfers out of the distributor, after `cursor`. */
function feedUrl(explorerApi, distributor, token, cursor) {
  const url = new URL(`${explorerApi}/api/v2/addresses/${distributor}/token-transfers`);
  url.searchParams.set('type', 'ERC-20');
  url.searchParams.set('filter', 'from');
  url.searchParams.set('token', token);
  if (cursor) {
    url.searchParams.set('block_number', String(cursor.blockNumber));
    url.searchParams.set('index', String(cursor.index));
  }
  return url.toString();
}

const toNumber = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Pure: one Blockscout transfer -> the row the site renders, or null if the
 * item lacks its essentials (a burn with no `to`, a non-numeric value) — one
 * odd transfer must not poison the whole page.
 */
function toRow(item, fallbackDecimals) {
  if (!item || typeof item !== 'object') return null;
  const txHash = item.transaction_hash ?? item.tx_hash;
  const wallet = item.to && item.to.hash;
  const value = item.total && item.total.value;
  if (typeof txHash !== 'string' || typeof wallet !== 'string') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;

  const decimals = toNumber(item.total.decimals) ?? toNumber(item.token && item.token.decimals) ?? fallbackDecimals;
  const at = Date.parse(item.timestamp);
  return {
    // One payout tx moves tokens to many wallets, so the hash alone is not unique.
    id: `${txHash}-${item.log_index}`,
    amount: Number(BigInt(value)) / 10 ** decimals,
    wallet,
    txHash,
    at: Number.isFinite(at) ? at : null, // epoch ms
  };
}

/**
 * Pure: a Blockscout token-transfers response -> { rows, nextCursor } for the
 * site. Serves at most `limit` rows; there is more when Blockscout returned
 * more than that or reported a further page of its own.
 */
function pageFeed(data, limit, fallbackDecimals) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    const hint = data && typeof data === 'object' ? JSON.stringify(data) : String(data);
    throw new Error(`malformed token-transfers response: ${hint.slice(0, 80)}`);
  }
  const slice = data.items.slice(0, limit);
  const rows = slice.map((it) => toRow(it, fallbackDecimals)).filter(Boolean);
  const more = data.items.length > limit || data.next_page_params != null;
  const last = slice[slice.length - 1];
  const canContinue = more && last && toNumber(last.block_number) !== null && toNumber(last.log_index) !== null;
  return { rows, nextCursor: canContinue ? encodeCursor(last) : null };
}

/** The distributor whose outflows are the payouts: pinned by env, else from Pons. */
async function resolveDistributor() {
  if (config.distributorAddress) return config.distributorAddress;
  if (!config.tokenAddress) return null; // pre-launch: nothing to ask about
  const { distributor } = await getRewards();
  return distributor || null;
}

async function fetchFeedPage({ cursor = null, limit }) {
  const distributor = await resolveDistributor();
  if (!distributor || !config.rewardTokenAddress) return EMPTY_PAGE;
  const url = feedUrl(config.explorerApi, distributor, config.rewardTokenAddress, parseCursor(cursor));
  const data = await fetchJson(url, { headers: { accept: 'application/json' } });
  return pageFeed(data, limit, config.rewardDecimals);
}

// Cached per (cursor, limit). On failure the last good page keeps being served (see cache.js).
const pages = cachedByKey(config.feedTtlMs, (cursor, limit) => fetchFeedPage({ cursor, limit }));
const getFeedPage = (cursor, limit) => pages(`${cursor ?? ''}|${limit}`, cursor, limit);

module.exports = { getFeedPage, fetchFeedPage, pageFeed, parseCursor, encodeCursor, feedUrl, EMPTY_PAGE };
