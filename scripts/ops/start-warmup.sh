#!/bin/bash
# SECTION B0: Pre-Market Warmup (08:00-10:00 ET)
# Starts handler in WARMUP mode - tracks signals but doesn't execute
# Why 10:00 AM? HMA(12) needs 12 bars → first valid at 09:42 AM ET

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅${NC} $1"; }
warn() { echo -e "${YELLOW}⚠️${NC} $1"; }
info() { echo -e "${BLUE}ℹ️${NC} $1"; }
header() { echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   SPXer Pre-Market Warmup Phase      ║"
echo "║   Green Flag Lap - No Trading Yet    ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo
echo "Started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo

# Check we're in the right time window (8-10 AM ET)
HOUR=$(date '+%H')
if [ $HOUR -lt 8 ] || [ $HOUR -ge 10 ]; then
    warn "Warmup phase is typically 08:00-10:00 ET. Current hour: $HOUR"
    read -p "Continue anyway? (y/N): " CONTINUE
    if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
        echo "Aborted"
        exit 0
    fi
fi

# Determine target execution mode after warmup
TARGET_MODE=${WARMUP_TARGET_MODE:-"SIMULATION"}
echo "Target mode after warmup: $TARGET_MODE"
echo

# Start handler in WARMUP mode
header "Starting Handler in WARMUP Mode"

export AGENT_EXECUTION_MODE=WARMUP

pm2 start event-handler --update-env || {
    echo -e "${RED}Failed to start handler${NC}"
    exit 1
}

pass "Handler started in WARMUP mode"

# Wait for startup
sleep 5

# Verify handler is running
HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
if [ "$HANDLER_STATUS" = "online" ]; then
    pass "Handler status: ONLINE"
else
    echo -e "${RED}Handler status: $HANDLER_STATUS${NC}"
    exit 1
fi

# Check logs
echo
header "Verifying Warmup Initialization"

LOGS=$(pm2 logs event-handler --nostream --lines 30 2>&1 || true)

if echo "$LOGS" | grep -q "WARMUP MODE"; then
    pass "Warmup mode confirmed in logs"
else
    warn "Warmup mode not found in logs - check manually"
fi

if echo "$LOGS" | grep -q "WebSocket connected"; then
    pass "WebSocket connected"
else
    info "WebSocket connection pending"
fi

echo
header "Pre-Market Warmup Active"

echo -e "${GREEN}Warmup phase will track all signals from 08:00-10:00 ET${NC}"
echo
echo "What happens during warmup:"
echo "  ✅ Signal detection runs with real SPX data"
echo "  ✅ HMA crosses detected and logged"
echo "  ✅ Strike band initialized (wider than usual)"
echo "  ✅ All signals marked as 'green' (tracked, not executed)"
echo "  ❌ No positions opened (WARMUP mode)"
echo "  ❌ No orders sent to broker"
echo
echo "Timeline:"
echo "  08:00-09:30 AM ET: Warmup Phase 1 (backfilled data)"
echo "  10:06 AM ET: First valid HMA(12) on 3m timeframe (12 bars × 3min)"
echo "  10:06-10:15 AM ET: Warmup Phase 2 (REAL signals on today's data)"
echo "  10:15 AM ET: Switch to $TARGET_MODE mode"
echo
echo "Why 10:15 AM and not 09:30 AM?"
echo "  • Your config: HMA(3)×HMA(12) on 3m timeframe"
echo "  • HMA(12) needs: 12 bars × 3 minutes = 36 minutes"
echo "  • Market opens: 09:30 AM ET"
echo "  • First HMA(12) valid: 09:30 + 36 = 10:06 AM ET"
echo "  • 10:15 AM gives 9-min buffer to verify signal quality"
echo
echo "For 1m timeframe configs, transition at 10:00 AM ET instead"
echo "  Run: ./scripts/ops/calculate-warmup-end.sh 12 1 15"
echo
echo "Monitor warmup signals:"
echo "  pm2 logs event-handler | grep WARMUP"
echo
echo "Transition to live trading:"
echo "  ./scripts/ops/transition-from-warmup.sh"
echo

echo -e "${BOLD}${YELLOW}⏱️  Warmup active - switch to live at 10:15 AM ET (3m timeframe)${NC}"
