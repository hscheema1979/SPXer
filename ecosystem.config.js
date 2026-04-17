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
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-out.log',
      merge_logs: true,
    },

    // ── SPX Trading Agent (margin account) ────────────────────────
    {
      name: 'spxer-agent',
      script: 'npx',
      args: 'tsx agent.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: false,   // never auto-restart — crash mid-session risks double-entry
      max_restarts: 0,      // 0 = PM2 will not restart on crash
      min_uptime: '10s',
      restart_delay: 30000,
      kill_timeout: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        AGENT_PAPER: 'false',
        AGENT_CONFIG_ID: 'hma3x15-itm5-tp125x-sl25-3m-v3',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-agent-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-agent-out.log',
      merge_logs: true,
    },

    // ── XSP Trading Agent — ARCHIVED 2026-04-17 ───────────────────
    // Switched focus to SPX agent with new config (hma3x15-itm5-tp12x-sl20-3m-v2)
    // {
    //   name: 'spxer-xsp',
    //   script: 'npx',
    //   args: 'tsx agent-xsp.ts',
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
    //     AGENT_CONFIG_ID: 'hma3x15-itm5-tp12x-sl20-3m-v2',
    //   },
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss',
    //   error_file: '/home/ubuntu/.pm2/logs/spxer-xsp-error.log',
    //   out_file: '/home/ubuntu/.pm2/logs/spxer-xsp-out.log',
    //   merge_logs: true,
    // },

    // ── Watchdog — DISABLED ────────────────────────────────────────
    // Removed 2026-04-08: watchdog was cancelling OCO bracket orders
    // and killing agents on normal data staleness, leaving positions
    // unprotected. Caused ~$12K in avoidable losses over 2 days.
    // The account-monitor provides observation without destructive actions.
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

    // ── Live Dashboard (port 3602) ─────────────────────────────────
    {
      name: 'spxer-dashboard',
      script: 'npx',
      args: 'tsx src/dashboard/server.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 10000,
      kill_timeout: 5000,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: '3602',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/dashboard-error.log',
      out_file: '/home/ubuntu/.pm2/logs/dashboard-out.log',
      merge_logs: true,
    },

    // ── Account Monitor (LLM-powered oversight — both accounts) ──
    {
      name: 'account-monitor',
      script: 'npx',
      args: 'tsx account-monitor.ts',
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
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/xsp-monitor-error.log',
      out_file: '/home/ubuntu/.pm2/logs/xsp-monitor-out.log',
      merge_logs: true,
    },

    // ── Schwaber — Schwab ETF Trading Agent ───────────────────────
    {
      name: 'schwaber',
      script: 'npx',
      args: 'tsx schwaber.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 10000,
      kill_timeout: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        AGENT_PAPER: 'false',          // paper=true is set in schwaber-config.ts until you're ready
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/schwaber-error.log',
      out_file: '/home/ubuntu/.pm2/logs/schwaber-out.log',
      merge_logs: true,
    },

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
  ],
};
