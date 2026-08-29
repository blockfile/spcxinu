# Deploying spaceinu to Ubuntu 24.04

Two PM2 processes over one MongoDB:

| Process | Port | Reachable from |
| --- | --- | --- |
| `spaceinu-api` (`server.js`) | 3000 | the internet, via nginx → `api.spaceinu.art` |
| `spaceinu-bot` (`bot.js`) | 3100 | **localhost only** — never proxied |

The bot holds the wallet key and `POST /run` pays real money out, so its port
stays off the internet. That separation is the point of the split; do not
collapse it back into one process.

**Before you start:** point a DNS `A` record for `api.spaceinu.art` at the
server's public IP and let it propagate (`dig +short api.spaceinu.art`).
Certbot cannot issue a certificate until it resolves.

## 1. Base prep

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw ca-certificates gnupg
sudo timedatectl set-timezone UTC
sudo adduser --disabled-password --gecos "" spaceinu
```

## 2. Firewall

Only SSH and web. Neither app port is exposed.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 3. Node.js 22 LTS

`package.json` requires Node >= 20 and the code uses global `fetch`.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v      # expect v22.x
```

## 4. MongoDB 8.0

Both processes share it. Ubuntu 24.04 is `noble`:

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

It listens on `127.0.0.1` only by default — leave it that way.

## 5. Clone and configure

```bash
sudo su - spaceinu
git clone https://github.com/blockfile/spcxinu.git ~/spaceinu
cd ~/spaceinu
npm ci --omit=dev

cp .env.example .env
nano .env
chmod 600 .env          # do this — it holds the wallet key
```

Minimum production values:

```ini
PORT=3000
BOT_PORT=3100
TOKEN_ADDRESS=                 # blank until SPACEINU launches
TOKEN_SYMBOL=SPACEINU
WALLET_PRIVATE_KEY=            # SPACEINU's creatorFeeRecipient
DRY_RUN=true                   # keep true for the first deploy
TRIGGER_MODE=accumulation
CLAIM_EVERY_USD=100
REWARD_PCT=80
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=spaceinu
API_KEY=                       # openssl rand -hex 32
CORS_ORIGINS=https://spaceinu.art,https://www.spaceinu.art
```

`CORS_ORIGINS` must include the scheme and every hostname the site is served
from — a Netlify preview domain too, if you use one, or the browser gets a 403
while curl works fine.

Verify before starting anything:

```bash
npm run check
```

## 6. PM2 — both processes

```bash
sudo npm install -g pm2
cd ~/spaceinu

pm2 start server.js --name spaceinu-api --time
pm2 start bot.js    --name spaceinu-bot --time
pm2 save
pm2 logs
```

**One instance of each.** Cluster mode (`-i max`) would give the API workers
separate caches for no benefit, and would run several schedulers against one
wallet — competing for the same nonce.

Boot persistence — run exactly the `sudo env PATH=... pm2 startup systemd -u
spaceinu ...` line it prints, then save again:

```bash
pm2 startup systemd
# paste and run the sudo line it outputs, then:
pm2 save
```

Log rotation:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

Check both are alive:

```bash
curl http://127.0.0.1:3000/health
curl -H "x-api-key: $API_KEY" http://127.0.0.1:3100/status
```

## 7. nginx

```bash
sudo apt install -y nginx
```

Note this proxies **only** port 3000. The bot's 3100 is deliberately absent.

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

## 8. Certbot / HTTPS

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

## 9. Verify end to end

```bash
curl https://api.spaceinu.art/token
curl https://api.spaceinu.art/stats
curl "https://api.spaceinu.art/rewards?limit=5"

# CORS — must echo the origin back
curl -s -H "Origin: https://spaceinu.art" -D- -o /dev/null \
  https://api.spaceinu.art/stats | grep -i access-control-allow-origin

# The bot must NOT be reachable from outside
curl -m 5 https://api.spaceinu.art:3100/status   # must fail/timeout
```

A 403 on the CORS check means the origin is missing from `CORS_ORIGINS` — the
usual reason the site shows placeholder data against a working API.

Then set the site's `VITE_API_BASE_URL=https://api.spaceinu.art` and redeploy it.

## 10. Going live

Stay on `DRY_RUN=true` for a while and watch `pm2 logs spaceinu-bot`. Then:

```bash
nano .env                       # set TOKEN_ADDRESS, WALLET_PRIVATE_KEY
npm run check                   # the feeRecip. line MUST show ✓
# fund the wallet with ETH for gas — the dev cut is SPCX and will not cover it

curl -H "x-api-key: $API_KEY" -XPOST http://127.0.0.1:3100/run   # one dry cycle
nano .env                       # DRY_RUN=false
pm2 restart spaceinu-bot --update-env
pm2 logs spaceinu-bot           # watch the first live cycle
```

If anything looks wrong, stop the schedule immediately without killing the API:

```bash
curl -H "x-api-key: $API_KEY" -XPOST http://127.0.0.1:3100/pause
```

## Redeploying

```bash
sudo su - spaceinu
cd ~/spaceinu
git pull
npm ci --omit=dev
pm2 restart spaceinu-api spaceinu-bot --update-env
```

## Operational watch-list

- **Wallet ETH.** Gas is not self-funding here — the dev cut is SPCX. Watch
  `wallet.ethBalance` against `gasReserveEth` in `GET /status`; below the
  reserve, cycles refuse to start.
- **`feeRecipientOk`.** If this flips to `false`, the launch is paying someone
  else. The usual cause is pons's "route creator fees to holders" toggle being
  switched on, which reassigns the recipient to a distributor contract.
- **`DISPERSE_ADDRESS`.** Set it before the holder count grows, or every cycle
  pays for one transaction per recipient.
