# Deploying spaceinu to Ubuntu 24.04

Site: **https://spaceinu.art** · API: **https://api.spaceinu.art**

Two PM2 processes over one MongoDB, from `/var/www/spaceinu`:

| Process | Port | Reachable from |
| --- | --- | --- |
| `spaceinu-api` (`server.js`) | 3000 | the internet, via nginx → `api.spaceinu.art` |
| `spaceinu-bot` (`bot.js`) | 3100 | **localhost only** — never proxied |

The bot holds the wallet key and `POST /run` pays real money out, so its port
stays off the internet. Do not collapse the two back into one process.

**Before you start:** point a DNS `A` record for `api.spaceinu.art` at the
server's public IP and let it propagate (`dig +short api.spaceinu.art`).
Certbot cannot issue a certificate until it resolves.

## 1. Base prep

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw ca-certificates gnupg
sudo timedatectl set-timezone UTC
```

A dedicated system user owns the code and runs both processes — neither needs
root, and the `.env` holding the wallet key should not be readable by anyone
else:

```bash
sudo adduser --system --group --shell /bin/bash --home /var/www/spaceinu spaceinu
```

## 2. Firewall

Only SSH and web. Neither app port is exposed.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 3. Node.js 22 LTS + npm

`package.json` requires Node >= 20 and the code uses the global `fetch`.
Ubuntu's own repo ships an older Node, so use NodeSource. npm comes with it.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
node -v && npm -v && pm2 -v
```

## 4. MongoDB — pick ONE

The bot writes its payout ledger here and the API reads it. Either a hosted URI
or a local server; you do not need both.

### Option A: a hosted URI (Atlas or similar) — nothing to install

Skip straight to the next step and put the connection string in `.env` later:

```ini
MONGODB_URI=mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=spaceinu
```

**Allowlist the server's IP in the provider's network settings.** This is the
single most common reason a fresh deployment appears to hang: the driver waits
out its server-selection timeout on every connect, and PM2 restarts the process
into the same wait. Get the IP with `curl -s ifconfig.me`.

Verify from the server before starting anything:

```bash
cd /var/www/spaceinu
node -e "require('dotenv').config();const{MongoClient}=require('mongodb');const c=new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:5000});c.connect().then(()=>c.db().admin().ping()).then(()=>console.log('mongo OK')).catch(e=>console.error('mongo FAILED:',e.message)).finally(()=>c.close())"
```

### Option B: a local mongod

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

It binds `127.0.0.1` only by default. Leave it that way; then
`MONGODB_URI=mongodb://127.0.0.1:27017`.

## 5. Clone into /var/www

Create the directory as root, hand it to the service user, then **switch to that
user once** — everything from here until nginx runs as `spaceinu`, so nothing
ends up root-owned:

```bash
sudo mkdir -p /var/www/spaceinu
sudo chown -R spaceinu:spaceinu /var/www/spaceinu

sudo su - spaceinu
cd /var/www/spaceinu
git clone https://github.com/blockfile/spcxinu.git .
npm ci --omit=dev
```

## 6. Configure

Still as `spaceinu`:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Values for this deployment:

```ini
PORT=3000
BOT_PORT=3100

TOKEN_ADDRESS=                 # blank until SPACEINU launches
TOKEN_SYMBOL=SPACEINU
TOKEN_NAME=Space Inu

WALLET_PRIVATE_KEY=            # the dev/creator wallet — blank while DRY_RUN=true
DRY_RUN=true

TRIGGER_MODE=accumulation
CLAIM_EVERY_USD=100
REWARD_PCT=80
BURN_PCT=20
DEV_PAYOUT_ADDRESS=            # blank: no dev cut at 80/20

MONGODB_URI=                   # your hosted URI, or mongodb://127.0.0.1:27017
MONGODB_DB=spaceinu
API_KEY=                       # openssl rand -hex 32
CORS_ORIGINS=https://spaceinu.art,https://www.spaceinu.art
```

`CORS_ORIGINS` must include the scheme and every hostname the site is served
from — a preview domain too, if you use one, or the browser gets a 403 while
curl works fine.

Preflight. It sends no transactions:

```bash
npm run check
```

With `TOKEN_ADDRESS` blank it prints the config and a PRE-LAUNCH notice, which
is correct at this stage. If it cannot reach the database it says so here,
before PM2 is involved.

## 7. PM2 — one command for both

The repo ships `ecosystem.config.js`, so both processes start together. Still as
`spaceinu`:

```bash
cd /var/www/spaceinu
pm2 start ecosystem.config.js
pm2 save
pm2 status
```

That is the whole thing. Two more are worth running **once**, then never again:

```bash
pm2 startup systemd         # prints ONE sudo line — run it, then `pm2 save`
pm2 install pm2-logrotate   # keeps logs from filling the disk
```

`ecosystem.config.js` pins both to `fork` mode at one instance each. Cluster
mode would give the API workers separate caches for no gain, and would run
several schedulers against one wallet, each building transactions from the same
nonce.

Check both are alive — note `--nostream`, or the command tails forever:

```bash
pm2 status
pm2 logs --nostream --lines 30
curl http://127.0.0.1:3000/health
```

Then `exit` back to your sudo user for nginx.

## 8. nginx

```bash
sudo apt install -y nginx
```

This proxies **only** port 3000. The bot's 3100 is deliberately absent.

