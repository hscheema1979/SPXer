// SPXer PM2 Ecosystem Configuration
//
// SPXer is a BACKTEST + BACKFILL system. Live trading lives in OptionX, not here.
// Two long-lived processes: the live-capture daemon and the daily backfill cron.
//
// The old `replay-viewer` (:3601) entry was REMOVED (FR-001, 2026-08-20):
// src/server/replay-server.ts was deleted in a32fe0e1a and the entry pointed
// at a dead file. The backtest studio (:3700) is run on demand — see
// scripts/autoresearch/backtest-server.ts — not managed here.
//
// Usage:
//   pm2 start ecosystem.config.js                 # start all
//   pm2 restart live-capture
//   pm2 logs live-capture --lines 50
//   pm2 save                                      # persist across reboots
//
module.exports = {
  apps: [
    // ── Live Capture (cron start, self-exits at close) ────────────
    // Polygon + ThetaData are cancelled; Tradier is the only remaining market
    // data source. This daemon polls Tradier once/minute during RTH and appends
    // the ATM±10% option chain (bid/ask + greeks + live BS delta) to
    // data/parquet/snapshots/{profile}/ and OHLCV to data/parquet/bars/{profile}/
    // for SPX/NDX/XSP 0DTE + SPY/QQQ 1DTE. It waits for the open, exits after
    // the close (autorestart:false), and is restarted next morning by cron.
    //
    // Fires at 13:25 AND 14:25 UTC to cover EDT (9:25 ET) and EST (9:25 ET); the
    // off-season fire lands at 10:25 ET and simply RESUMES from that day's
    // SQLite (data/live-capture/{date}.db), which is keyed by (profile,ts,symbol),
    // so re-firing never double-counts or loses captured minutes.
    {
      name: 'live-capture',
      script: 'npx',
      args: 'tsx scripts/live/live-capture.ts',
      cwd: '/home/ubuntu/SPXer',
      cron_restart: '25 13,14 * * 1-5',
      autorestart: false,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        // TRADIER_TOKEN is loaded from /home/ubuntu/SPXer/.env by dotenv.
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/live-capture-error.log',
      out_file: '/home/ubuntu/.pm2/logs/live-capture-out.log',
      merge_logs: true,
    },

    // ── Daily Backfill (cron) ─────────────────────────────────────
    // Runs at 4:30 PM ET (20:30 UTC in EDT, 21:30 UTC in EST). Auto-discovers
    // ALL profiles with replay data (SPX, NDX, etc.) and backfills today's
    // underlying + options + MTFs + indicators for each. The 21:30 UTC cron
    // covers EST months (the 20:30 fire is a no-op pre-close during EST).
    {
      name: 'daily-backfill',
      script: 'npx',
      args: 'tsx scripts/backfill/daily-backfill.ts',
      cwd: '/home/ubuntu/SPXer',
      cron_restart: '30 20,21 * * 1-5',
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
        DB_PATH: '/home/ubuntu/SPXer/data/spxer.db',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/daily-backfill-error.log',
      out_file: '/home/ubuntu/.pm2/logs/daily-backfill-out.log',
      merge_logs: true,
    },
  ],
};
