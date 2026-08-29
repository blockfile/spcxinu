# spaceinu

**Creator-fee reward bot and stats API for [spaceinu.art](https://spaceinu.art).**

SPACEINU launches on the Pons V2 launchpad **paired with SPCX** (tokenized
SpaceX stock). Because pons pays creator fees in whatever a launch is priced in,
those fees accrue **as SPCX** — never as ETH. This repo claims them and airdrops
them pro-rata to SPACEINU holders, then reports what it did to the site.

```
SPACEINU trades  →  creator fees accrue on-chain, denominated in SPCX
      ↓  sweep              push pending fees into the pons fee escrow
      ↓  claimToken(SPCX)   withdraw the escrow → the bot's wallet
      ├─ 80% → airdrop SPCX pro-rata to SPACEINU holders
      └─ 20% → dev cut (already SPCX in the wallet — no transaction)
```

**Nothing is ever bought.** The reward asset arrives as the fee asset, so there
is no swap, no quoter, no slippage, and no way to buy a reward and then fail to
hand it out.

## Two processes, one database

The public API must never hold a signing key, so the bot is a separate process:

| Process | Runs | Holds the wallet key | Exposed |
| --- | --- | --- | --- |
| `server.js` (`npm start`) | the site's API | **no** | nginx → `api.spaceinu.art` |
| `bot.js` (`npm run bot`) | scheduler + cycle | **yes** | `127.0.0.1` only |

They share one MongoDB: the bot writes payouts, the API reads them. A compromise
of the internet-facing service reaches no key, and `POST /run` — which pays real
money out — is not reachable from the internet at all.

## The trigger: $100 of accrued SPCX

`TRIGGER_MODE=accumulation` fires a cycle once the claimable SPCX is worth
`CLAIM_EVERY_USD` (default 100), priced from DexScreener's SPCX/USD. The gate is
in dollars rather than tokens because one SPCX is worth hundreds of dollars, so
a token threshold is unusable.

**If the SPCX price is briefly unavailable, the bot holds rather than firing.**
Claiming blind would empty the escrow at an unknown value and pay gas to do it,
while waiting costs nothing — the fees keep accruing for the next tick.

"Claimable" counts the escrow balance **plus** fees still pending on the curve or
hook. Gating on the escrow alone deadlocks: before the first sweep it reads zero
while the fees sit upstream, so the bot would never fire and therefore never
sweep.

`TRIGGER_MODE=interval` claims whatever has accrued on every tick, and needs no
price at all.

## The two things that will silently break it

**1. `creatorFeeRecipient` must be this bot's wallet.** It is the only address
allowed to sweep or claim. If it is wrong, the bot throws no error — it runs
forever, collects nothing, and looks healthy. Set it at launch, and check the
`feeRecip.` line of `npm run check`.

It is also **mutable after launch** (the factory exposes
`transferCreatorFeeRecipient`), so every cycle re-checks it and the operator
`/status` endpoint reports `feeRecipientOk`.

**2. Leave pons's "route creator fees to holders" toggle OFF.** Pons offers a
first-party version of this bot: a toggle that routes creator fees to a
per-token fee distributor which pushes payouts to holders automatically. It is a
perfectly good feature — Ryzen Kitty uses it — but **it is mutually exclusive
with this bot**, because switching it on reassigns `creatorFeeRecipient` to that
distributor contract and leaves the bot with nothing to claim.

Use the toggle if you want 100% to holders on pons's schedule. Use this bot if
you want a dev cut, a `MIN_HOLD` threshold, anti-sybil cluster caps, exclusions,
and your own trigger.

## Gas is not self-funding

The dev cut is SPCX; gas is ETH. Unlike an ETH-quoted launch, **the wallet cannot
refill its own gas from what it collects** — it needs an independently
topped-up ETH balance, and a few hundred transfers per cycle steadily drain it.

`GAS_RESERVE_ETH` guards this: below it, a cycle refuses to *start*, rather than
claiming the escrow and then failing to pay anyone out.

## API

The site's endpoints, unchanged by the bot's arrival. A field that cannot be
sourced is `null`, never `0` — the site hides a null tile but would render a
zero as a real number.

| Route | Returns |
| --- | --- |
| `GET /token` | name, ticker, contract address, chain |
| `GET /stats` | `marketCap`, `holders`, `totalRewarded`, `totalRewardedUsd`, `priceUsd`, `liquidityUsd` |
| `GET /rewards?cursor&limit` | the payout ledger — `{ transactions: [{ wallet, amount, txHash, timestamp }] }` |
| `GET /health` | `{ ok, uptimeSec }` |

All are mounted at both `/` and `/api`, so the site works whether or not `/api`
is in its base URL.

**Market cap survives every stage of the token's life**: DexScreener's pair →
Blockscout's circulating market cap → the pons bonding-curve price × SPCX/USD.
The last of those is what keeps the tile alive before graduation, when
DexScreener has nothing to say.

**`totalRewarded` and `/rewards` read this bot's own ledger.** Only payouts
carrying a real on-chain transaction hash are served, so `DRY_RUN` payouts —
recorded with a fabricated signature — can never reach a visitor and link them
to a transaction that does not exist.

### Operator API (bot.js, localhost only)

| Route | Does |
| --- | --- |
| `GET /status` | `feeRecipientOk`, claimable SPCX and its USD value, wallet gas, scheduler state |
| `POST /run` | run one cycle now (409 if one is already running) |
| `POST /pause` / `POST /resume` | stop and restart the schedule |

All require `x-api-key: $API_KEY`.

## Quick start

```bash
npm install
cp .env.example .env      # defaults are safe: DRY_RUN=true, ephemeral wallet
npm test                  # unit + integration, no network needed
npm run check             # read-only preflight — sends nothing
npm start                 # the public API
npm run bot               # the bot (separate terminal)
```

`npm run check` is the fastest way to tell a config mistake apart from a token
that simply has not launched yet. It prints every upstream, the launch record,
the `creatorFeeRecipient` verdict, what is claimable right now against the $100
gate, and whether the wallet has gas.

Both processes need MongoDB (a local `mongod`, or set `MONGODB_URI`).

## Config

Everything is documented in `.env.example`. The ones worth knowing first:

| Env | Default | Meaning |
| --- | --- | --- |
| `WALLET_PRIVATE_KEY` | — | must be SPACEINU's `creatorFeeRecipient`; `bot.js` only |
| `TOKEN_ADDRESS` | — | blank until launch → every stat is null |
| `REWARD_TOKEN_ADDRESS` | SPCX | the quote asset **and** the reward asset — one address, both roles |
| `CLAIM_EVERY_USD` | `100` | fire once the accrued SPCX is worth this |
| `REWARD_PCT` | `80` | share to holders; the rest is the dev cut |
| `MIN_HOLD` | `100000` | minimum SPACEINU balance to qualify |
| `REWARD_CAP_PCT` | `0` | per-wallet weight cap, % of supply (0 = pure pro-rata) |
| `DISPERSE_ADDRESS` | — | batch-transfer contract; blank → one transfer per recipient |
| `GAS_RESERVE_ETH` | `0.01` | below this the cycle refuses to start |
| `DRY_RUN` | `true` | simulate everything; the default everywhere |

## Airdrop at scale

Without `DISPERSE_ADDRESS`, the airdrop sends one ERC-20 transfer per recipient
(pipelined, up to `AIRDROP_BATCH_SIZE` in flight, with a locally-tracked nonce).
That is fine at a few hundred holders and expensive at a few thousand.

Deploy a Disperse contract and set `DISPERSE_ADDRESS` before the holder list
grows — each batch then becomes one `disperseToken` transaction. Note the reward
token needs an `approve()` to that contract first; the bot does not do this for
you.

## Going live

1. Launch SPACEINU on pons v2 paired with SPCX, with `creatorFeeRecipient` set
   to the bot wallet, and the holder-fee-sharing toggle **off**.
2. Set `TOKEN_ADDRESS` and `WALLET_PRIVATE_KEY` in `.env`.
3. Fund the wallet with ETH for gas.
4. `npm run check` — confirm the `feeRecip.` line shows ✓.
5. Watch a DRY_RUN cycle: `curl -H "x-api-key: $API_KEY" -XPOST localhost:3100/run`.
6. Set `DRY_RUN=false`, restart the bot, and watch the first live cycle.

## Deploying

See [`DEPLOY.md`](DEPLOY.md) — Ubuntu 24.04, Node 22, MongoDB, two PM2
processes, nginx and Certbot for `api.spaceinu.art`.

## Design

The spec is in
[`docs/superpowers/specs/2026-08-30-spaceinu-rewards-bot-design.md`](docs/superpowers/specs/2026-08-30-spaceinu-rewards-bot-design.md)
and the implementation plan in [`docs/superpowers/plans/`](docs/superpowers/plans/).