```bash
sudo tee /etc/nginx/sites-available/api.spaceinu.art > /dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name api.spaceinu.art;

    access_log /var/log/nginx/spaceinu.access.log;
    error_log  /var/log/nginx/spaceinu.error.log;

    client_max_body_size 1m;

    # The PUBLIC API only. Never add a location for the bot's port (3100):
    # POST /run there pays real money out and is meant to be SSH-only.
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
NGINX

sudo ln -s /etc/nginx/sites-available/api.spaceinu.art /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
curl http://api.spaceinu.art/health
```

## 9. Certbot / HTTPS

The site is HTTPS, so the API must be — a browser on `https://spaceinu.art`
refuses to fetch `http://api.spaceinu.art` as mixed content.

```bash
sudo snap install core && sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot

sudo certbot --nginx -d api.spaceinu.art --redirect \
  -m you@example.com --agree-tos --no-eff-email

sudo certbot renew --dry-run
systemctl list-timers | grep certbot
```

## 10. Verify

```bash
curl https://api.spaceinu.art/health
curl https://api.spaceinu.art/token
curl https://api.spaceinu.art/stats
curl "https://api.spaceinu.art/rewards?limit=5"

# CORS — must echo the site's origin back
curl -s -H "Origin: https://spaceinu.art" -D- -o /dev/null \
  https://api.spaceinu.art/stats | grep -i access-control-allow-origin

# The bot must NOT be reachable from outside
curl -m 5 http://api.spaceinu.art:3100/status   # must fail or time out
```

A 403 on the CORS check means the origin is missing from `CORS_ORIGINS` — the
usual reason the site shows placeholder data against a working API.

Then point the site at it (`VITE_API_BASE_URL=https://api.spaceinu.art`) and
redeploy the frontend.

## 11. Dry run

Everything above runs with `DRY_RUN=true`, which simulates every on-chain call
against an in-memory fee vault. No key, no RPC and no funds are involved.

Force a cycle and read it:

```bash
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/run
pm2 logs spaceinu-bot --lines 40
```

A healthy dry cycle looks like:

```
[cycle 1] claimed 0.05 SPCX
[cycle 1] split: 0.04 to holders (80%), 0.01 to buyback+burn (20%), 0 to dev (0%)
[cycle 1] [reward] airdrop SPCX sent=2 failed=0
[cycle 1] buyback bought 9896 SPACEINU for 0.01 SPCX and burned it
[cycle 1] complete — airdrop sent 2
```

Simulated payouts are recorded with a fabricated signature, so they stay out of
the public feed by design — `GET /stats` will still show `totalRewarded: 0` and
`totalBurned: 0`. That is correct, not a bug.

Leave it here until the token launches.

## 12. Going live (after launch)

```bash
cd /var/www/spaceinu
nano .env      # set TOKEN_ADDRESS and WALLET_PRIVATE_KEY
npm run check  # the feeRecip. line MUST show ✓
```

Fund the wallet with **ETH for gas** — the bot's income is SPCX and cannot pay
for its own gas. Then:

```bash
pm2 restart spaceinu-bot --update-env   # still DRY_RUN=true
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/run
# read the cycle, then:
nano .env      # DRY_RUN=false
pm2 restart spaceinu-bot --update-env
pm2 logs spaceinu-bot
```

Stop the schedule at any time without touching the public API:

```bash
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/pause
```

## Redeploying

```bash
cd /var/www/spaceinu
git pull
npm ci --omit=dev
pm2 restart spaceinu-api spaceinu-bot --update-env
```

## Operational watch-list

- **Wallet ETH.** Gas is not self-funding — income is SPCX. Watch
  `wallet.ethBalance` against `gasReserveEth` in `GET /status`; below the
  reserve, cycles refuse to start rather than claiming and failing to pay out.
- **`feeRecipientOk`.** If this flips to `false`, the launch is paying someone
  else. The usual cause is pons's "route creator fees to holders" toggle being
  switched on, which reassigns the recipient to a distributor contract.
- **`DISPERSE_ADDRESS`.** Only worth setting once holder count makes
  per-recipient gas hurt — and it must be an ERC-20 disperser exposing
  `disperseToken(address,address[],uint256[])`, with SPCX approved to it first.

## Troubleshooting

**Everything hangs / PM2 keeps restarting.** Almost always the database. The
driver waits out its server-selection timeout, the process exits, PM2 restarts
it, and it waits again. Check with:

```bash
pm2 logs --nostream --lines 40
pm2 status                   # a climbing ↺ restart count is the tell
```

On a hosted URI, the usual cause is the server's IP not being allowlisted in the
provider's network settings — see step 4. On a local mongod,
`sudo systemctl status mongod`.

**`pm2 logs` never returns.** That is not a hang; it tails. Ctrl+C, and use
`pm2 logs --nostream --lines 50` for a one-shot read.

**`npm run check` prints PRE-LAUNCH and stops.** Correct with `TOKEN_ADDRESS`
blank — there is nothing on chain to inspect yet.

**`/stats` shows zeros through a DRY_RUN cycle.** Also correct. Simulated
payouts carry a fabricated signature and are deliberately excluded from the
public numbers, so visitors are never shown invented rewards.

**The site shows placeholder data against a working API.** Almost always CORS:
`CORS_ORIGINS` must contain the exact origin including the scheme. Confirm with
the `Origin:` curl in step 10 — a 403 there is the answer.
