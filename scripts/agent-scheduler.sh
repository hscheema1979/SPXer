#!/bin/bash
# SPXer agent scheduler — starts/stops basket trading agents around market hours.
# Called by cron. Checks holidays and weekends before starting.
#
# Cron entries (setup-crons.sh) — dual UTC times to cover EDT and EST:
#   0  12,13 * * 1-5  agent-scheduler.sh start-data    # 8:00 ET
#   30 13,14 * * 1-5  agent-scheduler.sh start-stream   # 9:30 ET
#   0  14,15 * * 1-5  agent-scheduler.sh start-agents   # 10:00 ET
#   20 20,21 * * 1-5  agent-scheduler.sh stop            # 16:20 ET
#
# Morning flow:
#   8:00 ET  → start-data:   Fresh DB for today, SPX underlying warmup begins
#   9:30 ET  → start-stream: Option WS stream wakes (OPTION_STREAM_WAKE_ET)
#   10:00 ET → start-agents: Basket agents start trading
#   16:20 ET → stop:         All agents stopped
#
# Environment overrides:
#   FORCE=1              — skip holiday/weekend checks
#   DB_DATE=2026-04-23   — override date for DB path
#   OPTION_WAKE=09:22    — override option stream wake time
#
# Agent trading window (activeStart/activeEnd) comes from Config in the DB.
# Change it via replay_configs, not env vars. Test in replay → deploy to live.

set -euo pipefail
export PATH="/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd /home/ubuntu/SPXer

ACTION="${1:-}"
TODAY=$(TZ=America/New_York date +%Y-%m-%d)
DOW=$(TZ=America/New_York date +%u)  # 1=Mon, 7=Sun
LOG="/home/ubuntu/SPXer/logs/agent-scheduler.log"
mkdir -p "$(dirname "$LOG")"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ACTION] $*" >> "$LOG"; }

# ── Market holidays (keep in sync with src/config.ts MARKET_HOLIDAYS) ──
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

# ── Skip weekends/holidays (unless FORCE=1) ──
if [[ "${FORCE:-}" != "1" ]]; then
  if [[ "$DOW" -ge 6 ]]; then
    log "SKIP: Weekend ($TODAY, DOW=$DOW)"
    exit 0
  fi
  if is_holiday; then
    log "SKIP: Market holiday ($TODAY)"
    exit 0
  fi
fi

# ── All basket agent names ──
AGENTS="runner-itm5 runner-atm runner-otm5 scalp-itm5 scalp-atm scalp-otm5"

# ── Resolve config ──
TARGET_DATE="${DB_DATE:-$TODAY}"
OPTION_WAKE="${OPTION_WAKE:-09:30}"

is_pm2_online() {
  local name="$1"
  pm2 show "$name" 2>/dev/null | grep -q "status.*online" && return 0 || return 1
}

