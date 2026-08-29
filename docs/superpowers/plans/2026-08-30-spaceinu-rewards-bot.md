# Spaceinu Rewards Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge a creator-fee reward bot into `spaceinu-api` so it claims SPACEINU's SPCX-denominated creator fees from the Pons V2 fee escrow and airdrops them pro-rata to SPACEINU holders, while the existing public API reports what it did.

**Architecture:** One repository, two processes over one MongoDB. `server.js` stays the read-only public API and never loads a private key. A new `bot.js` holds the wallet, runs the cron scheduler, and exposes operator endpoints bound to `127.0.0.1`. Fees arrive already denominated in SPCX (the launch's quote asset), so there is no swap anywhere — the cycle is sweep → `claimToken(SPCX)` → split → airdrop.

**Tech Stack:** Node.js >= 20, CommonJS, Express 4, ethers v6, mongodb v6, node-cron, `node --test`.

## Global Constraints

- Node `>= 20`, CommonJS (`"type": "commonjs"`), 2-space indent, `'use strict';` at the top of every file.
- Every new module starts with a comment explaining **why** it exists, matching the density of the existing `src/services/*.js` files.
- `DRY_RUN=true` is the default everywhere. Every code path that sends a transaction must have a simulated branch.
- **A value that cannot be sourced is `null`, never `0`.** The site hides a null tile and would render a `0` as real.
- **Public endpoints must filter payouts on a real transaction hash** (`/^0x[0-9a-fA-F]{64}$/`). DRY_RUN records airdrops with `status: 'ok'` and a fabricated signature; serving those would publish invented rewards.
- Reward asset and quote asset are the same address: `config.rewardTokenAddress` (SPCX, `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea`, 18 decimals). Never introduce a second key for it.
- `PONS_API` must stay — `curvemarket.js` uses it for the bonding-curve chart.
- Tests use `node --test` and must not touch the network. Run with `npm test` from `d:\projects\spaceinu-api`.
- Source repo to port from: `d:\projects\babyrobbie` (referred to below as `$BR`).
- Work on branch `spaceinu-rewards-bot`. Do not push.

---

### Task 1: Bot dependencies and config

**Files:**
- Modify: `package.json`
- Modify: `src/config.js`
- Test: `src/config.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `config.dryRun` (bool), `config.rpcUrl` (string), `config.chainId` (number), `config.wallet` (ethers Wallet | null), `config.walletIsEphemeral` (bool), `config.v2Factory`/`memeHook`/`feeEscrow`/`buybackVault`/`poolManager` (lowercased strings), `config.rewardPct` (number), `config.devPct` (number), `config.minHold` (number), `config.rewardCapPct` (number), `config.clusters` (array), `config.airdropBatchSize` (number), `config.airdropGasLimit` (number), `config.disperseAddress` (string|null), `config.airdropExclude` (string[]), `config.triggerMode` ('accumulation'|'interval'), `config.pollSchedule` (string), `config.claimEveryUsd` (number), `config.gasReserveEth` (number), `config.mongoUri`, `config.mongoDb`, `config.apiKey` (string|null), `config.botPort` (number), `config.dryRunFeePerPoll` (number).

- [ ] **Step 1: Install the bot's runtime dependencies**

```bash
cd /d/projects/spaceinu-api
npm install ethers@^6.13.5 mongodb@^6.12.0 node-cron@^3.0.3
npm install --save-dev mongodb-memory-server@^10.1.4
```

- [ ] **Step 2: Add the bot scripts to `package.json`**

Change the `"scripts"` block to:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "bot": "node bot.js",
    "bot:dev": "node --watch bot.js",
    "test": "node --test",
    "check": "node scripts/check.js"
  },
```

- [ ] **Step 3: Write the failing config test**

Create `src/config.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// config reads process.env at require time, so each case re-requires it.
function loadConfig(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve('./config')];
  return require('./config');
}

test('the split is REWARD_PCT with the remainder as the dev cut', () => {
  const config = loadConfig({ REWARD_PCT: '80', DRY_RUN: 'true' });
  assert.strictEqual(config.rewardPct, 80);
  assert.strictEqual(config.devPct, 20);
});

test('a fractional split leaves no floating-point dust in the dev cut', () => {
  const config = loadConfig({ REWARD_PCT: '80.1', DRY_RUN: 'true' });
  assert.strictEqual(config.devPct, 19.9); // not 19.900000000000006
});

test('an out-of-range split is rejected outright', () => {
  assert.throws(() => loadConfig({ REWARD_PCT: '140', DRY_RUN: 'true' }), /REWARD_PCT/);
});

test('the trigger defaults to a 100 USD accumulation gate', () => {
  const config = loadConfig({ REWARD_PCT: '80', DRY_RUN: 'true' });
  assert.strictEqual(config.triggerMode, 'accumulation');
  assert.strictEqual(config.claimEveryUsd, 100);
});

test('an unknown TRIGGER_MODE falls back to accumulation rather than throwing', () => {
  const config = loadConfig({ TRIGGER_MODE: 'nonsense', DRY_RUN: 'true' });
  assert.strictEqual(config.triggerMode, 'accumulation');
});

test('DRY_RUN generates an ephemeral wallet when no key is set', () => {
  process.env.WALLET_PRIVATE_KEY = '';
  const config = loadConfig({ DRY_RUN: 'true' });
  assert.ok(config.wallet);
  assert.strictEqual(config.walletIsEphemeral, true);
});

test('a live run with no key is refused', () => {
  process.env.WALLET_PRIVATE_KEY = '';
  assert.throws(() => loadConfig({ DRY_RUN: 'false' }), /WALLET_PRIVATE_KEY/);
  process.env.DRY_RUN = 'true';
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npm test -- src/config.test.js`
Expected: FAIL — `config.rewardPct` is undefined.

- [ ] **Step 5: Extend `src/config.js`**

Keep everything already in the file. Add these requires at the top, after `require('dotenv').config();`:

```js
const { Wallet } = require('ethers');
```

Add these helpers next to the existing `num` / `lowerOrNull`:

```js
function bool(v, d) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
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
// with a throwaway address.
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

const rewardPct = num(process.env.REWARD_PCT, 80);
if (!(rewardPct >= 0 && rewardPct <= 100)) {
  throw new Error(`invalid split: REWARD_PCT(${rewardPct}) must be within [0, 100]`);
}
// The dev cut is the remainder. toFixed(6) keeps a fractional share from
// leaving float dust behind (100 - 80.1 is 19.900000000000006 in FP).
const devPct = +(100 - rewardPct).toFixed(6);

const triggerMode = ['interval', 'accumulation'].includes(String(process.env.TRIGGER_MODE || '').toLowerCase())
  ? String(process.env.TRIGGER_MODE).toLowerCase()
  : 'accumulation';
```

Then add these entries inside the exported `config` object:

```js
  // ── Bot: chain access ──────────────────────────────────────────────────────
  dryRun: DRY_RUN,
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  wallet,
  walletIsEphemeral,

  // pons v2 wiring (verified on chain; all overridable).
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
  // this balance a cycle refuses to start rather than failing after claiming.
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.01),

  // ── Bot: storage and control ───────────────────────────────────────────────
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'spaceinu',
  apiKey: process.env.API_KEY || null,
  botPort: num(process.env.BOT_PORT, 3100),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/config.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 7: Run the whole suite to prove nothing regressed**

Run: `npm test`
Expected: PASS — the existing API tests still pass.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/config.js src/config.test.js
git commit -m "Add the reward bot's configuration to spaceinu-api"
```

---

### Task 2: MongoDB storage layer

**Files:**
- Create: `src/db/index.js`, `src/db/repository.js`, `src/events.js`
- Test: `src/db/repository.test.js`

**Interfaces:**
- Consumes: `config.mongoUri`, `config.mongoDb` from Task 1.
- Produces: `db.connect()`, `db.getDb()`, `db.close()`; `repo.createCycle({dryRun}) -> id`, `repo.finishCycle(id, fields)`, `repo.addStep({cycleId,name,status,signature,detail})`, `repo.getCycleWithSteps(id)`, `repo.getCycles(limit,offset)`, `repo.getLastCycle()`, `repo.addAirdrop({cycleId,rewardToken,recipient,amountRaw,amountUi,signature,status}) -> id`, `repo.getStats()`, `repo.getDistributedTotal(rewardToken) -> {totalUi,sends,holders}`, `repo.getAirdropPage(limit, afterId) -> {rows, nextCursor}`.

- [ ] **Step 1: Port the three files unchanged in structure**

```bash
mkdir -p /d/projects/spaceinu-api/src/db
cp /d/projects/babyrobbie/src/events.js /d/projects/spaceinu-api/src/events.js
cp /d/projects/babyrobbie/src/db/index.js /d/projects/spaceinu-api/src/db/index.js
cp /d/projects/babyrobbie/src/db/repository.js /d/projects/spaceinu-api/src/db/repository.js
```

In `src/db/index.js`, add an index the feed needs, inside the existing `Promise.all` in `connect()`:

```js
    db.collection('airdrops').createIndex({ id: -1 }),
    db.collection('airdrops').createIndex({ reward_token: 1, status: 1 }),
```

In `src/db/repository.js`, delete `getAllSteps`, `getAirdrops` and `getAirdropTotals` (this project's public feed reads only real payouts, and there is no operator dashboard listing simulated ones). Keep `getDistributedTotal` — it already filters on a real transaction hash.

- [ ] **Step 2: Write the failing repository test**

Create `src/db/repository.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let db;
let repo;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'spaceinu_test';
  process.env.DRY_RUN = 'true';
  delete require.cache[require.resolve('../config')];
  db = require('./index');
  repo = require('./repository');
  await db.connect();
});

test.after(async () => {
  await db.close();
  await mongod.stop();
});

const REAL_TX = '0x' + 'a'.repeat(64);

test('a page of airdrops comes back newest-first with a cursor', async () => {
  const cycleId = await repo.createCycle({ dryRun: false });
  for (let i = 0; i < 3; i += 1) {
    await repo.addAirdrop({
      cycleId, rewardToken: '0xspcx', recipient: `0xholder${i}`,
      amountRaw: '1000', amountUi: 1.5, signature: REAL_TX, status: 'ok',
    });
  }

  const page = await repo.getAirdropPage(2, null);
  assert.strictEqual(page.rows.length, 2);
  assert.ok(page.rows[0].id > page.rows[1].id, 'newest first');
  assert.strictEqual(page.nextCursor, String(page.rows[1].id));

  const next = await repo.getAirdropPage(2, page.nextCursor);
  assert.strictEqual(next.rows.length, 1);
  assert.strictEqual(next.nextCursor, null, 'no cursor once the feed is exhausted');
});

test('the distributed total counts only payouts with a real tx hash', async () => {
  const cycleId = await repo.createCycle({ dryRun: true });
  await repo.addAirdrop({
    cycleId, rewardToken: '0xsim', recipient: '0xa',
    amountRaw: '1', amountUi: 99, signature: 'airdrop_ka9f2x', status: 'ok',
  });
  const totals = await repo.getDistributedTotal('0xsim');
  assert.strictEqual(totals.totalUi, 0, 'a simulated payout must never be counted');
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- src/db/repository.test.js`
Expected: FAIL — `repo.getAirdropPage is not a function`.

- [ ] **Step 4: Add `getAirdropPage` to `src/db/repository.js`**

```js
/**
 * One page of real (on-chain) payouts, newest first, for the public feed.
 *
 * Cursor is the numeric row id of the last row served — ids are monotonic, so
 * "older than this" is a plain `$lt`. Simulated DRY_RUN payouts are excluded
 * here rather than at the route, so no caller can forget: their fabricated
 * `airdrop_ka9f2x` signature fails the real-hash test.
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
  // Fetch one extra row to learn whether a further page exists.
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
```

Export it by adding `getAirdropPage,` to `module.exports`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/db/repository.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/db src/events.js
git commit -m "Add MongoDB storage for cycles, steps and airdrops"
```

---

### Task 3: EVM plumbing

**Files:**
- Create: `src/evm/abi.js`, `src/evm/provider.js`, `src/evm/erc20.js`, `src/evm/pool.js`, `src/evm/launch.js`, `src/evm/send.js`, `src/evm/exclude.js`, `src/evm/simvault.js`
- Test: `src/evm/pool.test.js`, `src/evm/send.test.js`, `src/evm/exclude.test.js`

**Interfaces:**
- Consumes: Task 1 config.
- Produces: `provider`, `wallet`, `walletAddress()`; `erc20(addr, runner)`, `getDecimals(addr)`, `readTokenBalance(token, owner)`, `getTokenSupplyRaw(token)`; `buildPoolKey({token,quoteToken,fee,tickSpacing,hooks})`, `poolIdOf(key)`, `NATIVE`; `getLaunch(token?)`, `describePhase(launch)`; `sendTx(fn, opts)`, `isNonceError(err)`; `buildExcludeSet(launch)`; `simvault.accrue/peek/drain/reset`.

- [ ] **Step 1: Copy the eight modules and their tests**

```bash
mkdir -p /d/projects/spaceinu-api/src/evm
cd /d/projects/babyrobbie/src/evm
cp abi.js provider.js erc20.js pool.js launch.js send.js exclude.js simvault.js /d/projects/spaceinu-api/src/evm/
cp pool.test.js send.test.js exclude.test.js /d/projects/spaceinu-api/src/evm/
```

- [ ] **Step 2: Add the token-claim fragments to `src/evm/abi.js`**

Replace the `ESCROW_ABI` constant with:

```js
// V2FeeEscrow. `claimToken` is OVERLOADED on the deployed contract
// (`claimToken(address)` and `claimToken(address,uint256)`); only the one-arg
// form is declared here so ethers has nothing to disambiguate. Balances are
// per-recipient ACROSS ALL LAUNCHES, not per token.
const ESCROW_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfToken(address, address) view returns (uint256)',
  'function claim() returns (uint256)',
  'function claimToken(address token) returns (uint256)',
  'event Claimed(address indexed recipient, uint256 amount)',
  'event ClaimedToken(address indexed recipient, address indexed token, uint256 amount)',
];
```

- [ ] **Step 3: Rebrand the log prefixes**

In every file just copied, replace `[babyrobbie]` with `[spaceinu]`. In `src/evm/launch.js`, change the two `TOKEN_ADDRESS (BABY ROBBIE) is required` messages to `TOKEN_ADDRESS (SPACEINU) is required`.

```bash
cd /d/projects/spaceinu-api/src/evm
sed -i 's/\[babyrobbie\]/[spaceinu]/g; s/TOKEN_ADDRESS (BABY ROBBIE)/TOKEN_ADDRESS (SPACEINU)/g' *.js
```

- [ ] **Step 4: Make `simvault` token-denominated**

In `src/evm/simvault.js`, the module comment says fees accrue "in the token's V3 LP position", which is wrong for this project. Replace the header comment with:

```js
// In-memory simulated fee vault, used ONLY in DRY_RUN so the trigger and the
// cycle can be exercised without real fees. Amounts are SPCX, not ETH: this
// launch is quoted in SPCX, so that is what the escrow pays out. Live mode
// never touches this — real fees accrue on the curve or the V2MemeHook and
// reach the escrow via a sweep.
```

Rename the internal variable `balanceEth` to `balanceQuote` throughout the file (4 occurrences).

- [ ] **Step 5: Run the ported tests**

Run: `npm test -- src/evm/pool.test.js src/evm/send.test.js src/evm/exclude.test.js`
Expected: PASS. If `exclude.test.js` references `config.rewardToken`, change it to `config.rewardTokenAddress`.

- [ ] **Step 6: Fix `exclude.js` for this project's config key**

`src/evm/exclude.js` refers to `config.rewardToken`, which does not exist here. Change that one line to:

```js
  add(config.rewardTokenAddress); // the reward token contract itself
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/evm
git commit -m "Port the EVM plumbing: provider, ABIs, launch record, pool keys, nonce-safe sends"
```

---

### Task 4: Claim SPCX from the fee escrow

**Files:**
- Create: `src/evm/escrow.js`
- Test: `src/evm/escrow.test.js`

**Interfaces:**
- Consumes: `config.feeEscrow`, `config.rewardTokenAddress`, `config.dryRun`, `provider`, `wallet`, `ESCROW_ABI`, `simvault`.
- Produces: `escrowBalanceQuote() -> Promise<number>`, `claimQuoteFromEscrow() -> Promise<{signature, quoteClaimed, simulated}>`, `parseClaimedAmount(logs, escrowAddress, wallet, token) -> bigint`, `escrow(runner)`.

This is the one genuinely new piece of chain code. babyrobbie's escrow module is native-ETH only: it calls `claim()` and reads `balanceOf`, both of which return zero for a SPCX-quoted launch.

- [ ] **Step 1: Write the failing test**

Create `src/evm/escrow.test.js`:

```js
'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { Interface } = require('ethers');
const { parseClaimedAmount } = require('./escrow');
const { ESCROW_ABI } = require('./abi');

const IFACE = new Interface(ESCROW_ABI);
const ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e';
const ME = '0x1111111111111111111111111111111111111111';
const SOMEONE_ELSE = '0x2222222222222222222222222222222222222222';
const SPCX = '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea';
const OTHER_TOKEN = '0x3333333333333333333333333333333333333333';

/** Build a ClaimedToken log the way the chain would emit it. */
function claimedTokenLog({ address = ESCROW, recipient, token, amount }) {
  const encoded = IFACE.encodeEventLog('ClaimedToken', [recipient, token, amount]);
  return { address, topics: encoded.topics, data: encoded.data };
}

test('sums the amount from our own ClaimedToken event', () => {
  const logs = [claimedTokenLog({ recipient: ME, token: SPCX, amount: 1500n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, SPCX), 1500n);
});

test('ignores a ClaimedToken for a different recipient', () => {
  const logs = [claimedTokenLog({ recipient: SOMEONE_ELSE, token: SPCX, amount: 999n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, SPCX), 0n);
});

test('ignores a ClaimedToken for a different token', () => {
  const logs = [claimedTokenLog({ recipient: ME, token: OTHER_TOKEN, amount: 999n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, SPCX), 0n);
});

test('ignores an identical event emitted by another contract', () => {
  const logs = [claimedTokenLog({ address: SOMEONE_ELSE, recipient: ME, token: SPCX, amount: 999n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, SPCX), 0n);
});

test('address comparison is case-insensitive', () => {
  const logs = [claimedTokenLog({ recipient: ME, token: SPCX, amount: 7n })];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW.toUpperCase(), ME.toUpperCase(), SPCX.toUpperCase()), 7n);
});

test('an unrelated log in the receipt does not break parsing', () => {
  const logs = [
    { address: SOMEONE_ELSE, topics: ['0x' + 'ff'.repeat(32)], data: '0x' },
    claimedTokenLog({ recipient: ME, token: SPCX, amount: 42n }),
  ];
  assert.strictEqual(parseClaimedAmount(logs, ESCROW, ME, SPCX), 42n);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/evm/escrow.test.js`
Expected: FAIL — cannot find module `./escrow`.

- [ ] **Step 3: Write `src/evm/escrow.js`**

```js
'use strict';

// The V2FeeEscrow is where BOTH phases deliver the creator's share. For this
// launch that share is SPCX, not native ETH: pons pays creator fees in whatever
// the launch is priced in, and SPACEINU is priced in SPCX. So every read and
// write here is the TOKEN path — `balanceOfToken` / `claimToken` — and the
// native `balanceOf` / `claim` pair is deliberately unused. Calling the native
// one would silently return zero and the bot would never fire.
//
// The claimed amount comes from the contract's own ClaimedToken event rather
// than a balance delta, so a transfer landing in the same block cannot inflate
// it. Escrow balances are per-recipient ACROSS ALL LAUNCHES, so this collects
// the wallet's SPCX from every launch it is the fee recipient of.

const { Contract, Interface, formatUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { ESCROW_ABI } = require('./abi');
const simvault = require('./simvault');

const ESCROW_IFACE = new Interface(ESCROW_ABI);
const CLAIMED_TOKEN_TOPIC = ESCROW_IFACE.getEvent('ClaimedToken').topicHash;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function escrow(runner = provider) {
  return new Contract(config.feeEscrow, ESCROW_ABI, runner);
}

/**
 * Pure: total credited to `recipient` for `token` by this receipt's logs.
 *
 * Filters on all three of emitting contract, recipient and token. `recipient`
 * and `token` are both indexed, so they arrive as topics; only `amount` is in
 * data. Anything else in the receipt is ignored rather than throwing — one
 * unrelated log must not fail a claim that already happened on chain.
 *
 * @param {readonly object[]} logs receipt logs
 * @param {string} escrowAddress
 * @param {string} recipient
 * @param {string} token
 * @returns {bigint}
 */
function parseClaimedAmount(logs, escrowAddress, recipient, token) {
  const wantEscrow = String(escrowAddress).toLowerCase();
  const wantRecipient = String(recipient).toLowerCase();
  const wantToken = String(token).toLowerCase();

  let claimed = 0n;
  for (const log of logs || []) {
    if (String(log.address).toLowerCase() !== wantEscrow) continue;
    if (!log.topics || log.topics[0] !== CLAIMED_TOKEN_TOPIC) continue;
    let parsed;
    try {
      parsed = ESCROW_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch (_err) {
      continue; // not ours to read
    }
    if (String(parsed.args.recipient).toLowerCase() !== wantRecipient) continue;
    if (String(parsed.args.token).toLowerCase() !== wantToken) continue;
    claimed += parsed.args.amount;
  }
  return claimed;
}

/** SPCX already swept into the escrow and withdrawable right now, in whole tokens. */
async function escrowBalanceQuote() {
  if (config.dryRun) return simvault.peek();
  const raw = await escrow().balanceOfToken(wallet.address, config.rewardTokenAddress);
  return Number(formatUnits(raw, config.rewardDecimals));
}

/** Withdraw the whole SPCX escrow balance. Amount comes from the ClaimedToken event. */
async function claimQuoteFromEscrow() {
  if (config.dryRun) {
    const quoteClaimed = +simvault.drain().toFixed(9);
    return { signature: fakeSig('claim'), quoteClaimed, simulated: true };
  }

  const balance = await escrow().balanceOfToken(wallet.address, config.rewardTokenAddress);
  if (balance <= 0n) {
    return { signature: null, quoteClaimed: 0, simulated: false, note: 'escrow empty' };
  }

  const tx = await escrow(wallet).claimToken(config.rewardTokenAddress);
  const receipt = await tx.wait();
  console.log(`[tx] claimToken(SPCX) from fee escrow: ${tx.hash}`);

  const claimed = parseClaimedAmount(receipt.logs, config.feeEscrow, wallet.address, config.rewardTokenAddress);
  return {
    signature: tx.hash,
    quoteClaimed: Number(formatUnits(claimed, config.rewardDecimals)),
    simulated: false,
  };
}

module.exports = { escrowBalanceQuote, claimQuoteFromEscrow, parseClaimedAmount, escrow };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/evm/escrow.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/evm/escrow.js src/evm/escrow.test.js
git commit -m "Claim SPCX from the fee escrow via claimToken, not the native claim"
```

---

### Task 5: Sweep pending fees

**Files:**
- Create: `src/evm/sweep.js`
- Test: `src/evm/sweep.test.js`

**Interfaces:**
- Consumes: `getLaunch` output, `config.dryRun`, `simvault`.
- Produces: `sweepableQuote(launch) -> Promise<number>`, `sweepableRaw(launch) -> Promise<bigint>`, `sweepFees(launch) -> Promise<{swept,skipped,reason,signature}>`, `creatorShareRaw(pendingRaw, bps)`, `isOperatorOnlyError(err)`.

babyrobbie's sweep already passes `launch.pairToken` as the quote currency, so its math is correct for a SPCX-quoted launch as-is. Only the ETH-named formatter changes.

- [ ] **Step 1: Copy the module and its test**

```bash
cp /d/projects/babyrobbie/src/evm/sweep.js /d/projects/spaceinu-api/src/evm/sweep.js
cp /d/projects/babyrobbie/src/evm/sweep.test.js /d/projects/spaceinu-api/src/evm/sweep.test.js
```

- [ ] **Step 2: Replace the ETH-denominated reader with a token-denominated one**

In `src/evm/sweep.js`, change the import line `const { formatEther } = require('ethers');` to use `formatUnits`, and replace the `sweepableEth` function with:

```js
/** Pending fees, in whole SPCX. Named for the quote asset because that is what
 *  this launch pays in — there is no ETH anywhere in this path. */
async function sweepableQuote(launch) {
  return Number(formatUnits(await sweepableRaw(launch), config.rewardDecimals));
}
```

Update `module.exports` to export `sweepableQuote` instead of `sweepableEth`.

- [ ] **Step 3: Point the DRY_RUN branch at the simulated vault**

The existing DRY_RUN branch of `sweepFees` calls `simvault.accrue(config.dryRunFeePerPoll)`. Leave it, but note the scheduler also accrues per tick — that double-accrual is a known babyrobbie quirk. Delete the accrue call from `sweepFees` so DRY_RUN accrues exactly once per cycle, in the scheduler:

```js
  if (config.dryRun) {
    return { swept: true, skipped: false, reason: null, signature: `sweep_${Date.now().toString(36)}` };
  }
```

- [ ] **Step 4: Run the ported test**

Run: `npm test -- src/evm/sweep.test.js`
Expected: PASS. Rename any `sweepableEth` reference in the test to `sweepableQuote`.

- [ ] **Step 5: Commit**

```bash
git add src/evm/sweep.js src/evm/sweep.test.js
git commit -m "Port the fee sweep, denominated in the SPCX quote asset"
```

---

### Task 6: Holder snapshot and distribution math

**Files:**
- Create: `src/evm/holders.js`, `src/services/distribution.js`
- Test: `src/evm/holders.test.js`, `src/services/distribution.test.js`

**Interfaces:**
- Consumes: `config.explorerApi`, `config.dryRun`, `fetchJson`, `wallet`.
- Produces: `snapshotEligibleHolders({token, minHoldRaw, exclude}) -> Promise<{holders:[{owner,balanceRaw}], totalHolders:number}>`, `filterEligible`, `countOwners`; `computeWeightedAllocations(holders, totalRaw, {capPct, supplyRaw, clusters}) -> [{owner, amountRaw}]`, `capToRaw`.

**Naming note:** `src/evm/holders.js` (a full holder snapshot for the airdrop) is a different thing from the existing `src/services/holders.js` (Blockscout's summary holder count for the site). Both stay; they live in different directories and neither imports the other.

- [ ] **Step 1: Copy the four files**

```bash
cp /d/projects/babyrobbie/src/evm/holders.js /d/projects/spaceinu-api/src/evm/holders.js
cp /d/projects/babyrobbie/src/evm/holders.test.js /d/projects/spaceinu-api/src/evm/holders.test.js
cp /d/projects/babyrobbie/src/services/distribution.js /d/projects/spaceinu-api/src/services/distribution.js
cp /d/projects/babyrobbie/src/services/distribution.test.js /d/projects/spaceinu-api/src/services/distribution.test.js
```

- [ ] **Step 2: Point `holders.js` at this project's fetchJson**

`src/evm/holders.js` requires `../services/fetchJson`, which already exists here with the same `fetchJson(url, opts)` signature. No change needed — verify by running the test.

- [ ] **Step 3: Run both ported test files**

Run: `npm test -- src/evm/holders.test.js src/services/distribution.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/evm/holders.js src/evm/holders.test.js src/services/distribution.js src/services/distribution.test.js
git commit -m "Port the holder snapshot and the largest-remainder distribution math"
```

---

### Task 7: Airdrop the claimed SPCX

**Files:**
- Create: `src/evm/airdrop.js`
- Test: `src/evm/airdrop.test.js`

**Interfaces:**
- Consumes: `repo.addAirdrop`, `erc20`, `sendTx`, `getDecimals`, `config.disperseAddress`, `config.airdropBatchSize`, `config.airdropGasLimit`.
- Produces: `airdropToken({rewardToken, allocations, cycleId}) -> Promise<{sent, failed}>`, `chunk(arr, n)`.

- [ ] **Step 1: Copy the module**

```bash
cp /d/projects/babyrobbie/src/evm/airdrop.js /d/projects/spaceinu-api/src/evm/airdrop.js
```

- [ ] **Step 2: Fix the DRY_RUN decimals assumption**

In `airdropToken`, the line `const decimals = config.dryRun ? 18 : await getDecimals(rewardToken);` hardcodes 18 for dry runs. SPCX is 18, but the config already states it — use it so the two can never disagree:

```js
  const decimals = config.dryRun ? config.rewardDecimals : await getDecimals(rewardToken);
```

- [ ] **Step 3: Write the failing test**

Create `src/evm/airdrop.test.js`:

```js
'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { chunk } = require('./airdrop');

test('chunk splits allocations into batches of the requested size', () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk returns one batch when the size exceeds the input', () => {
  assert.deepStrictEqual(chunk([1, 2], 10), [[1, 2]]);
});

test('chunk never produces a zero-size batch, which would loop forever', () => {
  assert.deepStrictEqual(chunk([1, 2], 0), [[1], [2]]);
});

test('chunk of an empty list is an empty list', () => {
  assert.deepStrictEqual(chunk([], 5), []);
});
```

- [ ] **Step 4: Run it**

Run: `npm test -- src/evm/airdrop.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/evm/airdrop.js src/evm/airdrop.test.js
git commit -m "Port the airdrop sender: disperse batches and a pipelined transfer fallback"
```

---

### Task 8: The reward cycle

**Files:**
- Create: `src/jobs/cycle.js`
- Test: `src/jobs/cycle.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: `runCycle() -> Promise<cycle>`, `splitClaim(claimedQuote) -> {rewardQuote, devQuote}`, `summarizeReward(reward) -> {status, note, error?}`, `isFeeRecipientOk(launch, address)`, `feeRecipientWarning(launch, address)`, `getFeeRecipientCheck()`.

This is a rewrite of babyrobbie's cycle, not a port: the buy leg is gone and amounts are SPCX.

- [ ] **Step 1: Write the failing test**

Create `src/jobs/cycle.test.js`:

```js
'use strict';

process.env.DRY_RUN = 'true';
process.env.REWARD_PCT = '80';

const test = require('node:test');
const assert = require('node:assert');
const { splitClaim, summarizeReward, isFeeRecipientOk, feeRecipientWarning } = require('./cycle');

test('splits a claim into the holder share and the dev remainder', () => {
  const { rewardQuote, devQuote } = splitClaim(1);
  assert.strictEqual(rewardQuote, 0.8);
  assert.strictEqual(devQuote, 0.2);
});

test('the two legs always re-add to the claim', () => {
  for (const claimed of [0.000001, 0.5, 3.7, 1234.56789]) {
    const { rewardQuote, devQuote } = splitClaim(claimed);
    assert.ok(Math.abs(rewardQuote + devQuote - claimed) < 1e-9, `legs must sum for ${claimed}`);
  }
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

test('an unset fee recipient is a mismatch, not a pass', () => {
  assert.strictEqual(isFeeRecipientOk({ creatorFeeRecipient: '' }, '0xabc'), false);
  assert.strictEqual(isFeeRecipientOk({}, '0xabc'), false);
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/jobs/cycle.test.js`
Expected: FAIL — cannot find module `./cycle`.

- [ ] **Step 3: Write `src/jobs/cycle.js`**

Start from `$BR/src/jobs/cycle.js` and make these changes:

1. Delete the `buyToken` and `getLaunch(config.rewardToken)` imports and the whole `runRewardLeg` buy step.
2. Rename `splitClaim`'s outputs from `{rewardEth, devEth}` to `{rewardQuote, devQuote}`.
3. Replace `claimFromEscrow` with `claimQuoteFromEscrow`, and `claim.ethClaimed` with `claim.quoteClaimed`.
4. The reward leg no longer buys — it airdrops the claimed SPCX directly.

The new reward leg, replacing `runRewardLeg`:

```js
/** Airdrop `quoteAmount` of SPCX pro-rata to eligible holders of the fee token. */
async function runRewardLeg(cycleId, { launch, quoteAmount }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  // MIN_HOLD is a whole-token figure; scale it by the TOKEN's own decimals
  // rather than assuming 18, or the eligibility threshold is wrong by orders
  // of magnitude on any token that is not 18-decimal.
  const tokenDecimals = await getDecimals(launch.token);
  const minHoldRaw = (BigInt(Math.trunc(config.minHold)) * 10n ** BigInt(tokenDecimals)).toString();

  const exclude = await buildExcludeSet(launch);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: launch.token, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${config.minHold}) of ${totalHolders} total`);

  const capPct = config.rewardCapPct > 0 ? config.rewardCapPct : null;
  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(launch.token)).toString();

  // The airdrop is denominated in SPCX base units.
  const totalRaw = parseUnits(toPlainDecimalString(quoteAmount), config.rewardDecimals);
  const allocations = computeWeightedAllocations(holders, totalRaw.toString(), {
    capPct, supplyRaw, clusters: config.clusters,
  });

  const air = await airdropToken({ rewardToken: config.rewardTokenAddress, allocations, cycleId });
  await repo.addStep({
    cycleId, name: 'airdrop', status: air.failed ? 'failed' : 'ok',
    detail: { token: config.rewardTokenAddress, quoteAmount, recipients: allocations.length, sent: air.sent, failed: air.failed },
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
```

`toPlainDecimalString` must be copied from `$BR/src/evm/buy.js` into a new `src/evm/units.js` (the rest of `buy.js` is not ported). It is needed because `String(n)` switches to exponential notation below 1e-6 and `parseUnits` rejects that:

```js
'use strict';

// Expand a JS Number to a PLAIN decimal string — never exponential notation.
// Amounts flow through this project as Numbers, and `String(n)` switches to
// exponential below 1e-6 ("5.6e-7"), which parseUnits rejects outright. A
// reward share that small is ordinary here, so the conversion must survive it.
// `String(n)` (not toFixed) is the source of the digits on purpose: it is the
// shortest round-trip representation, so 21.368470124 converts to exactly
// 21368470124000000000 base units rather than exposing a binary-float tail.
function toPlainDecimalString(n) {
  const s = String(n);
  if (!/e/i.test(s)) return s;

  const [mantissa, expPart] = s.split(/e/i);
  const exp = Number(expPart);
  const negative = mantissa.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  const digits = intPart + fracPart;
  const pointAt = intPart.length + exp;

  let out;
  if (pointAt <= 0) out = `0.${'0'.repeat(-pointAt)}${digits}`;
  else if (pointAt >= digits.length) out = digits + '0'.repeat(pointAt - digits.length);
  else out = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;

  return (negative ? '-' : '') + out;
}

/** Truncate a decimal string to `decimals` places — sub-unit digits are dust. */
function truncateDecimals(decimal, decimals) {
  const dot = decimal.indexOf('.');
  if (dot < 0 || decimal.length - dot - 1 <= decimals) return decimal;
  return decimal.slice(0, dot + 1 + decimals);
}

module.exports = { toPlainDecimalString, truncateDecimals };
```

In `runRewardLeg`, use `parseUnits(truncateDecimals(toPlainDecimalString(quoteAmount), config.rewardDecimals), config.rewardDecimals)`.

5. In `runCycle`, replace the gas-reserve-free start with a pre-flight check, placed immediately after the launch record is read:

```js
    // Gas is NOT self-funding here: the dev cut is SPCX while gas is ETH. Refuse
    // to start rather than claiming and then failing to pay out.
    if (!config.dryRun) {
      const gasWei = await provider.getBalance(config.wallet.address);
      const gasEth = Number(formatEther(gasWei));
      if (gasEth < config.gasReserveEth) {
        throw new Error(
          `wallet ETH ${gasEth} is below GAS_RESERVE_ETH (${config.gasReserveEth}) — ` +
          'top up the wallet; fees stay in the escrow until then'
        );
      }
    }
```

6. Replace the `rewardEth >= config.minRewardEth` gate with a simple positive check, since there is no swap and therefore no minimum worth swapping:

```js
    let reward = { skipped: false, sent: 0, failed: 0, recipients: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardQuote > 0) {
      reward = { skipped: false, ...(await runRewardLeg(id, { launch, quoteAmount: rewardQuote })) };
    } else {
      const reason = 'reward share of this claim is zero';
      reward = { ...reward, skipped: true, reason };
      await repo.addStep({ cycleId: id, name: 'reward', status: 'skipped', detail: { reason, rewardQuote } });
      log(`reward leg skipped: ${reason}`);
    }
```

7. In `finishCycle`, replace `eth_claimed` / `eth_spent_buy` / `tokens_bought` with `quote_claimed` and `quote_distributed`, and update `repo.finishCycle`'s `allowed` list in `src/db/repository.js` to match.
8. Change the required-config guard to `if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (SPACEINU) is required');` and drop the reward-token guard (it has a default).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/jobs/cycle.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Update `getStats` for the renamed columns**

In `src/db/repository.js` `getStats()`, change `total_eth_spent_buy` to sum `$quote_distributed` and drop `total_tokens_bought`. Change the claim-step sum from `$detail.ethClaimed` to `$detail.quoteClaimed`.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/cycle.js src/jobs/cycle.test.js src/evm/units.js src/db/repository.js
git commit -m "Add the reward cycle: sweep, claim SPCX, split, airdrop to holders"
```

---

### Task 9: Scheduler with the $100 USD gate

**Files:**
- Create: `src/jobs/scheduler.js`
- Test: `src/jobs/scheduler.test.js`

**Interfaces:**
- Consumes: `runCycle`, `escrowBalanceQuote`, `sweepableQuote`, `getLaunch`, `getQuotePrice`.
- Produces: `start()`, `pause()`, `resume()`, `triggerNow()`, `pollOnce(trigger, deps)`, `getState()`, `getClaimableQuote(deps)`, `shouldFire({claimableQuote, priceUsd, triggerMode, claimEveryUsd}) -> {fire: boolean, reason: string, usd: number|null}`.

- [ ] **Step 1: Write the failing test**

Create `src/jobs/scheduler.test.js`:

```js
'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { shouldFire } = require('./scheduler');

const GATE = { triggerMode: 'accumulation', claimEveryUsd: 100 };

test('fires once the claimable SPCX is worth the threshold', () => {
  const out = shouldFire({ claimableQuote: 1, priceUsd: 150, ...GATE });
  assert.strictEqual(out.fire, true);
  assert.strictEqual(out.usd, 150);
});

test('fires exactly at the threshold, not just above it', () => {
  assert.strictEqual(shouldFire({ claimableQuote: 2, priceUsd: 50, ...GATE }).fire, true);
});

test('holds below the threshold and says how far short it is', () => {
  const out = shouldFire({ claimableQuote: 0.1, priceUsd: 150, ...GATE });
  assert.strictEqual(out.fire, false);
  assert.match(out.reason, /below/);
});

test('HOLDS when the price is unavailable — a missing price must not trigger a claim', () => {
  const out = shouldFire({ claimableQuote: 100, priceUsd: null, ...GATE });
  assert.strictEqual(out.fire, false);
  assert.match(out.reason, /price/i);
});

test('holds when nothing is claimable, whatever the price', () => {
  assert.strictEqual(shouldFire({ claimableQuote: 0, priceUsd: 150, ...GATE }).fire, false);
});

test('interval mode fires on any positive balance and needs no price at all', () => {
  const out = shouldFire({ claimableQuote: 0.0001, priceUsd: null, triggerMode: 'interval', claimEveryUsd: 100 });
  assert.strictEqual(out.fire, true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/jobs/scheduler.test.js`
Expected: FAIL — cannot find module `./scheduler`.

- [ ] **Step 3: Write `src/jobs/scheduler.js`**

Start from `$BR/src/jobs/scheduler.js`. Rename `getClaimableEth` to `getClaimableQuote` and have it call `escrowBalanceQuote()` and `sweepableQuote(launch)`. Then add the pure gate and use it in `pollOnce`:

```js
/**
 * Pure: should this tick run a cycle?
 *
 * The gate is USD-denominated because fees accrue in SPCX and one SPCX is
 * worth hundreds of dollars — a token threshold would be unusable at this
 * scale. Priced via the same SPCX/USD service the site uses.
 *
 * If the price is unavailable the answer is NO. Unclaimed fees are not lost —
 * they keep accruing and the next tick tries again — whereas firing blind
 * would claim at an unknown value and pay gas for it.
 *
 * @param {{claimableQuote:number, priceUsd:number|null, triggerMode:string, claimEveryUsd:number}} args
 * @returns {{fire: boolean, reason: string, usd: number|null}}
 */
function shouldFire({ claimableQuote, priceUsd, triggerMode, claimEveryUsd }) {
  if (!(claimableQuote > 0)) return { fire: false, reason: 'nothing claimable', usd: null };

  if (triggerMode !== 'accumulation') {
    return { fire: true, reason: 'interval mode — firing on whatever has accrued', usd: null };
  }

  if (typeof priceUsd !== 'number' || !(priceUsd > 0)) {
    return { fire: false, reason: 'SPCX price unavailable — holding rather than claiming blind', usd: null };
  }

  const usd = claimableQuote * priceUsd;
  if (usd < claimEveryUsd) {
    return { fire: false, reason: `below the accumulation threshold ($${usd.toFixed(2)} < $${claimEveryUsd})`, usd };
  }
  return { fire: true, reason: `threshold met ($${usd.toFixed(2)} >= $${claimEveryUsd})`, usd };
}
```

In `pollOnce`, after reading `claimable`, read the price defensively and apply the gate:

```js
    const claimable = await getClaimableQuote(deps);
    state.lastClaimable = claimable;

    let priceUsd = null;
    try {
      priceUsd = (await (deps.getQuotePrice || getQuotePrice)()).priceUsd;
    } catch (err) {
      console.warn(`[spaceinu] SPCX price unavailable: ${err.message}`);
    }
    state.lastPriceUsd = priceUsd;

    const gate = shouldFire({
      claimableQuote: claimable,
      priceUsd,
      triggerMode: deps.triggerMode !== undefined ? deps.triggerMode : config.triggerMode,
      claimEveryUsd: deps.claimEveryUsd !== undefined ? deps.claimEveryUsd : config.claimEveryUsd,
    });
    state.lastClaimableUsd = gate.usd;
    if (!gate.fire) return { ran: false, claimable, usd: gate.usd, reason: gate.reason };
```

Add `lastPriceUsd` and `lastClaimableUsd` to `state`, to `getState()`, and to `_resetState()`. Export `shouldFire` and `getClaimableQuote`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/jobs/scheduler.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/scheduler.js src/jobs/scheduler.test.js
git commit -m "Gate cycles on 100 USD of accrued SPCX, holding when the price is unknown"
```

---

### Task 10: The bot process

**Files:**
- Create: `bot.js`, `src/routes/operator.js`, `src/middleware/auth.js`
- Test: `src/routes/operator.test.js`

**Interfaces:**
- Consumes: `scheduler`, `repo`, `db`, `config`.
- Produces: a process exposing `GET /status`, `POST /run`, `POST /pause`, `POST /resume` on `127.0.0.1:${config.botPort}`.

- [ ] **Step 1: Copy the auth middleware**

```bash
mkdir -p /d/projects/spaceinu-api/src/middleware
cp /d/projects/babyrobbie/src/middleware/auth.js /d/projects/spaceinu-api/src/middleware/auth.js
```

- [ ] **Step 2: Write the failing operator-route test**

Create `src/routes/operator.test.js`:

```js
'use strict';

process.env.DRY_RUN = 'true';
process.env.API_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert');
const { buildStatus } = require('./operator');

test('status reports the scheduler gate and the fee-recipient check', () => {
  const out = buildStatus({
    scheduler: { paused: false, isRunning: false, lastClaimable: 2, lastPriceUsd: 150, lastClaimableUsd: 300 },
    feeCheck: { ok: true, expected: '0xabc', actual: '0xabc', at: 'now' },
    walletAddress: '0xabc',
    ethBalance: 0.5,
  });
  assert.strictEqual(out.feeRecipientOk, true);
  assert.strictEqual(out.claimableUsd, 300);
  assert.strictEqual(out.wallet.ethBalance, 0.5);
});

test('an unrun bot reports feeRecipientOk as null, not false', () => {
  const out = buildStatus({ scheduler: {}, feeCheck: null, walletAddress: '0xabc', ethBalance: null });
  assert.strictEqual(out.feeRecipientOk, null);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- src/routes/operator.test.js`
Expected: FAIL — cannot find module `./operator`.

- [ ] **Step 4: Write `src/routes/operator.js`**

```js
'use strict';

// Operator control for the bot process. Bound to 127.0.0.1 by bot.js and
// additionally gated by API_KEY, so it is reachable only over SSH — it can
// trigger a real payout, which is not something to expose to the internet.

const express = require('express');
const { formatEther } = require('ethers');
const config = require('../config');
const scheduler = require('../jobs/scheduler');
const { getFeeRecipientCheck } = require('../jobs/cycle');
const { provider, walletAddress } = require('../evm/provider');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();
router.use(requireApiKey);

/** Pure: assemble the operator status payload. */
function buildStatus({ scheduler: s, feeCheck, walletAddress: address, ethBalance }) {
  return {
    dryRun: config.dryRun,
    tokenSymbol: config.tokenSymbol,
    // false = the launch pays creator fees somewhere else and the cycle can
    // never claim. The single most important flag here. null = no cycle yet.
    feeRecipientOk: feeCheck ? feeCheck.ok : null,
    creatorFeeRecipient: feeCheck ? feeCheck.actual : null,
    claimableQuote: s.lastClaimable ?? null,
    claimableUsd: s.lastClaimableUsd ?? null,
    spcxPriceUsd: s.lastPriceUsd ?? null,
    trigger: { mode: config.triggerMode, claimEveryUsd: config.claimEveryUsd, schedule: config.pollSchedule },
    split: { rewardPct: config.rewardPct, devPct: config.devPct, minHold: config.minHold },
    wallet: { address, ephemeral: config.walletIsEphemeral, ethBalance, gasReserveEth: config.gasReserveEth },
    scheduler: s,
  };
}

router.get('/status', async (req, res, next) => {
  try {
    let ethBalance = null;
    if (!config.dryRun) {
      try {
        ethBalance = Number(formatEther(await provider.getBalance(walletAddress())));
      } catch (_err) {
        ethBalance = null;
      }
    }
    res.json(
      buildStatus({
        scheduler: scheduler.getState(),
        feeCheck: getFeeRecipientCheck(),
        walletAddress: walletAddress(),
        ethBalance,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/run', async (req, res) => {
  try {
    const result = await scheduler.triggerNow();
    if (result && result.skipped) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pause', (req, res) => res.json(scheduler.pause()));
router.post('/resume', (req, res) => res.json(scheduler.resume()));

module.exports = { router, buildStatus };
```

- [ ] **Step 5: Write `bot.js`**

```js
'use strict';

// The bot process. This is the ONLY process that loads the wallet private key;
// server.js serves the public API and never touches it, so a compromise of the
// internet-facing service reaches no signing key.
//
// Its HTTP surface exists purely for operators and binds to 127.0.0.1, so it is
// reachable only over SSH — POST /run pays real money out.

const express = require('express');

const config = require('./src/config');
const db = require('./src/db');
const scheduler = require('./src/jobs/scheduler');
const { walletAddress } = require('./src/evm/provider');
const { router: operatorRouter } = require('./src/routes/operator');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use('/', operatorRouter);
app.use((req, res) => res.status(404).json({ error: 'not found' }));

let server;

async function main() {
  await db.connect();
  console.log(`[spaceinu-bot] MongoDB connected (${config.mongoDb})`);

  server = app.listen(config.botPort, '127.0.0.1', () => {
    console.log(`[spaceinu-bot] operator API on http://127.0.0.1:${config.botPort} (localhost only)`);
    console.log(`[spaceinu-bot] dryRun=${config.dryRun} wallet=${walletAddress()}`);
    if (config.walletIsEphemeral) {
      console.log('[spaceinu-bot] WARNING: ephemeral wallet (no WALLET_PRIVATE_KEY) — dry run only');
    }
    if (!config.apiKey) {
      console.warn('[spaceinu-bot] WARNING: API_KEY is unset — the operator endpoints are unauthenticated');
    }
    scheduler.start();
  });
}

async function shutdown(signal) {
  console.log(`\n[spaceinu-bot] ${signal} received, shutting down`);
  if (server) server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[spaceinu-bot] failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- src/routes/operator.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 7: Smoke-test the bot process in DRY_RUN**

Requires a local `mongod`. Run:

```bash
cd /d/projects/spaceinu-api
DRY_RUN=true TOKEN_ADDRESS=0x50d0d0da00ffd195d2d1d2448617ad039855ad2b API_KEY=test node bot.js
```

Expected: logs "MongoDB connected", "operator API on http://127.0.0.1:3100", "scheduler started". In another shell:
`curl -H "x-api-key: test" http://127.0.0.1:3100/status` returns JSON with `dryRun: true`. Stop with Ctrl-C.

- [ ] **Step 8: Commit**

```bash
git add bot.js src/routes/operator.js src/routes/operator.test.js src/middleware/auth.js
git commit -m "Add the bot process: scheduler plus localhost-only operator control"
```

---

### Task 11: Serve rewards from the bot's ledger

**Files:**
- Rewrite: `src/services/rewards.js`, `src/services/rewardsfeed.js`
- Rewrite: `src/services/rewards.test.js`, `src/services/rewardsfeed.test.js`

**Interfaces:**
- Consumes: `repo.getDistributedTotal`, `repo.getAirdropPage`.
- Produces: `getRewards() -> Promise<{totalRewarded: number|null}>` (same call signature the stats route already uses), `getFeedPage(cursor, limit) -> Promise<{rows, nextCursor}>`, `parseCursor(cursor)`.

The bot is now the thing distributing, so both readers move from Pons's distributor to the bot's own ledger. The exported signatures do not change, so `routes/stats.js` and `routes/rewards.js` keep working.

- [ ] **Step 1: Write the failing tests**

Replace `src/services/rewardsfeed.test.js` with:

```js
'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { parseCursor, toRow } = require('./rewardsfeed');

test('an absent cursor means "start at the newest"', () => {
  assert.strictEqual(parseCursor(undefined), null);
  assert.strictEqual(parseCursor(null), null);
  assert.strictEqual(parseCursor(''), null);
});

test('a numeric cursor is accepted', () => {
  assert.strictEqual(parseCursor('42'), 42);
});

test('a malformed cursor is a 400, not a crash', () => {
  assert.throws(() => parseCursor('not-a-number'), (err) => err.status === 400);
  assert.throws(() => parseCursor('12-9'), (err) => err.status === 400);
  assert.throws(() => parseCursor(['1']), (err) => err.status === 400);
});

test('an airdrop row becomes the shape the site renders', () => {
  const row = toRow({
    id: 7, recipient: '0xholder', amount_ui: 1.25,
    signature: '0x' + 'b'.repeat(64), created_at: '2026-08-30T12:00:00.000Z',
  });
  assert.deepStrictEqual(row, {
    id: '7',
    wallet: '0xholder',
    amount: 1.25,
    txHash: '0x' + 'b'.repeat(64),
    at: Date.parse('2026-08-30T12:00:00.000Z'),
  });
});

test('a row with no amount reads as 0, never null — the site formats it', () => {
  const row = toRow({ id: 1, recipient: '0xa', amount_ui: null, signature: '0xc', created_at: '2026-08-30T00:00:00Z' });
  assert.strictEqual(row.amount, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- src/services/rewardsfeed.test.js`
Expected: FAIL — `toRow is not a function` / cursor format mismatch.

- [ ] **Step 3: Rewrite `src/services/rewardsfeed.js`**

```js
'use strict';

// The rewards feed: individual SPCX payouts to holder wallets, newest first.
//
// The payouts are made by this project's own bot, so the ledger IS the source
// of truth — no explorer round trip, no upstream lag, and it keeps working when
// Blockscout is having a bad minute. `repo.getAirdropPage` already excludes
// DRY_RUN rows by requiring a real transaction hash, so a simulated payout can
// never reach a visitor.
//
// The cursor is the numeric id of the last row served. Ids are monotonic, so
// "older than this" is a plain comparison. The site treats the cursor as
// opaque and only echoes back `nextCursor`.

const repo = require('../db/repository');
const { cachedByKey } = require('./cache');
const config = require('./../config');

const EMPTY_PAGE = { rows: [], nextCursor: null };

function badCursor() {
  const err = new Error('malformed cursor — expected a row id');
  err.status = 400;
  return err;
}

/** Pure: cursor string -> row id, or null for "start at the newest". Throws 400. */
function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) throw badCursor();
  return Number(cursor);
}

/** Pure: a stored airdrop row -> the feed row the route serves. */
function toRow(row) {
  const at = Date.parse(row.created_at);
  return {
    id: String(row.id),
    wallet: row.recipient,
    amount: row.amount_ui ?? 0,
    txHash: row.signature,
    at: Number.isFinite(at) ? at : null, // epoch ms
  };
}

async function fetchFeedPage({ cursor = null, limit }) {
  if (!config.tokenAddress) return EMPTY_PAGE; // pre-launch: nothing paid out yet
  const page = await repo.getAirdropPage(limit, parseCursor(cursor));
  return { rows: page.rows.map(toRow), nextCursor: page.nextCursor };
}

// Cached per (cursor, limit) — the site polls this every 15s per open tab.
const pages = cachedByKey(config.feedTtlMs, (cursor, limit) => fetchFeedPage({ cursor, limit }));
const getFeedPage = (cursor, limit) => pages(`${cursor ?? ''}|${limit}`, cursor, limit);

module.exports = { getFeedPage, fetchFeedPage, parseCursor, toRow, EMPTY_PAGE };
```

- [ ] **Step 4: Rewrite `src/services/rewards.js`**

```js
'use strict';

// Total SPCX paid to holders — summed from this project's own airdrop ledger.
//
// Previously this read Pons's fee-distributor API, which was correct when Pons
// did the distributing. This launch keeps creator fees with the bot, so there
// IS no distributor: the bot claims and airdrops, and its records are the only
// authority. `getDistributedTotal` counts only payouts carrying a real on-chain
// transaction hash, so simulated DRY_RUN rows are never included.
//
// Null (not 0) before launch: the site hides a null tile, but would render a
// zero as a real "nothing has been paid" claim. Once the token is live, a real
// zero means no cycle has paid out yet and is served as 0.

const config = require('./../config');
const repo = require('../db/repository');
const { cached } = require('./cache');

const EMPTY = { totalRewarded: null };

async function fetchRewards() {
  if (!config.tokenAddress) return EMPTY; // pre-launch
  const { totalUi } = await repo.getDistributedTotal(config.rewardTokenAddress);
  return { totalRewarded: totalUi ?? 0 };
}

const getRewards = cached(config.rewardsTtlMs, fetchRewards);

module.exports = { getRewards, fetchRewards, EMPTY };
```

- [ ] **Step 5: Replace `src/services/rewards.test.js`**

```js
'use strict';

process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const { EMPTY } = require('./rewards');

test('pre-launch, the rewarded total is null rather than zero', () => {
  assert.strictEqual(EMPTY.totalRewarded, null);
});
```

- [ ] **Step 6: Update `src/routes/rewards.js` for the new cursor**

The route imports `parseCursor` from the feed and uses it for validation — that still works. Delete the now-wrong comment block describing `<block>-<logIndex>` and replace the first paragraph with:

```js
// GET /rewards?cursor=<rowId>&limit=<1..50> — the live payout feed.
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- src/services/rewards.test.js src/services/rewardsfeed.test.js src/routes/rewards.test.js`
Expected: PASS. Update any assertion in `routes/rewards.test.js` that uses a `<block>-<logIndex>` cursor to use a numeric one.

- [ ] **Step 8: Commit**

```bash
git add src/services/rewards.js src/services/rewards.test.js src/services/rewardsfeed.js src/services/rewardsfeed.test.js src/routes/rewards.js src/routes/rewards.test.js
git commit -m "Serve totalRewarded and the payout feed from the bot's own ledger"
```

---

### Task 12: Wire it together, document, and deploy

**Files:**
- Modify: `server.js`, `src/routes/stats.js`, `scripts/check.js`, `.env.example`, `README.md`
- Create: `DEPLOY.md`

- [ ] **Step 1: Connect the public API to MongoDB without loading a key**

In `server.js`, add near the top:

```js
const db = require('./src/db');
```

and replace the bare `app.listen(...)` block with a `main()` that connects first:

```js
async function main() {
  await db.connect();
  console.log(`[spaceinu] MongoDB connected (${config.mongoDb})`);
  server = app.listen(config.port, () => {
    console.log(`[spaceinu] listening on http://localhost:${config.port}`);
    console.log(`[spaceinu] token=${config.tokenSymbol} address=${config.tokenAddress || '(not set — stats will be null)'}`);
    console.log(`[spaceinu] cors=${config.corsOrigins.join(', ')}`);
  });
}
```

Call `main().catch(...)` in place of the existing listen, and `await db.close()` in `shutdown`.

- [ ] **Step 2: Confirm `routes/stats.js` needs no change**

`getRewards()` still returns `{ totalRewarded }` and `getQuotePrice()` still returns `{ priceUsd }`, so `buildStats` and `rewardedUsd` work unchanged. Verify:

Run: `npm test -- src/routes/stats.test.js`
Expected: PASS.

- [ ] **Step 3: Extend `scripts/check.js`**

Append a bot section that prints the launch record, the fee-recipient verdict, the claimable SPCX and its USD value, and the wallet's ETH gas balance — the four things that decide whether a cycle can run. Model it on `$BR/scripts/check.js`, using `getLaunch()`, `escrowBalanceQuote()`, `sweepableQuote(launch)`, `getQuotePrice()` and `provider.getBalance()`.

- [ ] **Step 4: Update `.env.example`**

Add every key from Task 1 with the comments from the spec's config table, set `CORS_ORIGINS=https://spaceinu.art,https://www.spaceinu.art`, and delete `DISTRIBUTOR_ADDRESS`. Add this warning above `WALLET_PRIVATE_KEY`:

```
# MUST be SPACEINU's creatorFeeRecipient — the only address allowed to sweep or
# claim. Read by bot.js only; server.js never loads it. If this is wrong the bot
# runs without a single error and silently collects nothing, forever.
#
# ALSO: leave Pons's "route creator fees to holders" toggle OFF. Switching it on
# reassigns creatorFeeRecipient to a distributor contract and the bot instantly
# has nothing to claim.
```

- [ ] **Step 5: Rewrite `README.md`**

Cover: what the two processes are and why the key lives in only one; the cycle; the $100 USD trigger and the hold-on-missing-price rule; the API table; the `creatorFeeRecipient` requirement and the toggle warning; that gas is not self-funding; and the quick start (`npm install`, `npm test`, `npm run check`, `npm start`, `npm run bot`).

- [ ] **Step 6: Write `DEPLOY.md`**

Ubuntu 24.04, `api.spaceinu.art`: base prep, ufw, Node 22 via NodeSource, MongoDB 8.0 (noble repo), clone, `npm ci --omit=dev`, `.env` with `chmod 600`, `npm run check`, **two** PM2 processes (`pm2 start server.js --name spaceinu-api` and `pm2 start bot.js --name spaceinu-bot`), `pm2 startup`/`save`, pm2-logrotate, the nginx vhost proxying only to `127.0.0.1:3000` (never the bot port), and certbot `--nginx -d api.spaceinu.art --redirect`. State explicitly that the bot port must NOT be proxied.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
git add server.js scripts/check.js .env.example README.md DEPLOY.md
git commit -m "Wire the API to Mongo, document the two-process deployment"
```

---

## Self-Review

**Spec coverage:** Two processes → Tasks 10, 12. Cycle without a buy leg → Task 8. `claimToken` → Task 4. USD trigger with hold-on-missing-price → Task 9. Mongo-backed `totalRewarded` + `/rewards` → Task 11. Unchanged API shapes → Task 12 Step 2. DRY_RUN filter → Tasks 2, 11. `MIN_HOLD` decimals fix → Task 8. `GAS_RESERVE_ETH` enforcement → Task 8. `creatorFeeRecipient` check → Tasks 8, 10. `PONS_API` retained → untouched by every task. Config table → Task 1. Testing → every task.

**Naming consistency:** `rewardQuote`/`devQuote` (Task 8) match `splitClaim`'s test (Task 8). `escrowBalanceQuote`/`claimQuoteFromEscrow` (Task 4) are consumed by Tasks 8 and 9. `sweepableQuote` (Task 5) is consumed by Task 9. `getAirdropPage` (Task 2) is consumed by Task 11. `shouldFire` (Task 9) is consumed by its own test and `pollOnce`. `getRewards()` keeps its signature so `routes/stats.js` is untouched.

**Known follow-ups, deliberately out of scope:** deploying `Disperse.sol`; the airdrop pipeline's nonce-resync race under high recipient counts (inherited, never observed).
