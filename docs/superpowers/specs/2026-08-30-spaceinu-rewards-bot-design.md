# spaceinu rewards bot — Design

Date: 2026-08-30
Status: approved

## Purpose

Merge a creator-fee reward bot into `spaceinu-api`, so one repository both
**earns and distributes** SPACEINU's creator fees and **reports** what it did to
the site at `spaceinu.art`.

SPACEINU launches on the Pons V2 launchpad **paired with SPCX** (tokenized
SpaceX stock). Because Pons pays creator fees in whatever the launch is priced
in, those fees accrue **as SPCX** — never as ETH. The bot claims that SPCX and
airdrops it pro-rata to SPACEINU holders, keeping a configurable dev cut.

The bot is derived from `d:\projects\babyrobbie` (a pons v2 fee-recycling bot
for an ETH-quoted launch). The API is the existing `spaceinu-api` in this repo,
whose response shapes do not change.

## Why a bot at all — the alternative, and why it was rejected

Pons offers this natively. Its create form and token page carry a first-party
toggle, switchable after launch by the fee-recipient wallet:

> "Route this launch's creator fees to its holders, distributed pro-rata and
> pushed to their wallets."

Ryzen Kitty (RYZEN, paired with AMD) uses it: its `creatorFeeRecipient` is not a
wallet but a Pons fee-distributor contract, and its page states "There is no
creator claim." Verified on chain: 3.4165 AMD left that distributor in 117
transfers to 81 recipients across two batch transactions sent by Pons's
automation wallet.

**The two mechanisms are mutually exclusive.** Enabling the toggle reassigns
`creatorFeeRecipient` to the distributor, and the bot would have nothing to
claim, forever and silently.

The bot is chosen for control the toggle does not offer:

| | Pons toggle | This bot |
| --- | --- | --- |
| Dev cut | none — 100% to holders | `REWARD_PCT` split |
| Eligibility | all holders | `MIN_HOLD` threshold |
| Anti-sybil | none | cluster caps, `REWARD_CAP_PCT` |
| Exclusions | none | pool manager, curve, hook, custom list |
| Trigger | Pons's epochs | $100 USD accumulated |

**Operational requirement: the holder-fee-sharing toggle must stay OFF, and
`creatorFeeRecipient` must be the bot wallet.** Set it at launch.

## Architecture — one repo, two processes

The public API must not hold a signing key. babyrobbie runs its scheduler
inside its web server; that is not carried over.

```
D:\projects\spaceinu-api
├── server.js   PUBLIC API  -> nginx -> api.spaceinu.art      NO wallet key
│                GET /token /stats /rewards /health
├── bot.js      THE BOT     -> 127.0.0.1 only                 holds the key
│                scheduler -> cycle -> claim -> airdrop
│                GET /status, POST /run /pause /resume  (API_KEY)
└── src/        shared: config, db, services, evm, jobs, routes
         |
     MongoDB   collections: cycles, steps, airdrops, counters
```

Two PM2 processes over one database. `server.js` never requires
`WALLET_PRIVATE_KEY`; a compromise of the internet-facing service reaches no
key. `bot.js` binds its operator endpoints to `127.0.0.1` so they are reachable
only over SSH, and additionally requires `API_KEY`.

## The cycle

Fees arrive already denominated in SPCX — the reward asset does not have to be
bought. babyrobbie's buy leg, its most failure-prone machinery, is deleted.

```
1. sweep            push pending fees into the escrow   (best-effort, never fatal)
2. claimToken(SPCX) withdraw the escrow balance         -> SPCX in the wallet
3. split            REWARD_PCT to holders, remainder is the dev cut
4. airdrop          SPCX pro-rata to eligible SPACEINU holders
                    (the dev cut needs no transaction — it is already in the wallet)
```

A cycle records every step to Mongo as it completes, so a cycle that dies
halfway leaves a readable trail.

### Trigger: $100 USD accumulated

`TRIGGER_MODE=accumulation` with a **USD** threshold, not a token amount:

```
claimableSPCX x SPCX_USD >= CLAIM_EVERY_USD   (default 100)
```

`claimableSPCX` is the escrow balance **plus** fees still pending on the curve
or hook — gating on the escrow alone deadlocks, because before the first sweep
it is zero while the fees sit upstream.

`SPCX_USD` comes from the existing `src/services/quoteprice.js` (DexScreener).
**If the price is unavailable the bot holds and logs; it does not fire.** A
missing price must never cause an unintended claim, and unclaimed fees are not
lost — they keep accruing for the next tick.

`TRIGGER_MODE=interval` remains supported (fire on whatever has accrued).

## Changes to the babyrobbie code being carried over

### Rewritten for an ERC-20 quote asset

