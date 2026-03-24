// SPXer PM2 Ecosystem Configuration
//
// This file defines the production PM2 configuration for spxer data service
// and spxer-agent. Both services use tsx for direct TypeScript execution
// (not compiled JS).
//
// To start: pm2 start /home/ubuntu/SPXer/ecosystem.config.js
// To restart: pm2 restart spxer
// To reload: pm2 reload spxer
// To stop: pm2 stop spxer
// To delete: pm2 delete spxer
//
// Ports:
//   - spxer data service: 3600 (HTTP + WebSocket)
//   - spx dashboard: 3502 (frontend, separate service)
//
// Persistence:
//   - PM2 config saved with: pm2 save
//   - Auto-start on reboot: pm2 startup
//
module.exports = {
  apps: [
    {
      name: 'spxer',
      script: 'npm',
      args: 'run dev',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
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
    {
      name: 'spxer-agent',
      script: 'npm',
      args: 'run agent',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        AGENT_PAPER: 'true',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-agent-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-agent-out.log',
      merge_logs: true,
    },
  ],
};
