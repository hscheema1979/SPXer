#!/bin/bash
#
# agent-watchdog.sh — Ensures trading agents are running during market hours.
#
# Run via cron every 5 minutes (Mon-Fri):
#   */5 * * * 1-5 /home/ubuntu/SPXer/scripts/agent-watchdog.sh
#
# What it does:
#   - During RTH (9:25-16:00 ET): 
#     * Sets maintenance mode (blocks monitor from stopping agents/closing positions)
#     * Starts agents if they're stopped
#   - After hours (16:15+ ET): 
#     * Clears maintenance mode
#     * Stops agents if still running
#   - Skips weekends and holidays
#   - Never restarts a running agent (only starts stopped ones)
#
# Account-monitor removed — was interfering with successful trades.
#

set -euo pipefail
export PATH="/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd /home/ubuntu/SPXer

TODAY=$(TZ=America/New_York date +%Y-%m-%d)
DOW=$(TZ=America/New_York date +%u)  # 1=Mon, 7=Sun
HOUR=$(TZ=America/New_York date +%-H)
MIN=$(TZ=America/New_York date +%-M)
ET_MINS=$((HOUR * 60 + MIN))

LOG="/home/ubuntu/SPXer/logs/agent-scheduler.log"
MAINT_FILE="/home/ubuntu/SPXer/logs/agent-maintenance.json"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

write_maintenance() {
  local reason="$1"
  mkdir -p "$(dirname "$MAINT_FILE")"
  cat > "$MAINT_FILE" <<EOF
{
  "active": true,
  "reason": "$reason",
  "startedAt": $(date -u +%s),
  "startedAtUTC": "$(date -u -Is)",
  "by": "watchdog"
}
EOF
}

clear_maintenance() {
  if [ -f "$MAINT_FILE" ]; then
    cat > "$MAINT_FILE" <<EOF
{
  "active": false,
  "clearedAt": $(date -u +%s),
  "clearedAtUTC": "$(date -u -Is)",
  "by": "watchdog"
}
EOF
  fi
}

# ── Holiday list (sync with src/config.ts) ─────────────────────────────────

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

is_agent_online() {
  pm2 show "$1" 2>/dev/null | grep "status" | head -1 | grep -q "online"
}

# ── Skip conditions ─────────────────────────────────────────────────────────

# Weekend
if [[ "$DOW" -ge 6 ]]; then
  exit 0
fi

# Holiday
if is_holiday; then
  exit 0
fi

# ── Time windows ─────────────────────────────────────────────────────────────
# Market: 9:30 ET (570 min) to 16:00 ET (960 min)
# Start window: 9:25 ET (565 min) — start agents 5 min before open
# Stop window: 16:15 ET (975 min) — stop agents 15 min after close

MARKET_START=565   # 9:25 ET
MARKET_STOP=975    # 16:15 ET

if [ "$ET_MINS" -ge "$MARKET_START" ] && [ "$ET_MINS" -lt "$MARKET_STOP" ]; then
  # ── Market hours: ensure agents are running, monitor is muzzled ──────────
  
  # Always keep maintenance mode active during RTH
  # Legacy maintenance flag (watchdog + account-monitor both removed)
  write_maintenance "RTH active — watchdog observe only"
  
  if ! is_agent_online "spxer-agent"; then
    log "WATCHDOG: spxer-agent is stopped during market hours — starting"
    pm2 start ecosystem.config.js --only spxer-agent --update-env >> "$LOG" 2>&1
    log "WATCHDOG: spxer-agent started at $HOUR:$(printf '%02d' $MIN) ET"
  fi

elif [ "$ET_MINS" -ge "$MARKET_STOP" ]; then
  # ── After hours: clear maintenance, stop agents ──────────────────────────

  # Release monitor — let it observe post-close state
  clear_maintenance

  if is_agent_online "spxer-agent"; then
    log "WATCHDOG: Stopping spxer-agent after market close ($HOUR:$(printf '%02d' $MIN) ET)"
    pm2 stop spxer-agent >> "$LOG" 2>&1 || true
    log "WATCHDOG: spxer-agent stopped"
  fi
fi