| File | Change |
| --- | --- |
| `src/evm/escrow.js` | `balanceOfToken(wallet, SPCX)` and `claimToken(SPCX)`; parse the `ClaimedToken(recipient, token, amount)` event instead of `Claimed`. Both functions are confirmed present in the deployed `V2FeeEscrow` (`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`) verified ABI. |
| `src/jobs/scheduler.js` | Read the SPCX-denominated claimable balance and apply the USD gate. The current code reads the native-ETH ledger, which for a SPCX-quoted launch is always `0` — the bot would never fire. |
| `src/jobs/cycle.js` | Remove the buy leg. Rename `*Eth` amounts to quote-denominated names. Fix `MIN_HOLD`, which hardcodes `10 ** 18` where every other amount uses `getDecimals()`. |

Escrow balances are **per recipient across all launches**, not per token, so
`claimToken(SPCX)` collects that wallet's SPCX from every launch it is the
recipient of. This is correct for a single-token operator and must be
re-examined if the wallet is ever the recipient for a second launch.

### Carried over essentially unchanged

`sweep.js` (already passes `launch.pairToken` as the quote currency; verified
against RYZEN's AMD-denominated fees), `holders.js`, `exclude.js`,
`distribution.js` (largest-remainder allocation, cluster caps),
`airdrop.js`, `send.js` (stale-nonce retry), `launch.js`, `pool.js`, `erc20.js`,
`db/`, `events.js`, `middleware/auth.js`.

### Dropped

`buy.js`, `v4router.js`, the curve buy path in `curve.js`, the V4 quoter,
slippage handling, `MIN_REWARD_ETH`, `price.js` (ETH/USD — superseded by
`quoteprice.js`), and babyrobbie's `routes/public.js` and `routes/frontend.js`,
both superseded by this repo's routes.

## API — existing contract, new data source

All four endpoints keep their exact response shapes. **The frontend needs no
changes.** Only the two reward sources move, from Pons's distributor to the
bot's own ledger, because the bot is now the thing doing the distributing.

| Endpoint | Source |
| --- | --- |
| `GET /token` | config — unchanged |
| `GET /stats` `marketCap`, `holders`, `priceUsd`, `liquidityUsd` | unchanged: DexScreener -> Blockscout -> bonding curve x SPCX/USD |
| `GET /stats` `totalRewarded` | **Mongo**: sum of `amount_ui` over real payouts |
| `GET /stats` `totalRewardedUsd` | `totalRewarded` x `quoteprice` |
| `GET /rewards?cursor&limit` | **Mongo**: airdrop rows, newest first |
| `GET /health` | unchanged |

Replaced: `src/services/rewards.js` (Pons distributor API) and
`src/services/rewardsfeed.js` (Blockscout transfers out of the distributor).
Both become Mongo-backed readers behind the same function signatures.

Unchanged: `marketdata.js`, `curvemarket.js`, `quoteprice.js`, `holders.js`,
`cache.js`, `fetchJson.js`, `routes/token.js`, `routes/stats.js`.

The `/rewards` cursor becomes the numeric airdrop row id (`^\d+$`) instead of
`<block>-<logIndex>`. The site treats the cursor as opaque and only echoes back
`nextCursor`, so this is not a frontend-visible change.

### The DRY_RUN rule

In `DRY_RUN` the bot records airdrops with `status: 'ok'` and a fabricated
signature (`airdrop_ka9f2x`). **Public endpoints must filter on a real
transaction hash** (`^0x[0-9a-fA-F]{64}$`). Serving simulated payouts to
visitors would publish invented rewards linking to transactions that do not
exist. This rule is carried over from babyrobbie verbatim.

## Data model

Mongo, reused from babyrobbie unchanged:

- `cycles` — one row per cycle: status, phase, amounts claimed and distributed,
  eligible/total holders, sweep outcome, note, error.
- `steps` — one row per step (`sweep`, `claim`, `airdrop`, `error`) with its
  signature and detail; the public activity trail.
- `airdrops` — one row per recipient per cycle: wallet, raw and UI amount,
  signature, status. This is what `/rewards` and `totalRewarded` read.
- `counters` — atomic auto-increment ids.

## Config

New and changed keys in `.env.example`:

| Env | Default | Meaning |
| --- | --- | --- |
| `WALLET_PRIVATE_KEY` | — | must be SPACEINU's `creatorFeeRecipient`. `bot.js` only |
| `TRIGGER_MODE` | `accumulation` | `accumulation` (USD gate) or `interval` |
| `CLAIM_EVERY_USD` | `100` | fire once claimable SPCX is worth this much |
| `POLL_SCHEDULE` | `*/5 * * * *` | how often the gate is evaluated |
| `REWARD_PCT` | `80` | share airdropped to holders; the rest is the dev cut |
| `MIN_HOLD` | `100000` | minimum SPACEINU balance to qualify |
| `REWARD_CAP_PCT` | `0` | per-wallet weight cap, % of supply (0 = pure pro-rata) |
| `CLUSTERS` | `[]` | address groups treated as one wallet |
| `AIRDROP_BATCH_SIZE` | `30` | transfers in flight, or recipients per disperse batch |
| `DISPERSE_ADDRESS` | — | batch-transfer contract; blank = pipelined transfers |
| `GAS_RESERVE_ETH` | `0.01` | minimum wallet ETH; below it the cycle refuses to start |
| `MONGODB_URI` / `MONGODB_DB` | local / `spaceinu` | storage |
| `API_KEY` | — | protects the operator endpoints on `bot.js` |
| `DRY_RUN` | `true` | simulate everything; the default everywhere |

Existing keys (`TOKEN_ADDRESS`, `TOKEN_SYMBOL`, `TOKEN_NAME`, `PONS_API`,
`REWARD_TOKEN_ADDRESS`, `EXPLORER_API`, `CORS_ORIGINS`, TTLs) are retained.
`CORS_ORIGINS` becomes `https://spaceinu.art,https://www.spaceinu.art`.

Two clarifications, because both keys are easy to misread as redundant:

- **`REWARD_TOKEN_ADDRESS` (SPCX) is the single address for both roles.** It is
  the launch's *quote* asset (so fees accrue in it) and the *reward* asset (so
  it is what gets airdropped). There is deliberately no second "quote token"
  key — one address, two roles, and they cannot diverge.
