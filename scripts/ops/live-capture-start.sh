#!/usr/bin/env bash
# live-capture-start.sh — cron-friendly launcher for the Tradier live-capture
# daemon. Mirrors optionx/scripts/ops/cron-start.sh: sets up env + PATH for
# cron, then `pm2 startOrReload` (idempotent). The daemon waits for the open,
# captures the ATM±10% chains once/minute, and self-exits after the close;
# startOrReload the next morning brings it back.
#
# Invoked from crontab at 13:25 & 14:25 UTC (9:25 ET across EDT/EST). Firing
# twice is safe — the daemon resumes from data/live-capture/{date}.db.

set -uo pipefail

ROOT="/home/ubuntu/SPXer"
cd "$ROOT" || exit 1

# cron has a bare PATH — make node/pm2/npx resolvable (system install in /usr/bin).
export HOME="/home/ubuntu"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

LOG="$ROOT/logs/live-capture-cron.log"
mkdir -p "$ROOT/logs"

{
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo "live-capture-start @ $(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "═══════════════════════════════════════════════════════════════"

  if ! command -v pm2 >/dev/null 2>&1; then
    echo "❌ pm2 not on PATH — aborting"
    exit 1
  fi

  pm2 startOrReload "$ROOT/ecosystem.config.js" --only live-capture
  echo "pm2 startOrReload live-capture → exit $?"
} >> "$LOG" 2>&1
