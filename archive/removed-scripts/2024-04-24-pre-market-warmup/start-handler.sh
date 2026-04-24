#!/bin/bash
# SECTION B1: Handler Startup
# Runs at 09:00 SHARP every trading day

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; }
info() { echo -e "${BLUE}ℹ️  INFO${NC}: $1"; }

echo "======================================"
echo "SECTION B1: Handler Startup"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "======================================"
echo

# Check execution mode
EXEC_MODE=${AGENT_EXECUTION_MODE:-"LIVE"}
echo "Execution Mode: $EXEC_MODE"

if [ "$EXEC_MODE" = "LIVE" ]; then
    echo
    echo -e "${YELLOW}⚠️  WARNING: LIVE MODE - TWO-PERSON CONFIRMATION REQUIRED${NC}"
    echo
    read -p "Type 'CONFIRM' to proceed: " CONFIRMATION
    if [ "$CONFIRMATION" != "CONFIRM" ]; then
        fail "Live mode startup aborted"
        exit 1
    fi
fi

# Start handler via PM2
echo "Starting event handler..."
pm2 start event-handler --update-env || {
    fail "Failed to start handler via PM2"
    exit 1
}

# Wait for startup
sleep 5

# Verify handler is running
HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
if [ "$HANDLER_STATUS" = "online" ]; then
    pass "Handler process: ONLINE"
else
    fail "Handler process: $HANDLER_STATUS"
    exit 1
fi

# Check logs for successful startup
echo
echo "Checking startup logs..."
sleep 3

LOGS=$(pm2 logs event-handler --nostream --lines 20 2>&1 || true)

if echo "$LOGS" | grep -q "Event-Driven Trading Handler starting"; then
    pass "Handler startup sequence initiated"
else
    fail "Handler startup logs not found"
    exit 1
fi

# Check execution mode in logs
if echo "$LOGS" | grep -q "$EXEC_MODE MODE"; then
    pass "Execution mode confirmed: $EXEC_MODE"
else
    fail "Execution mode not confirmed in logs"
    exit 1
fi

# Check WebSocket connection
if echo "$LOGS" | grep -q "WebSocket connected"; then
    pass "WebSocket connected to data service"
else
    info "WebSocket connection pending (may still be connecting)"
fi

# Check subscriptions
if echo "$LOGS" | grep -q "Subscribed to"; then
    pass "Channel subscriptions successful"
else
    info "Channel subscriptions pending"
fi

echo
echo "======================================"
pass "B1 COMPLETE - Handler started successfully"
echo "======================================"
echo
echo "Next steps:"
echo "  1. Monitor logs: pm2 logs event-handler"
echo "  2. Run data quality check: ./scripts/ops/check-data-quality.sh"
echo "  3. Run final GO check: ./scripts/ops/final-go-check.sh"
echo