- **`PONS_API` is still required.** The distributor reader that used it is
  removed, but `curvemarket.js` uses the same host for the bonding-curve chart
  (`/api/pons-v2-market/{token}/chart`), which is what keeps the market-cap
  tile alive before graduation.

`DISTRIBUTOR_ADDRESS` is removed — there is no distributor in this design.

## Error handling

Carried over from both parents, unchanged in spirit:

- **A refused sweep is normal, not an error.** Both contracts revert
  `InternalSwapRequiresOperator` when clearing fees would need an internal swap
  only Pons's operator may authorise. Log, skip, and claim whatever is already
  in the escrow.
- **Degrade, never fail after spending.** Independent upstreams settle
  independently (`Promise.allSettled`); a failed refresh serves the last good
  cached value; `null` is never rendered as `0`.
- **Distinguish "nobody eligible" from "airdrop reached nobody."** Both look
  like `sent: 0` and must not be recorded identically.
- **Nonce retries only where safe** — the stale-nonce family, never
  "already known" replacements.

## Operational consequences

1. **Gas is no longer self-funding.** babyrobbie's dev cut was native ETH, so
   the wallet refilled its own gas. Here the dev cut is SPCX and gas is ETH, so
   the wallet needs an independently topped-up ETH balance that a few hundred
   transfers per cycle steadily drain. `GAS_RESERVE_ETH` is currently config
   that no code reads; it becomes a real pre-flight check that refuses to start
   a cycle below the reserve, rather than failing after claiming.
2. **`creatorFeeRecipient` is mutable.** The factory exposes
   `transferCreatorFeeRecipient` and `setCreatorFeeRecipient`; RYZEN's was
   changed at block 48554621. babyrobbie's README claim that it is "set once at
   launch" is wrong. The per-cycle check is retained and must alarm loudly, not
   merely warn, if the recipient moves away from the bot wallet.
3. **SPCX is a tokenized equity** behind an upgradeable beacon proxy with a live
   `paused()` switch. A pause would make every airdrop transfer revert. The
   sibling AMD token was confirmed freely transferable with no allowlist, so no
   transfer gating is expected — but the airdrop must survive a mass revert
   without losing its ledger, which the existing per-recipient recording
   already provides.

## Testing

`node --test`, no network in unit tests.

- Carried over from `spaceinu-api`: `cache`, `fetchJson`, `marketdata`,
  `holders`, `curvemarket`, `quoteprice`, `stats`, `token` tests.
- Carried over from babyrobbie: `distribution`, `sweep`, `exclude`, `send`,
  `pool`, `erc20`, `launch`, `scheduler`, `config` tests, and the in-memory
  Mongo cycle integration test.
- **New:** `escrow.test.js` for the `claimToken` path and `ClaimedToken`
  parsing; `scheduler.test.js` cases for the USD gate, including *price
  unavailable does not fire*; the Mongo-backed `rewards` and `rewardsfeed`
  readers, including *DRY_RUN rows never appear in the public feed*; cursor
  paging over row ids.

## Out of scope

- Buying any token. There is no swap anywhere in this design.
- Migrating to Pons's holder-fee-sharing distributor (mutually exclusive).
- Frontend changes at `spaceinu.art`.
- Deploying the `Disperse.sol` contract. `DISPERSE_ADDRESS` is supported and
  should be set before holder count grows, but deploying it is separate work.

## Delivery

Branch `spaceinu-rewards-bot` in `d:\projects\spaceinu-api`; remote
`https://github.com/blockfile/spcxinu.git`. **Not pushed until requested.**
