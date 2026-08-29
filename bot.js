'use strict';

// The bot process.
//
// This is the ONLY process that loads the wallet private key. server.js serves
// the public API and never touches it, so a compromise of the internet-facing
// service reaches no signing key.
//
// Its HTTP surface exists purely for operators and binds to 127.0.0.1, so it is
// reachable only over SSH. Do not proxy this port from nginx: POST /run pays
// real money out.

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

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[spaceinu-bot] request error:', err);
  res.status(500).json({ error: err.message });
});

let server;

async function main() {
  await db.connect();
  console.log(`[spaceinu-bot] MongoDB connected (${config.mongoDb})`);

  server = app.listen(config.botPort, '127.0.0.1', () => {
    console.log(`[spaceinu-bot] operator API on http://127.0.0.1:${config.botPort} (localhost only)`);
    console.log(`[spaceinu-bot] dryRun=${config.dryRun} wallet=${walletAddress()}`);
    console.log(
      `[spaceinu-bot] token=${config.tokenSymbol} ${config.tokenAddress || '(TOKEN_ADDRESS not set — cycles will fail)'}`
    );
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

module.exports = app;