case "$ACTION" in
  start-data)
    # Phase 1: Start data service with fresh DB for today
    # Idempotent: if spxer is already online with <4h uptime, assume it was
    # started by the earlier cron fire (EDT/EST dual-cron) and skip.
    DB_PATH="data/live/${TARGET_DATE}.db"

    if is_pm2_online spxer; then
      UPTIME_SEC=$(pm2 show spxer 2>/dev/null | grep "uptime" | grep -oP '\d+' | head -1 || echo "99999")
      if (( UPTIME_SEC < 14400 )); then
        log "START-DATA: spxer already online (${UPTIME_SEC}s uptime) — skipping (idempotent)"
        exit 0
      fi
      log "START-DATA: spxer online but stale (${UPTIME_SEC}s) — restarting with fresh DB"
      pm2 stop spxer >> "$LOG" 2>&1 || true
      sleep 2
    fi

    log "START-DATA: DB=${DB_PATH}, OPTION_STREAM_WAKE_ET=${OPTION_WAKE}"
    export DB_PATH
    export OPTION_STREAM_WAKE_ET="${OPTION_WAKE}"
    pm2 delete spxer >> "$LOG" 2>&1 || true
    pm2 start ecosystem.config.js --only spxer --update-env >> "$LOG" 2>&1
    log "START-DATA: spxer started (warmup begins)"
    ;;

  start-stream)
    # Phase 2: Option WS stream — handled automatically by data service at OPTION_STREAM_WAKE_ET
    # This is a verification step, not a trigger
    log "START-STREAM: Verifying data service health at option stream wake time"

    if ! is_pm2_online spxer; then
      log "START-STREAM: WARNING — spxer not online! Starting now..."
      DB_PATH="data/live/${TARGET_DATE}.db"
      export DB_PATH
      export OPTION_STREAM_WAKE_ET="${OPTION_WAKE}"
      pm2 delete spxer >> "$LOG" 2>&1 || true
      pm2 start ecosystem.config.js --only spxer --update-env >> "$LOG" 2>&1
    fi

    # Health check
    HEALTH=$(curl -sf http://localhost:3600/health 2>/dev/null || echo '{"error":"unreachable"}')
    log "START-STREAM: Health: $(echo "$HEALTH" | head -c 300)"
    ;;

  start-agents)
    # Phase 3: Start all basket agents
    log "START-AGENTS: Starting basket agents (activeStart from config)"

    # Verify data service is up first
    if ! is_pm2_online spxer; then
      log "START-AGENTS: ERROR — spxer not online! Cannot start agents without data."
      exit 1
    fi

    STARTED=0
    for agent in $AGENTS; do
      if is_pm2_online "$agent"; then
        log "START-AGENTS: $agent already online — skipping"
      else
        pm2 delete "$agent" >> "$LOG" 2>&1 || true
        pm2 start ecosystem.config.js --only "$agent" --update-env >> "$LOG" 2>&1
        STARTED=$((STARTED + 1))
        log "START-AGENTS: $agent started"
      fi
    done
    log "START-AGENTS: ${STARTED} agent(s) started"
    ;;

  stop)
    # Stop all agents (data service keeps running for post-market data collection)
    log "STOP: Stopping all basket agents ($TODAY)"
    for agent in $AGENTS; do
      pm2 stop "$agent" >> "$LOG" 2>&1 || true
    done
    log "STOP: All agents stopped"
    ;;

  stop-all)
    # Stop everything including data service
    log "STOP-ALL: Stopping agents + data service ($TODAY)"
    for agent in $AGENTS; do
      pm2 stop "$agent" >> "$LOG" 2>&1 || true
    done
    pm2 stop spxer >> "$LOG" 2>&1 || true
    log "STOP-ALL: Everything stopped"
    ;;

  status)
    echo "=== SPXer Agent Scheduler Status ==="
    echo "Date: $TODAY (DOW=$DOW)"
    echo ""
    echo "Data service:"
    pm2 show spxer 2>/dev/null | grep -E "status|uptime|pid" || echo "  not registered"
    echo ""
    echo "Basket agents:"
    for agent in $AGENTS; do
      STATUS=$(pm2 show "$agent" 2>/dev/null | grep "status" | head -1 | awk '{print $NF}' || echo "not registered")
      printf "  %-15s %s\n" "$agent" "$STATUS"
    done
    ;;

  *)
    echo "Usage: $0 {start-data|start-stream|start-agents|stop|stop-all|status}" >&2
    echo ""
    echo "Morning phased startup:"
    echo "  start-data     8:00 ET — Fresh DB, SPX warmup"
    echo "  start-stream   9:30 ET — Verify option WS stream"
    echo "  start-agents  10:00 ET — Start basket agents"
    echo ""
    echo "Shutdown:"
    echo "  stop           Stop agents only (data keeps running)"
    echo "  stop-all       Stop everything"
    echo ""
    echo "  status         Show all process status"
    exit 1
    ;;
esac
