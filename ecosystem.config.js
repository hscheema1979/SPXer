module.exports = {
  apps: [{
    name: 'spxer',
    script: 'npm',
    args: 'run start', // compiled JS via 'tsc && node dist/index.js' — not tsx dev runner
    cwd: '/home/ubuntu/SPXer',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/ubuntu/SPXer/logs/error.log',
    out_file: '/home/ubuntu/SPXer/logs/out.log',
  }]
};
