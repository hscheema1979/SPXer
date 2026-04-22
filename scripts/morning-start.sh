#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# morning-start.sh — Manual phased morning startup orchestrator
#
# Same 3-phase workflow that cron runs automatically each weekday, but for
# manual use (e.g. testing with tomorrow's date, running on a holiday, or
# overriding timing).
#
# Phases:
#   8:00 ET  — Fresh standalone DB, data service starts, SPX underlying warmup
#   9:30 ET  — Option WebSocket stream wakes (subscribes ~200 contracts)
#  10:00 ET  — Basket agents start trading
#
# Usage:
#   ./scripts/morning-start.sh                    # today's date, default times
#   ./scripts/morning-start.sh 2026-04-22         # specific date
#   ./scripts/morning-start.sh tomorrow           # tomorrow's date
#   OPTION_WAKE=09:22 AGENT_START=09:45 ./scripts/morning-start.sh
#
# To run right now (skip waiting for phases):
#   ./scripts/morning-start.sh --now              # all 3 phases immediately
#   ./scripts/morning-start.sh --now 2026-04-22   # all 3 phases, specific date
#
# This is the manual equivalent of:
#   agent-scheduler.sh start-data    (phase 1)
#   agent-scheduler.sh start-stream  (phase 2)
#   agent-scheduler.sh start-agents  (phase 3)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd /home/ubuntu/SPXer

# ── Parse args ──
NOW_MODE=false
TARGET_DATE=""

for arg in "$@"; do
  case "$arg" in
    --now) NOW_MODE=true ;;
    tomorrow) TARGET_DATE=$(date -u -d "+1 day" +%Y-%m-%d) ;;
    20[0-9][0-9]-[01][0-9]-[0-3][0-9]) TARGET_DATE="$arg" ;;
    *) echo "Unknown arg: $arg"; echo "Usage: $0 [--now] [tomorrow|YYYY-MM-DD]"; exit 1 ;;
  esac
done

# Default to today if no date given
if [[ -z "$TARGET_DATE" ]]; then
  TARGET_DATE=$(TZ=America/New_York date +%Y-%m-%d)
fi

OPTION_WAKE="${OPTION_WAKE:-09:30}"
AGENT_START="${AGENT_START:-10:00}"
DB_PATH="data/live/${TARGET_DATE}.db"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SPXer Morning Start — Phased Orchestrator              ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Target date:     ${TARGET_DATE}                            ║"
echo "║  DB path:         ${DB_PATH}                ║"
echo "║  Option WS wake:  ${OPTION_WAKE} ET                            ║"
echo "║  Agent start:     ${AGENT_START} ET                            ║"
echo "║  Mode:            $(if $NOW_MODE; then echo 'IMMEDIATE (skip waits)'; else echo 'SCHEDULED (wait for phases)'; fi)"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Helper: current ET minute of day ──
et_minutes_now() {
  local et_time
  et_time=$(TZ="America/New_York" date +%H:%M)
  local h=${et_time%%:*}
  local m=${et_time##*:}
  h=$((10#$h))
  m=$((10#$m))
  echo $(( h * 60 + m ))
}

parse_time() {
  local h=${1%%:*}
  local m=${1##*:}
  h=$((10#$h))
  m=$((10#$m))
  echo $(( h * 60 + m ))
}

wait_until() {
  local target_mins=$1
  local label=$2
  if $NOW_MODE; then return; fi
  while true; do
    local now_mins
    now_mins=$(et_minutes_now)
    if (( now_mins >= target_mins )); then return; fi
    local remaining=$(( target_mins - now_mins ))
    echo "[$(TZ=America/New_York date +%H:%M:%S)] Waiting ${remaining} min for ${label}..."
    local sleep_secs=$(( remaining * 60 ))
    if (( sleep_secs > 30 )); then sleep_secs=30; fi
    sleep "$sleep_secs"
  done
}

AGENTS="runner-itm5 runner-atm runner-otm5 scalp-itm5 scalp-atm scalp-otm5"

# ── Phase 0: Stop existing processes ──
echo "[$(TZ=America/New_York date +%H:%M:%S)] Phase 0: Stopping existing processes..."
for agent in $AGENTS; do
  pm2 stop "$agent" 2>/dev/null || true
done
pm2 stop spxer 2>/dev/null || true
sleep 2

# ── Phase 1: Data service + SPX warmup ──
DATA_START_MINS=$(( 8 * 60 ))
echo "[$(TZ=America/New_York date +%H:%M:%S)] Phase 1: Waiting for 8:00 AM ET..."
wait_until $DATA_START_MINS "data service start (8:00 ET)"

echo "[$(TZ=America/New_York date +%H:%M:%S)] Phase 1: Starting data service (DB: ${DB_PATH})"
export DB_PATH
export OPTION_STREAM_WAKE_ET="${OPTION_WAKE}"
export FORCE=1  # skip holiday check in scheduler

DB_DATE="${TARGET_DATE}" OPTION_WAKE="${OPTION_WAKE}" \
  /home/ubuntu/SPXer/scripts/agent-scheduler.sh start-data
echo "[$(TZ=America/New_York date +%H:%M:%S)] ✓ Data service started. SPX warmup running."
echo ""

# ── Phase 2: Option WS stream ──
WAKE_MINS=$(parse_time "$OPTION_WAKE")
echo "[$(TZ=America/New_York date +%H:%M:%S)] Phase 2: Waiting for ${OPTION_WAKE} ET (option WS stream)..."
wait_until $WAKE_MINS "option WS stream (${OPTION_WAKE} ET)"

echo "[$(TZ=America/New_York date +%H:%M:%S)] Phase 2: Option stream window reached"
DB_DATE="${TARGET_DATE}" OPTION_WAKE="${OPTION_WAKE}" \
  /home/ubuntu/SPXer/scripts/agent-scheduler.sh start-stream

# Health check
sleep 5
HEALTH=$(curl -sf http://localhost:3600/health 2>/dev/null | python3 -m json.tool 2>/dev/null | head -20 || echo "  (unreachable)")
echo "  Health snapshot:"
echo "$HEALTH"
echo ""

# ── Phase 3: Basket agents ──
AGENT_MINS=$(parse_time "$AGENT_START")
echo "[$(TZ=America/New_York date +%H:%M:%S)] Phase 3: Waiting for ${AGENT_START} ET (agent start)..."
wait_until $AGENT_MINS "agent start (${AGENT_START} ET)"

echo "[$(TZ=America/New_York date +%H:%M:%S)] Phase 3: Starting basket agents"
AGENT_START="${AGENT_START}" \
  /home/ubuntu/SPXer/scripts/agent-scheduler.sh start-agents

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Morning startup complete!                              ║"
echo "║                                                         ║"
echo "║  Data service: running (DB: ${TARGET_DATE})       ║"
echo "║  Option stream: active since ${OPTION_WAKE} ET               ║"
echo "║  Basket agents: trading since ${AGENT_START} ET               ║"
echo "║                                                         ║"
echo "║  Monitor:  pm2 logs --lines 50                          ║"
echo "║  Health:   curl localhost:3600/health                   ║"
echo "║  Status:   ./scripts/agent-scheduler.sh status          ║"
echo "╚══════════════════════════════════════════════════════════╝"
