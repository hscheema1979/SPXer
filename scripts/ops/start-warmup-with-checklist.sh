#!/bin/bash
# 08:00 AM ET Full Routine: 17-Tier Checklist → Warmup
# Runs the comprehensive checklist, then starts warmup only if all checks pass
#
# This is the MAIN script to call at 08:00 AM ET every trading day
#
# Usage: ./scripts/ops/start-warmup-with-checklist.sh [--skip-checklist]

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
fail() { echo -e "${RED}❌${NC} $1"; }
info() { echo -e "${BLUE}ℹ️${NC} $1"; }
header() { echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPXER_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$SPXER_DIR"

# Parse arguments
SKIP_CHECKLIST=false
for arg in "$@"; do
    case $arg in
        --skip-checklist) SKIP_CHECKLIST=true ;;
    esac
done

# ============================================================================
# HEADER
# ============================================================================
echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   SPXer 08:00 AM ET Startup Routine   ║"
echo "║   Checklist → Warmup → Trading        ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo
echo "Started: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo "User: $(whoami)@$(hostname)"
echo

LOG_DIR="$SPXER_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/startup-$(TZ='America/New_York' date '+%Y%m%d')-0800.log"

{
    echo "╔════════════════════════════════════════╗"
    echo "║   SPXer 08:00 AM ET Startup Routine   ║"
    echo "║   Started: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')   ║"
    echo "╚════════════════════════════════════════╝"
    echo
} >> "$LOG_FILE"

log_and_echo() {
    echo "$1"
    echo "$1" >> "$LOG_FILE"
}

# ============================================================================
# STEP 1: RUN 17-TIER CHECKLIST
# ============================================================================
if [ "$SKIP_CHECKLIST" = false ]; then
    header "STEP 1: 17-Tier E2E Checklist"
    echo
    log_and_echo "Running comprehensive verification..."
    echo

    if bash "$SCRIPT_DIR/run-8am-checklist.sh" "$@"; then
        echo
        pass "✅ Checklist PASSED - Proceeding to warmup"
        echo
        log_and_echo "CHECKLIST: PASSED"
    else
        echo
        fail "❌ Checklist FAILED - Aborting warmup"
        echo
        echo "Review checklist results above and fix issues before proceeding."
        echo "To retry: $0"
        echo "To skip checklist (dangerous): $0 --skip-checklist"
        echo
        log_and_echo "CHECKLIST: FAILED - ABORTED"
        exit 1
    fi
else
    warn "⚠️  Skipping 17-tier checklist (not recommended!)"
    echo
    log_and_echo "CHECKLIST: SKIPPED"
fi

# ============================================================================
# STEP 2: START WARMUP
# ============================================================================
header "STEP 2: Starting Warmup Mode"
echo
log_and_echo "Starting pre-market warmup..."
echo

# Determine target execution mode after warmup
TARGET_MODE=${WARMUP_TARGET_MODE:-"SIMULATION"}
log_and_echo "Target mode after warmup: $TARGET_MODE"
echo

# Start handler in WARMUP mode
export AGENT_EXECUTION_MODE=WARMUP

pm2 start event-handler --update-env || {
    fail "Failed to start handler"
    log_and_echo "WARMUP: FAILED - Could not start handler"
    exit 1
}

pass "Handler started in WARMUP mode"
log_and_echo "WARMUP: Handler started"

# Wait for startup
sleep 5

# Verify handler is running
HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
if [ "$HANDLER_STATUS" = "online" ]; then
    pass "Handler status: ONLINE"
    log_and_echo "WARMUP: Handler confirmed ONLINE"
else
    fail "Handler status: $HANDLER_STATUS"
    log_and_echo "WARMUP: Handler not ONLINE (status: $HANDLER_STATUS)"
    exit 1
fi

# Check logs
echo
header "Verifying Warmup Initialization"

LOGS=$(pm2 logs event-handler --nostream --lines 30 2>&1 || true)

if echo "$LOGS" | grep -q "WARMUP MODE"; then
    pass "Warmup mode confirmed in logs"
    log_and_echo "WARMUP: Mode confirmed in logs"
else
    warn "Warmup mode not found in logs - check manually"
    log_and_echo "WARMUP: Mode not confirmed in logs"
fi

if echo "$LOGS" | grep -q "WebSocket connected"; then
    pass "WebSocket connected"
    log_and_echo "WARMUP: WebSocket connected"
else
    info "WebSocket connection pending"
    log_and_echo "WARMUP: WebSocket connection pending"
fi

# ============================================================================
# SUMMARY
# ============================================================================
echo
header "08:00 AM ET Startup Complete"
echo
log_and_echo "Finished: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo

echo -e "${GREEN}${BOLD}✅ SYSTEM READY FOR PRE-MARKET WARMUP${NC}"
echo
echo "What happens next:"
echo "  ✅ Warmup Phase 1: 08:00-09:30 ET (backfilled data)"
echo "  ✅ Warmup Phase 2: 09:42-10:00 ET (REAL signals on today's data)"
echo "  ✅ Signal detection runs with real SPX data"
echo "  ✅ Strike band initialized (wider than usual)"
echo "  ❌ No positions opened (WARMUP mode)"
echo "  ❌ No orders sent to broker"
echo
echo "Why 10:00 AM and not 09:30 AM?"
echo "  • HMA(12) needs 12 bars → first valid at 09:42 AM ET"
echo "  • Need buffer to verify signal quality on today's data"
echo "  • Avoid trading on backfilled indicators from yesterday"
echo
echo "At 10:00:00 ET:"
echo "  🔄 Transition to $TARGET_MODE mode"
echo "  🚀 Begin actual trading"
echo
echo "Monitor warmup signals:"
echo "  pm2 logs event-handler | grep WARMUP"
echo
echo "Transition to live trading at 10:00 AM ET:"
echo "  ./scripts/ops/transition-from-warmup.sh"
echo
echo -e "${BOLD}${YELLOW}⏱️  Warmup active - switch to live at 10:15 AM ET (3m timeframe)${NC}"
echo

log_and_echo "STATUS: Warmup active, awaiting 10:15 AM ET transition (3m timeframe)"
log_and_echo "Log file: $LOG_FILE"

exit 0
