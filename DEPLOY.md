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
node -v && npm -v      # expect v22.x
```

## 4. MongoDB 8.0

Required — the bot writes its payout ledger here and the API reads it. Ubuntu
24.04 is `noble`:

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
sudo systemctl status mongod --no-pager
```

It binds `127.0.0.1` only by default. Leave it that way — nothing external
needs it.

## 5. Clone into /var/www

```bash
sudo mkdir -p /var/www
sudo chown spaceinu:spaceinu /var/www/spaceinu 2>/dev/null || sudo mkdir -p /var/www/spaceinu
sudo chown -R spaceinu:spaceinu /var/www/spaceinu

sudo -u spaceinu git clone https://github.com/blockfile/spcxinu.git /var/www/spaceinu
cd /var/www/spaceinu
sudo -u spaceinu npm ci --omit=dev
```

## 6. Configure

```bash
sudo -u spaceinu cp .env.example .env
sudo -u spaceinu nano .env
sudo chmod 600 .env
sudo chown spaceinu:spaceinu .env
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

MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=spaceinu
API_KEY=                       # openssl rand -hex 32
CORS_ORIGINS=https://spaceinu.art,https://www.spaceinu.art
```

`CORS_ORIGINS` must include the scheme and every hostname the site is served
from — a Netlify preview domain too, if you use one, or the browser gets a 403
while curl works fine.

Preflight before starting anything. It sends no transactions:

```bash
sudo -u spaceinu npm run check
```

With `TOKEN_ADDRESS` blank it prints the config and a PRE-LAUNCH notice, which
is correct at this stage.

## 7. PM2 — both processes

```bash
sudo npm install -g pm2

cd /var/www/spaceinu
sudo -u spaceinu pm2 start server.js --name spaceinu-api --time
sudo -u spaceinu pm2 start bot.js    --name spaceinu-bot --time
sudo -u spaceinu pm2 save
sudo -u spaceinu pm2 logs
```

**One instance of each.** Cluster mode (`-i max`) would give the API workers
separate caches for no gain, and would run several schedulers against one wallet,
competing for the same nonce.

Boot persistence — run exactly the `sudo env PATH=... pm2 startup systemd -u
spaceinu ...` line it prints, then save again:

```bash
sudo -u spaceinu pm2 startup systemd
# paste and run the sudo line it outputs, then:
sudo -u spaceinu pm2 save
```

Log rotation:

```bash
sudo -u spaceinu pm2 install pm2-logrotate
sudo -u spaceinu pm2 set pm2-logrotate:max_size 20M
sudo -u spaceinu pm2 set pm2-logrotate:retain 14
sudo -u spaceinu pm2 set pm2-logrotate:compress true
```

Both alive?

```bash
curl http://127.0.0.1:3000/health
curl -H "x-api-key: $API_KEY" http://127.0.0.1:3100/status
```

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
sudo -u spaceinu pm2 logs spaceinu-bot --lines 40
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
sudo -u spaceinu nano .env      # set TOKEN_ADDRESS and WALLET_PRIVATE_KEY
sudo -u spaceinu npm run check  # the feeRecip. line MUST show ✓
```

Fund the wallet with **ETH for gas** — the bot's income is SPCX and cannot pay
for its own gas. Then:

```bash
sudo -u spaceinu pm2 restart spaceinu-bot --update-env   # still DRY_RUN=true
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/run
# read the cycle, then:
sudo -u spaceinu nano .env      # DRY_RUN=false
sudo -u spaceinu pm2 restart spaceinu-bot --update-env
sudo -u spaceinu pm2 logs spaceinu-bot
```

Stop the schedule at any time without touching the public API:

```bash
curl -H "x-api-key: $API_KEY" -X POST http://127.0.0.1:3100/pause
```

## Redeploying

```bash
cd /var/www/spaceinu
sudo -u spaceinu git pull
sudo -u spaceinu npm ci --omit=dev
sudo -u spaceinu pm2 restart spaceinu-api spaceinu-bot --update-env
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
