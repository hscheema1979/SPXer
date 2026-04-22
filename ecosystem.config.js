// SPXer PM2 Ecosystem Configuration
//
// All SPXer processes: data service, trading agents, replay viewer.
//
// Usage:
//   pm2 start ecosystem.config.js           # start all
//   pm2 start ecosystem.config.js --only spxer   # start one
//   pm2 restart spxer                       # restart one
//   pm2 logs spxer --lines 50              # view logs
//   pm2 save                                # persist across reboots
//
module.exports = {
  apps: [
    // ── Data Service (port 3600) ──────────────────────────────────
    {
      name: 'spxer',
      script: 'npx',
      args: 'tsx src/index.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',          // must run 10s to count as "started"
      restart_delay: 10000,       // 10s between restarts (let port release)
      kill_timeout: 5000,         // give 5s to shut down cleanly
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: '3600',
        AGENT_CONFIG_ID: 'spx-hma3x12-itm5-tp125x-sl20-3m-25c-$50000',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-out.log',
      merge_logs: true,
    },

    // ── SPX Solo Agent (margin account) — INACTIVE, replaced by basket ──
    // To revert: uncomment this block, comment out basket agents below,
    // then: pm2 stop basket-itm5 basket-atm basket-otm5 && pm2 start ecosystem.config.js --only spxer-agent
    // {
    //   name: 'spxer-agent',
    //   script: 'npx',
    //   args: 'tsx spx_agent.ts',
    //   cwd: '/home/ubuntu/SPXer',
    //   watch: false,
    //   autorestart: false,
    //   max_restarts: 0,
    //   min_uptime: '10s',
    //   restart_delay: 30000,
    //   kill_timeout: 5000,
    //   max_memory_restart: '512M',
    //   env: {
    //     NODE_ENV: 'production',
    //     AGENT_PAPER: 'false',
    //     AGENT_CONFIG_ID: 'spx-hma3x12-itm5-tp125x-sl20-3m-25c-$50000',
    //     AGENT_TAG: 'spx-margin',
    //   },
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss',
    //   error_file: '/home/ubuntu/.pm2/logs/spxer-agent-error.log',
    //   out_file: '/home/ubuntu/.pm2/logs/spxer-agent-out.log',
    //   merge_logs: true,
    // },

    // ── Watchdog — DISABLED ────────────────────────────────────────
    // Removed 2026-04-08: watchdog was cancelling OCO bracket orders
    // and killing agents on normal data staleness, leaving positions
    // unprotected. Caused ~$12K in avoidable losses over 2 days.
    // Account-monitor also removed — was interfering with successful trades.
    // If re-enabled, the rewritten version in src/watchdog/index.ts
    // never cancels OCO orders and uses 5-min restart thresholds.
    // {
    //   name: 'spxer-watchdog',
    //   script: 'npx',
    //   args: 'tsx src/watchdog/index.ts',
    //   cwd: '/home/ubuntu/SPXer',
    //   watch: false,
    //   autorestart: false,
    //   ...
    // },

    // ── Live Dashboard — REMOVED 2026-04-20 ─────────────────────────
    // Standalone dashboard on port 3602 was never integrated with replay/leaderboard.
    // Live view is now built into the replay viewer (port 3601) at /replay/#live.
    // src/dashboard/ directory retained for potential devops monitoring reuse.

    // ── Account Monitor — REMOVED 2026-04-18 ───────────────────────
    // ── Schwaber — REMOVED 2026-04-18 ─────────────────────────────

    // ── SPX Live Agent (margin account 6YA51425) — SINGLE AGENT ──────
    // CRITICAL: Only ONE agent process may target each broker account.
    // On 2026-04-21, 6 basket agents (runner-itm5/atm/otm5 + scalp-itm5/atm/otm5)
    // all placed live OTOCO orders on 6YA51425 simultaneously — 89 bracket orders.
    // Agents collided during broker reconciliation, causing phantom positions and
    // sell rejections. The basket strategy is DISABLED until separate accounts are
    // provisioned for each agent.
    //
    // The account-lock module (src/agent/account-lock.ts) enforces this at runtime:
    // if a second agent tries to start on the same account, it exits immediately.
    //
    // To re-enable basket agents: assign each a DIFFERENT TRADIER_ACCOUNT_ID,
    // then uncomment the entries below.
    {
      name: 'spxer-agent',
      script: 'npx',
      args: 'tsx spx_agent.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: false,
      max_restarts: 0,
      min_uptime: '10s',
      restart_delay: 30000,
      kill_timeout: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        AGENT_PAPER: 'false',
        TRADIER_ACCOUNT_ID: '6YA51425',
        AGENT_CONFIG_ID: 'spx-hma3x12-itm5-basket-3strike-tp125x-sl25-3m-15c-$10000:itm5',
        AGENT_TAG: 'spx-margin',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-agent-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-agent-out.log',
      merge_logs: true,
    },

    // ── DISABLED Basket Agents ──────────────────────────────────────
    // All shared account 6YA51425 — cannot run concurrently.
    // To re-enable: assign separate TRADIER_ACCOUNT_ID per agent.
    //
    // Runner basket (TP 1.25x): runner-itm5, runner-atm, runner-otm5
    // Scalp basket  (TP 10x):   scalp-itm5, scalp-atm, scalp-otm5
    //
    // {
    //   name: 'runner-atm',
    //   script: 'npx', args: 'tsx spx_agent.ts', cwd: '/home/ubuntu/SPXer',
    //   env: { AGENT_PAPER: 'false', TRADIER_ACCOUNT_ID: '<SEPARATE_ACCOUNT>', AGENT_CONFIG_ID: '...', AGENT_TAG: 'runner-atm' },
    // },
    // ... (5 more basket agents — see git history for full definitions)

    // ── Metrics Collector ───────────────────────────────────────────
    {
      name: 'metrics-collector',
      script: 'npx',
      args: 'tsx src/ops/metrics-collector.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 30000,
      kill_timeout: 5000,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/metrics-collector-error.log',
      out_file: '/home/ubuntu/.pm2/logs/metrics-collector-out.log',
      merge_logs: true,
    },

    // ── Replay Viewer (port 3601) ─────────────────────────────────
    {
      name: 'replay-viewer',
      script: 'npx',
      args: 'tsx src/server/replay-server.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 10000,
      kill_timeout: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        REPLAY_PORT: '3601',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/replay-viewer-error.log',
      out_file: '/home/ubuntu/.pm2/logs/replay-viewer-out.log',
      merge_logs: true,
    },
    {
      // Daily journal — runs at 4:15 PM ET (20:15 UTC in EDT, 21:15 UTC in EST)
      // Generates a detailed markdown trading report from broker data (source of truth).
      // Output: logs/journals/YYYY-MM-DD.md
      name: 'daily-journal',
      script: 'npx',
      args: 'tsx scripts/daily-journal.ts',
      cwd: '/home/ubuntu/SPXer',
      cron_restart: '15 20,21 * * 1-5',
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/daily-journal-error.log',
      out_file: '/home/ubuntu/.pm2/logs/daily-journal-out.log',
      merge_logs: true,
    },
    {
      // Daily backfill — runs at 4:30 PM ET (20:30 UTC in EDT, 21:30 UTC in EST)
      // Auto-discovers ALL profiles with replay data (SPX, NDX, etc.) and backfills
      // today's underlying + options + MTFs + indicators for each.
      // Uses 20:30 UTC (EDT) — during EST this fires at 3:30 PM ET which is
      // before close, so the script detects no data and exits as a no-op.
      // The 21:30 UTC cron covers EST months.
      name: 'daily-backfill',
      script: 'npx',
      args: 'tsx scripts/backfill/daily-backfill.ts',
      cwd: '/home/ubuntu/SPXer',
      cron_restart: '30 20,21 * * 1-5',
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/daily-backfill-error.log',
      out_file: '/home/ubuntu/.pm2/logs/daily-backfill-out.log',
      merge_logs: true,
    },
  ],
};
