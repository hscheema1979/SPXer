#!/bin/bash
# SECTION C2: Ongoing Monitoring
# Runs every 15 minutes during market hours (10:00-16:00)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅${NC} $1"; }
warn() { echo -e "${YELLOW}⚠️${NC} $1"; }
fail() { echo -e "${RED}❌${NC} $1"; }
info() { echo -e "${BLUE}ℹ️${NC} $1"; }

echo "======================================"
echo "SECTION C2: Active Trading Monitor"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "======================================"
echo

FAIL_COUNT=0
WARN_COUNT=0

BASE_URL="http://localhost:3600"

# 1. Health Check
echo "[1] System Health"
HEALTH=$(curl -s "$BASE_URL/health" || echo '{"error":"curl failed"}')

STATUS=$(echo "$HEALTH" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown")

if [ "$STATUS" = "healthy" ] || [ "$STATUS" = "n/a" ]; then
    pass "Data service health: $STATUS"
elif [ "$STATUS" = "degraded" ]; then
    warn "Data service health: $STATUS"
    WARN_COUNT=$((WARN_COUNT + 1))
else
    fail "Data service health: $STATUS"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Check uptime
UPTIME=$(echo "$HEALTH" | jq -r '.uptimeSec // 0' 2>/dev/null || echo "0")
if [ $UPTIME -gt 300 ]; then
    pass "Data service uptime: ${UPTIME}s"
else
    warn "Data service uptime: ${UPTIME}s (low)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi

echo

# 2. Handler Status
echo "[2] Handler Process"
if pm2 describe event-handler &> /dev/null; then
    HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
    if [ "$HANDLER_STATUS" = "online" ]; then
        pass "Event handler: ONLINE"

        # Check execution mode
        MODE_CHECK=$(curl -s "$BASE_URL/agent/mode" 2>/dev/null || echo '{"mode":"unknown"}')
        EXEC_MODE=$(echo "$MODE_CHECK" | jq -r '.mode' 2>/dev/null || echo "unknown")
        info "Execution mode: $EXEC_MODE"
    else
        fail "Event handler: $HANDLER_STATUS"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
else
    warn "Event handler: NOT RUNNING (outside trading hours?)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi

echo

# 3. Option Stream
echo "[3] Option Stream Status"
OPTION_STREAM=$(echo "$HEALTH" | jq -r '.optionStream // {}' 2>/dev/null || echo '{}')
STREAM_CONNECTED=$(echo "$OPTION_STREAM" | jq -r '.connected // false' 2>/dev/null || echo "false")

if [ "$STREAM_CONNECTED" = "true" ]; then
    pass "Option stream: CONNECTED"

    SYMBOL_COUNT=$(echo "$OPTION_STREAM" | jq -r '.symbolCount // 0' 2>/dev/null || echo "0")
    if [ $SYMBOL_COUNT -gt 100 ]; then
        pass "Tracked symbols: $SYMBOL_COUNT"
    else
        warn "Tracked symbols: $SYMBOL_COUNT (low)"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi

    # Check primary provider
    THETA_PRIMARY=$(echo "$OPTION_STREAM" | jq -r '.theta.primary // false' 2>/dev/null || echo "false")
    if [ "$THETA_PRIMARY" = "true" ]; then
        pass "Primary provider: ThetaData"
    else
        info "Primary provider: Tradier (backup)"
    fi
else
    warn "Option stream: NOT CONNECTED (pre-market or post-market)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi

echo

# 4. Position Limits (if handler running)
if [ "$HANDLER_STATUS" = "online" ]; then
    echo "[4] Position Limits"

    # Get simulation status or real positions
    SIM_STATUS=$(curl -s "$BASE_URL/agent/simulation" 2>/dev/null || echo '{}')
    ACTIVE_COUNT=$(echo "$SIM_STATUS" | jq -r '.stats.ordersFilled // 0' 2>/dev/null || echo "0")

    if [ $ACTIVE_COUNT -lt 4 ]; then
        pass "Open positions: $ACTIVE_COUNT (under limit)"
    else
        warn "Open positions: $ACTIVE_COUNT (approaching limit)"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi

    # Check daily P&L (if available)
    DAILY_PNL=$(echo "$SIM_STATUS" | jq -r '.dailyPnl // 0' 2>/dev/null || echo "0")
    if [ $DAILY_PNL -gt -1000 ]; then
        pass "Daily P&L: \$$DAILY_PNL"
    else
        warn "Daily P&L: \$$DAILY_PNL (approaching limit)"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi
fi

echo

# 5. Recent Logs (check for errors)
echo "[5] Recent Log Check"
if pm2 describe event-handler &> /dev/null; then
    RECENT_LOGS=$(pm2 logs event-handler --nostream --lines 50 --raw 2>&1 || true)
    ERROR_COUNT=$(echo "$RECENT_LOGS" | grep -c "ERROR\|FAIL" || true)

    if [ $ERROR_COUNT -eq 0 ]; then
        pass "No errors in recent logs"
    else
        warn "Recent logs contain $ERROR_COUNT error(s)"
        WARN_COUNT=$((WARN_COUNT + 1))

        # Show last error
        LAST_ERROR=$(echo "$RECENT_LOGS" | grep "ERROR\|FAIL" | tail -1 || true)
        info "Last error: $LAST_ERROR"
    fi
else
    info "Handler not running - skipping log check"
fi

echo
echo "======================================"
echo "Monitor Summary:"
echo "  Failures: $FAIL_COUNT"
echo "  Warnings: $WARN_COUNT"
echo "======================================"

# Alert logic
if [ $FAIL_COUNT -gt 0 ]; then
    fail "CRITICAL ISSUES DETECTED - Immediate investigation required"
    # TODO: Send alert (Slack webhook, email, etc.)
    exit 1
elif [ $WARN_COUNT -gt 2 ]; then
    warn "MULTIPLE WARNINGS - Escalate if persists"
    exit 0
else
    pass "All systems normal"
    exit 0
fi
