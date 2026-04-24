#!/bin/bash
###############################################################################
# Signal Detection Monitoring
# Purpose: Monitor the independent signal detection system
#          (event handler's Tradier-based signal detection)
###############################################################################

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
echo "SIGNAL DETECTION MONITOR"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "======================================"
echo

FAIL_COUNT=0
WARN_COUNT=0

# 1. Event Handler Process
echo "[1] Event Handler Process"
if pm2 describe event-handler &> /dev/null; then
    HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
    if [ "$HANDLER_STATUS" = "online" ]; then
        pass "Event handler: ONLINE"
    else
        fail "Event handler: $HANDLER_STATUS"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
else
    fail "Event handler: NOT RUNNING"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo

# 2. Signal Detection Timer
echo "[2] Signal Detection Timer"
TIMER_LOGS=$(pm2 logs event-handler --nostream --lines 50 --raw 2>&1 || true)
TIMER_ACTIVITY=$(echo "$TIMER_LOGS" | grep -c "checkForSignals" || echo 0)

if [ $TIMER_ACTIVITY -gt 0 ]; then
    pass "Signal detection timer: ACTIVE"

    # Show last check time
    LAST_CHECK=$(echo "$TIMER_LOGS" | grep "checkForSignals" | tail -1 || true)
    if [ -n "$LAST_CHECK" ]; then
        info "Last check: $(echo "$LAST_CHECK" | cut -d' ' -f1-3)"
    fi
else
    warn "Signal detection timer: NO ACTIVITY (handler may be new)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi
echo

# 3. Tradier API Connectivity
echo "[3] Tradier API Connectivity"
if [ -n "${TRADIER_TOKEN:-}" ]; then
    # Test SPX quote endpoint
    SPX_QUOTE=$(curl -s -H "Authorization: Bearer $TRADIER_TOKEN" \
        "https://api.tradier.com/v1/markets/quotes?symbols=SPX" 2>/dev/null || echo '{}')

    if echo "$SPX_QUOTE" | jq -e '.quotes.quote.last' > /dev/null 2>&1; then
        pass "Tradier SPX API: REACHABLE"

        # Show SPX price
        SPX_PRICE=$(echo "$SPX_QUOTE" | jq -r '.quotes.quote.last')
        info "SPX Price: $SPX_PRICE"
    else
        fail "Tradier SPX API: NOT REACHABLE"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi

    # Test timesales endpoint (for signal detection)
    TODAY=$(date +%Y%m%d)
    TEST_SYMBOL="SPXW${TODAY}C07150000"
    TIMESALES=$(curl -s -H "Authorization: Bearer $TRADIER_TOKEN" \
        "https://api.tradier.com/v1/markets/timesales?symbol=$TEST_SYMBOL&interval=1min&session_filter=all" 2>/dev/null || echo '{}')

    if echo "$TIMESALES" | jq -e '.series' > /dev/null 2>&1; then
        pass "Tradier timesales API: REACHABLE"

        # Show bar count
        BAR_COUNT=$(echo "$TIMESALES" | jq -r '.series.data | length' 2>/dev/null || echo 0)
        info "Bars fetched: $BAR_COUNT"
    else
        # 404 is OK (contract doesn't exist yet), 401 is bad
        if echo "$TIMESALES" | jq -e '.error' | grep -q "Invalid symbol\|not found"; then
            info "Tradier timesales: Contract not found (normal for new day)"
        else
            warn "Tradier timesales API: ISSUE"
            WARN_COUNT=$((WARN_COUNT + 1))
        fi
    fi
else
    fail "TRADIER_TOKEN not set"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo

# 4. Recent Signal Detection
echo "[4] Recent Signal Detection"
RECENT_SIGNALS=$(pm2 logs event-handler --nostream --lines 100 --raw 2>&1 | grep "SIGNAL:" || true)

if [ -n "$RECENT_SIGNALS" ]; then
    SIGNAL_COUNT=$(echo "$RECENT_SIGNALS" | wc -l)
    pass "Signals detected: $SIGNAL_COUNT"

    # Show last few signals
    echo "$RECENT_SIGNALS" | tail -3 | while read line; do
        info "  $line"
    done
else
    info "No signals detected in recent logs"
fi
echo

# 5. Signal Detection Errors
echo "[5] Signal Detection Errors"
ERROR_LOGS=$(pm2 logs event-handler --nostream --lines 100 --raw 2>&1 | grep -i "error\|fail" | grep -i "signal\|detection\|tradier\|fetch" || true)

if [ -z "$ERROR_LOGS" ]; then
    pass "No signal detection errors"
else
    ERROR_COUNT=$(echo "$ERROR_LOGS" | wc -l)
    warn "Signal detection errors: $ERROR_COUNT"

    echo "$ERROR_LOGS" | tail -3 | while read line; do
        info "  $line"
    done
    WARN_COUNT=$((WARN_COUNT + 1))
fi
echo

# 6. Account Database
echo "[6] Account Database (State Tracking)"
if [ -f "data/account.db" ]; then
    pass "Account database: EXISTS"

    # Check positions
    OPEN_COUNT=$(sqlite3 data/account.db "SELECT COUNT(*) FROM positions WHERE status IN ('OPEN', 'OPENING');" 2>/dev/null || echo "0")
    info "Open positions: $OPEN_COUNT"

    # Check config state
    CONFIG_COUNT=$(sqlite3 data/account.db "SELECT COUNT(*) FROM config_state;" 2>/dev/null || echo "0")
    if [ $CONFIG_COUNT -gt 0 ]; then
        pass "Config state: TRACKED ($CONFIG_COUNT configs)"
    else
        warn "Config state: NOT FOUND"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi
else
    warn "Account database: NOT FOUND (handler may not have run yet)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi
echo

# 7. Signal Detection Performance
echo "[7] Signal Detection Performance"
# Check if signals are being detected on time (at :00 seconds)
RECENT_CHECKS=$(pm2 logs event-handler --nostream --lines 200 --raw 2>&1 | grep "checkForSignals" || true)

if [ -n "$RECENT_CHECKS" ]; then
    # Extract timestamps from checks
    CHECK_COUNT=$(echo "$RECENT_CHECKS" | wc -l)
    info "Signal checks in logs: $CHECK_COUNT"

    # Check if checks are happening (should be 1 per minute)
    if [ $CHECK_COUNT -gt 0 ]; then
        pass "Signal detection: RUNNING"
    else
        warn "Signal detection: LOW ACTIVITY"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi
else
    warn "Signal detection: NO CHECKS (handler just started?)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi
echo

# Summary
echo "======================================"
echo "MONITOR SUMMARY"
echo "======================================"
echo "Failures: $FAIL_COUNT"
echo "Warnings: $WARN_COUNT"
echo

if [ $FAIL_COUNT -gt 0 ]; then
    fail "CRITICAL ISSUES DETECTED"
    exit 1
elif [ $WARN_COUNT -gt 2 ]; then
    warn "MULTIPLE WARNINGS"
    exit 0
else
    pass "SIGNAL DETECTION OPERATIONAL"
    exit 0
fi
