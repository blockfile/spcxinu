# spaceinu-api — Design

Date: 2026-08-29
Status: approved (ticker flagged below)

## Purpose

Backend stats API for the **Space Inu** site — **spaceinu.tech**, API at
`api.spaceinu.tech`. It is a rebranded copy of `ryzenkitty-api`
(`d:\projects\ryzenkitty-api`, spec `2026-08-29-ryzenkitty-api-design.md`
there), with identical functions:

- `GET /token` — name, `$ticker`, contract address, chain.
- `GET /stats` — market cap, holders, total rewarded (token + USD), price.
- `GET /rewards?cursor&limit` — the live rewards feed (payouts out of the Pons
  fee distributor, read from Blockscout).
- `GET /health`, `GET /` — as before. Routers mounted at `/` and `/api`.

Token: **Space Inu** on **Robinhood Chain**, launching on the Pons V2 launchpad
paired with **SPCX** (tokenized SpaceX stock). Contract address is not yet
known — every stat resolves to `null` (never `0`) and the feed to an empty page
until `TOKEN_ADDRESS` is set.

## Substitutions from ryzenkitty-api

| ryzenkitty-api                                   | spaceinu-api                                  |
| ------------------------------------------------ | --------------------------------------------- |
| package `ryzenkitty-api`, log prefix `[ryzenkitty]` | `spaceinu-api`, `[spaceinu]`               |
| `TOKEN_SYMBOL` default `RYZEN`, name `Ryzen Kitty` | `SPACEINU`, `Space Inu`                     |
| site `ryzenkitty.meme` (CORS, homepage, User-Agent) | `spaceinu.tech`, `www.spaceinu.tech`       |
| reward asset AMD `0x86923f…3fdC`                 | **SPCX** `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` ("Space Exploration Technologies Corp • Robinhood Token", 18 decimals) |
| `/stats.amdRewarded`                             | `/stats.spcxRewarded` (+ generic `rewarded`)  |

Everything else — services, cache, cursor scheme, error rules, Cloudflare
User-Agent, supply fallback, tests — is unchanged apart from the wording.

## Reward asset — verified 2026-08-29

`0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa` on Robinhood Chain:

- Blockscout: name "Space Exploration Technologies Corp • Robinhood Token",
  symbol **SPCX**, 18 decimals, ~59k holders.
- DexScreener (`chainId: robinhood`): Uniswap V3 pools vs USDG (~$860k
  liquidity) and WETH, price ≈ $140.6 — so the SPCX/USD leg that converts the
  bonding-curve price and the rewarded total to USD is reliable, and a "no
  pair" answer is treated as an upstream glitch (throws, cache keeps last good).
- Pons: `/api/pons-v2-market/{SPCX}/distributor` answers "Fee sharing is not
  available for this token" — confirming SPCX is the **quote/reward asset**,
  not a launchpad token. (`spacecat-api` used SPCX in the same role.)

## `GET /stats` response

```json
{
  "marketCap": 4189702,
  "holders": 12879,
  "totalHolders": 12879,
  "totalRewarded": 826.7,
  "ketDistributed": 826.7,
  "totalRewardedUsd": 116234.0,
  "spcxRewarded": 116234.0,
  "rewarded": 116234.0,
  "priceUsd": 0.0000042,
  "price": 0.0000042,
  "liquidityUsd": 120000,
  "symbol": "SPACEINU",
  "tokenAddress": null,
  "updatedAt": "2026-08-29T12:00:00.000Z"
}
```

- `totalRewarded` / `ketDistributed` — SPCX token amount paid to holders (the
  Meme1 template's "Total $… Distributed" panel renders it without a `$`).
- `spcxRewarded` / `rewarded` — the same total in USD, for the frontends that
  read `raw.<asset>Rewarded ?? raw.rewarded`.
- Market cap prefers DexScreener, then Blockscout `circulating_market_cap`,
  then bonding-curve price × supply (supply from Blockscout, falling back to
  `TOKEN_TOTAL_SUPPLY`).

## Frontend

Expected to be a copy of the ryzen `Meme1` template (`d:\projects\ryzen\Meme1`):
`GET /token` once (reads `ticker`), `GET /stats` for `marketCap` +
`ketDistributed`, `GET /rewards` polled every 15 s reading `transactions[]`.
No API changes are needed for it. Its `.env.local`: `VITE_USE_MOCK=false`,
`VITE_API_BASE_URL=https://api.spaceinu.tech`. Its `src/config/site.js` should
carry `rewardTicker: '$SPCX'` and
`rewardContractAddress: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa'`.

## Flagged assumptions

1. **Ticker.** No Space Inu frontend existed at design time, so `TOKEN_SYMBOL`
   defaults to `SPACEINU` and `TOKEN_NAME` to `Space Inu`. The site prefers the
   API's ticker over its own fallback, so set `TOKEN_SYMBOL` in the deployed
   `.env` to whatever the site's `SITE.ticker` is (without the `$`).
2. **Reward asset is SPCX** — verified on-chain above; still an env default
   (`REWARD_TOKEN_ADDRESS`, `REWARD_DECIMALS`).
3. `ketDistributed` is the SPCX **token amount**; swap to `totalRewardedUsd` in
   `buildStats` if the site wants dollars there.

## Launch checklist

1. Set `TOKEN_ADDRESS` (and confirm `TOKEN_SYMBOL`, `TOKEN_TOTAL_SUPPLY`) in
   `.env`; run `npm run check` to see every upstream's answer.
2. Pons creates the fee distributor some time after launch — until then
   `ketDistributed`/rewards are null and the feed is empty (a real state, not a
   fault). `DISTRIBUTOR_ADDRESS` can pin it if the Pons API is down.

## Delivery

New repo at `d:\projects\spaceinu-api`, initial commit, remote
`https://github.com/blockfile/spcxinu.git`, push `main`.
