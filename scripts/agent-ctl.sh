#!/bin/bash
#
# agent-ctl.sh — Safe agent restart/stop with monitor coordination
#
# Usage:
#   ./scripts/agent-ctl.sh restart spx          # Restart SPX agent
#   ./scripts/agent-ctl.sh restart xsp          # Restart XSP agent  
#   ./scripts/agent-ctl.sh restart both         # Restart both
#   ./scripts/agent-ctl.sh stop spx             # Stop SPX agent
#   ./scripts/agent-ctl.sh stop both            # Stop both
#   ./scripts/agent-ctl.sh pause "doing code changes"  # Pause monitor
#   ./scripts/agent-ctl.sh unpause              # Resume monitor
#
# Before stopping/restarting, writes a maintenance signal file that the
# account-monitor reads. The monitor will skip all remediation actions
# (no force-closing positions, no cancelling brackets) while the signal
# is active.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MAINTENANCE_FILE="$PROJECT_DIR/logs/agent-maintenance.json"

ACTION="${1:-help}"
TARGET="${2:-both}"
REASON="${3:-Agent restart via agent-ctl}"

# Resolve PM2 process names
resolve_targets() {
  case "$1" in
    spx)  echo "spxer-agent" ;;
    xsp)  echo "spxer-xsp" ;;
    both) echo "spxer-agent spxer-xsp" ;;
    *)    echo "Unknown target: $1" >&2; exit 1 ;;
  esac
}

write_maintenance() {
  local reason="$1"
  local ts=$(date -u +%s)
  mkdir -p "$(dirname "$MAINTENANCE_FILE")"
  cat > "$MAINTENANCE_FILE" <<EOF
{
  "active": true,
  "reason": "$reason",
  "startedAt": $ts,
  "startedAtUTC": "$(date -u -Is)",
  "by": "${USER:-unknown}"
}
EOF
  echo "[agent-ctl] ✅ Monitor paused: $reason"
}

clear_maintenance() {
  if [ -f "$MAINTENANCE_FILE" ]; then
    cat > "$MAINTENANCE_FILE" <<EOF
{
  "active": false,
  "clearedAt": $(date -u +%s),
  "clearedAtUTC": "$(date -u -Is)"
}
EOF
    echo "[agent-ctl] ✅ Monitor resumed"
  fi
}

case "$ACTION" in
  restart)
    TARGETS=$(resolve_targets "$TARGET")
    echo "[agent-ctl] Restarting: $TARGETS"
    
    # 1. Signal the monitor to pause
    write_maintenance "Restarting $TARGET agent(s)"
    
    # 2. Stop the agent(s)
    for proc in $TARGETS; do
      echo "[agent-ctl] Stopping $proc..."
      pm2 stop "$proc" 2>/dev/null || true
    done
    
    # 3. Wait for clean shutdown
    sleep 2
    
    # 4. Start the agent(s) with updated env
    for proc in $TARGETS; do
      echo "[agent-ctl] Starting $proc..."
      pm2 start ecosystem.config.js --only "$proc" --update-env 2>/dev/null
    done
    
    # 5. Wait for agents to initialize and reconcile
    echo "[agent-ctl] Waiting for agents to initialize (10s)..."
    sleep 10
    
    # 6. Verify they're running
    ALL_OK=true
    for proc in $TARGETS; do
      STATUS=$(pm2 show "$proc" 2>/dev/null | grep "status" | head -1 | grep -c "online" || true)
      if [ "$STATUS" = "1" ]; then
        echo "[agent-ctl] ✅ $proc is online"
      else
        echo "[agent-ctl] ❌ $proc failed to start!"
        ALL_OK=false
      fi
    done
    
    # 7. Clear the maintenance signal
    clear_maintenance
    
    if [ "$ALL_OK" = true ]; then
      echo "[agent-ctl] ✅ Restart complete"
    else
      echo "[agent-ctl] ⚠️  Some agents failed to start — monitor still resumed"
    fi
    ;;
    
  stop)
    TARGETS=$(resolve_targets "$TARGET")
    echo "[agent-ctl] Stopping: $TARGETS"
    
    # Signal monitor — agent is being stopped intentionally
    write_maintenance "Intentional stop of $TARGET agent(s)"
    
    for proc in $TARGETS; do
      echo "[agent-ctl] Stopping $proc..."
      pm2 stop "$proc" 2>/dev/null || true
    done
    
    echo "[agent-ctl] ✅ Agents stopped. Monitor is paused."
    echo "[agent-ctl] Run './scripts/agent-ctl.sh unpause' when ready to resume monitoring."
    ;;
    
  pause)
    REASON="${TARGET:-Manual pause}"  # $2 is the reason for pause
    write_maintenance "$REASON"
    ;;
    
  unpause|resume)
    clear_maintenance
    ;;
    
  status)
    if [ -f "$MAINTENANCE_FILE" ]; then
      echo "[agent-ctl] Maintenance file:"
      cat "$MAINTENANCE_FILE" | python3 -m json.tool 2>/dev/null || cat "$MAINTENANCE_FILE"
    else
      echo "[agent-ctl] No maintenance file — monitor is active"
    fi
    ;;
    
  help|*)
    echo "Usage: $0 <action> [target] [reason]"
    echo ""
    echo "Actions:"
    echo "  restart <spx|xsp|both>     Safe restart with monitor coordination"
    echo "  stop <spx|xsp|both>        Stop agent(s), pause monitor"
    echo "  pause [reason]             Pause monitor without touching agents"
    echo "  unpause                    Resume monitor"  
    echo "  status                     Show maintenance state"
    echo ""
    echo "The monitor will not close positions or cancel orders while paused."
    ;;
esac
