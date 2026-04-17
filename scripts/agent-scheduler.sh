#!/bin/bash
# SPXer agent scheduler — starts/stops trading agents around market hours.
# Called by cron. Checks holidays before starting.
#
# Cron entries:
#   25 9 * * 1-5  /home/ubuntu/SPXer/scripts/agent-scheduler.sh start
#   20 16 * * 1-5  /home/ubuntu/SPXer/scripts/agent-scheduler.sh stop

set -euo pipefail
export PATH="/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd /home/ubuntu/SPXer

ACTION="${1:-}"
TODAY=$(TZ=America/New_York date +%Y-%m-%d)
DOW=$(TZ=America/New_York date +%u)  # 1=Mon, 7=Sun
LOG="/home/ubuntu/SPXer/logs/agent-scheduler.log"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

# Market holidays (keep in sync with src/config.ts MARKET_HOLIDAYS)
HOLIDAYS=(
  2025-01-01 2025-01-20 2025-02-17 2025-04-18
  2025-05-26 2025-06-19 2025-07-04 2025-09-01
  2025-11-27 2025-12-25
  2026-01-01 2026-01-19 2026-02-16 2026-04-03
  2026-05-25 2026-06-19 2026-07-03 2026-08-31
  2026-11-26 2026-12-25
  2027-01-01 2027-01-18 2027-02-15 2027-03-26
  2027-05-31 2027-06-18 2027-07-05 2027-09-06
  2027-11-25 2027-12-24
)

is_holiday() {
  for h in "${HOLIDAYS[@]}"; do
    [[ "$h" == "$TODAY" ]] && return 0
  done
  return 1
}

# Weekend check
if [[ "$DOW" -ge 6 ]]; then
  log "SKIP: Weekend ($TODAY, DOW=$DOW)"
  exit 0
fi

# Holiday check
if is_holiday; then
  log "SKIP: Market holiday ($TODAY)"
  exit 0
fi

case "$ACTION" in
  start)
    # Only start if not already running (avoid killing mid-trade)
    SPX_STATUS=$(pm2 show spxer-agent 2>/dev/null | grep "status" | head -1 | grep -c "online" || echo "0")
    if [ "$SPX_STATUS" = "1" ]; then
      log "START: spxer-agent already online — skipping ($TODAY)"
    else
      log "START: Starting spxer-agent ($TODAY)"
      pm2 start ecosystem.config.js --only spxer-agent --update-env >> "$LOG" 2>&1
      log "START: spxer-agent started"
    fi
    ;;
  stop)
    log "STOP: Stopping spxer-agent ($TODAY)"
    pm2 stop spxer-agent >> "$LOG" 2>&1 || true
    log "STOP: spxer-agent stopped"
    ;;
  *)
    echo "Usage: $0 {start|stop}" >&2
    exit 1
    ;;
esac
