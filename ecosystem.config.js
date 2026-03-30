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
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 10000,
      kill_timeout: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        AGENT_PAPER: 'false',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-agent-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-agent-out.log',
      merge_logs: true,
    },

    // ── XSP Trading Agent (cash account) ──────────────────────────
    {
      name: 'spxer-xsp',
      script: 'npx',
      args: 'tsx agent-xsp.ts',
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
        AGENT_PAPER: 'false',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-xsp-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-xsp-out.log',
      merge_logs: true,
    },

    // ── XSP Monitor (LLM-powered position/order oversight) ───────
    {
      name: 'xsp-monitor',
      script: 'npx',
      args: 'tsx agent-xsp-monitor.ts',
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
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/xsp-monitor-error.log',
      out_file: '/home/ubuntu/.pm2/logs/xsp-monitor-out.log',
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
