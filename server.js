'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const { router: statsRouter } = require('./src/routes/stats');
const { router: rewardsRouter } = require('./src/routes/rewards');
const { router: tokenRouter } = require('./src/routes/token');

const app = express();
app.disable('x-powered-by');
// Behind nginx — trust its X-Forwarded-* headers so req.ip is the real client.
app.set('trust proxy', 1);

// CORS allowlist — non-browser requests (no Origin) always pass; browsers are
// restricted to config.corsOrigins (or any origin if it contains "*").
const allowAll = config.corsOrigins.includes('*');
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowAll || config.corsOrigins.includes(origin)) return cb(null, true);
      const err = new Error(`origin ${origin} not allowed by CORS`);
      err.corsRejected = true; // handled quietly below — copycat sites spam this
      return cb(err);
    },
  })
);

app.get('/', (req, res) => {
  res.json({
    name: 'spaceinu-api',
    description: 'SPACEINU market cap, holder count, total SPCX rewarded and the live rewards feed for the Space Inu site',
    token: { symbol: config.tokenSymbol, address: config.tokenAddress },
    endpoints: ['GET /token', 'GET /stats', 'GET /rewards?cursor&limit', 'GET /health'],
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

// Mounted twice so the site works whether VITE_API_BASE_URL is set to
// https://api.<site> or https://api.<site>/api.
for (const base of ['/', '/api']) {
  app.use(base, tokenRouter);
  app.use(base, statsRouter);
  app.use(base, rewardsRouter);
}

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Disallowed origins (copycat sites embedding this API) get a terse 403 and at
// most ONE log line per origin — not a stack trace per request.
const loggedBlockedOrigins = new Set();

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.corsRejected) {
    const origin = req.get('origin') || 'unknown';
    if (!loggedBlockedOrigins.has(origin)) {
      loggedBlockedOrigins.add(origin);
      console.warn(`[spaceinu] blocking CORS origin: ${origin}`);
    }
    return res.status(403).json({ error: 'origin not allowed' });
  }
  console.error('[spaceinu] request error:', err);
  res.status(500).json({ error: err.message });
});

let server;

if (require.main === module) {
  server = app.listen(config.port, () => {
    console.log(`[spaceinu] listening on http://localhost:${config.port}`);
    console.log(
      `[spaceinu] token=${config.tokenSymbol} address=${config.tokenAddress || '(not set — stats will be null)'}`
    );
    console.log(`[spaceinu] cors=${config.corsOrigins.join(', ')}`);
  });

  const shutdown = (signal) => {
    console.log(`\n[spaceinu] ${signal} received, shutting down`);
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
