#!/bin/bash
###############################################################################
# Ongoing Operational Monitoring
# Purpose: Run every 30 minutes DURING TRADING HOURS to verify the system
#          maintains operational level throughout the trading cycle
#
# Focus: Data freshness, signal detection, service health, positions
#
# Posts results to /devops/monitoring for dashboard display at:
#   http://bitloom.cloud/devops/viewer
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
echo "OPERATIONAL MONITORING"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "======================================"
echo

ISSUES=0
WARNINGS=0

BASE_URL="http://localhost:3600"

# Data collection variables for POST
SPX_FRESHNESS_JSON=""
OPTION_FRESHNESS_JSON=""
SPXER_RESTARTS=0
HANDLER_RESTARTS=0
SIGNAL_JSON=""
POSITIONS_JSON=""
BROKER_JSON=""

###############################################################################
# 1. DATA FRESHNESS - Most Critical
###############################################################################

echo "[1] DATA FRESHNESS"

# Check SPX data freshness
SPX_HEALTH=$(curl -s "$BASE_URL/health" 2>/dev/null || echo '{}')
SPX_STALE=$(echo "$SPX_HEALTH" | jq -r '.data.SPX.staleSec // -1' 2>/dev/null || echo "-1")

if [ "$SPX_STALE" != "-1" ]; then
    if [ $SPX_STALE -lt 120 ]; then
        SPX_STATUS="pass"
        pass "SPX data fresh (${SPX_STALE}s old)"
    elif [ $SPX_STALE -lt 300 ]; then
        SPX_STATUS="warn"
        warn "SPX data stale (${SPX_STALE}s old)"
        WARNINGS=$((WARNINGS + 1))
    else
        SPX_STATUS="fail"
        fail "SPX data VERY stale (${SPX_STALE}s old)"
        ISSUES=$((ISSUES + 1))
    fi
    SPX_FRESHNESS_JSON="{\"status\": \"$SPX_STATUS\", \"staleSec\": $SPX_STALE}"
else
    fail "Cannot check SPX freshness"
    ISSUES=$((ISSUES + 1))
fi

# Check option data freshness
OPTION_STALE=$(curl -s "$BASE_URL/health" 2>/dev/null | jq -r '.data | to_entries | map(.value.staleSec) | max // -1' 2>/dev/null || echo "-1")

if [ "$OPTION_STALE" != "-1" ]; then
    if [ $OPTION_STALE -lt 600 ]; then
        OPTION_STATUS="pass"
        pass "Option bars fresh (max ${OPTION_STALE}s old)"
    elif [ $OPTION_STALE -lt 1200 ]; then
        OPTION_STATUS="warn"
        warn "Option bars stale (max ${OPTION_STALE}s old)"
        WARNINGS=$((WARNINGS + 1))
    else
        OPTION_STATUS="fail"
        fail "Option bars VERY stale (max ${OPTION_STALE}s old)"
        ISSUES=$((ISSUES + 1))
    fi
    OPTION_FRESHNESS_JSON="{\"status\": \"$OPTION_STATUS\", \"staleSec\": $OPTION_STALE}"
else
    fail "Cannot check option freshness"
    ISSUES=$((ISSUES + 1))
fi

echo

###############################################################################
# 2. SERVICE HEALTH
###############################################################################

echo "[2] SERVICE HEALTH"

# Check SPXer
SPXER_STATUS="unknown"
if pm2 describe spxer &> /dev/null; then
    SPXER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="spxer") | .pm2_env.status')
    SPXER_RESTARTS=$(pm2 jlist | jq -r '.[] | select(.name=="spxer") | .pm2_env.restart_time' || echo "0")

    if [ "$SPXER_STATUS" = "online" ]; then
        pass "SPXer service ONLINE"

        if [ "$SPXER_RESTARTS" -gt 10 ]; then
            warn "SPXer restarted ${SPXER_RESTARTS} times - check stability"
            WARNINGS=$((WARNINGS + 1))
        fi
    else
        fail "SPXer service: $SPXER_STATUS"
        ISSUES=$((ISSUES + 1))
    fi
else
    fail "SPXer not configured in PM2"
    ISSUES=$((ISSUES + 1))
fi

# Check Event Handler
HANDLER_STATUS="unknown"
if pm2 describe event-handler &> /dev/null; then
    HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
    HANDLER_RESTARTS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.restart_time' || echo "0")

    if [ "$HANDLER_STATUS" = "online" ]; then
        pass "Event Handler ONLINE"

        if [ "$HANDLER_RESTARTS" -gt 5 ]; then
            warn "Event Handler restarted ${HANDLER_RESTARTS} times - check stability"
            WARNINGS=$((WARNINGS + 1))
        fi
    else
        fail "Event Handler: $HANDLER_STATUS"
        ISSUES=$((ISSUES + 1))
    fi
else
    fail "Event Handler not configured in PM2"
    ISSUES=$((ISSUES + 1))
fi

# Check Position Monitor
MONITOR_STATUS="unknown"
if pm2 describe position-monitor &> /dev/null; then
    MONITOR_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="position-monitor") | .pm2_env.status')
    MONITOR_RESTARTS=$(pm2 jlist | jq -r '.[] | select(.name=="position-monitor") | .pm2_env.restart_time' || echo "0")

    if [ "$MONITOR_STATUS" = "online" ]; then
        pass "Position Monitor ONLINE"

        if [ "$MONITOR_RESTARTS" -gt 5 ]; then
            warn "Position Monitor restarted ${MONITOR_RESTARTS} times - check stability"
            WARNINGS=$((WARNINGS + 1))
        fi
    else
        fail "Position Monitor: $MONITOR_STATUS"
        ISSUES=$((ISSUES + 1))
    fi
else
    warn "Position Monitor not configured in PM2"
    WARNINGS=$((WARNINGS + 1))
fi

echo

###############################################################################
# 3. SIGNAL DETECTION
###############################################################################

echo "[3] SIGNAL DETECTION"

# Check event handler logs for signal detection activity
SIGNAL_CHECK=$(pm2 logs event-handler --nostream --lines 100 --raw 2>&1 | grep "SIGNAL:" | tail -1 || true)

if [ -n "$SIGNAL_CHECK" ]; then
    # Extract signal info from log
    SIGNAL_DIR=$(echo "$SIGNAL_CHECK" | grep -oP "SIGNAL: \K\w+" || echo "unknown")
    SIGNAL_TIME=$(echo "$SIGNAL_CHECK" | grep -oP "at \K[^:]+" || echo "unknown")

    if [ "$SIGNAL_DIR" != "unknown" ]; then
        pass "Signal detection working: $SIGNAL_DIR"
        info "Last signal: $SIGNAL_CHECK"
        SIGNAL_JSON="{\"hasSignal\": true, \"lastSignal\": \"$SIGNAL_DIR at $SIGNAL_TIME\"}"
    else
        warn "Signal detection active but no recent cross"
        WARNINGS=$((WARNINGS + 1))
        SIGNAL_JSON="{\"hasSignal\": false, \"lastSignal\": null}"
    fi
else
    # Check if signal detection function is being called
    TIMER_CHECK=$(pm2 logs event-handler --nostream --lines 100 --raw 2>&1 | grep "checkForSignals" | tail -1 || true)

    if [ -n "$TIMER_CHECK" ]; then
        info "Signal detection timer active, no crosses yet"
        SIGNAL_JSON="{\"hasSignal\": false, \"lastSignal\": null}"
    else
        warn "No signal detection activity found"
        WARNINGS=$((WARNINGS + 1))
        SIGNAL_JSON="{\"hasSignal\": false, \"lastSignal\": null, \"status\": \"inactive\"}"
    fi
fi

# Check for Tradier API errors in signal detection
TRADIER_ERRORS=$(pm2 logs event-handler --nostream --lines 100 --raw 2>&1 | grep -i "tradier\|401\|403\|429" | tail -3 || true)
if [ -n "$TRADIER_ERRORS" ]; then
    warn "Tradier API errors detected:"
    echo "$TRADIER_ERRORS"
    WARNINGS=$((WARNINGS + 1))
fi

echo

###############################################################################
# 4. ACTIVE POSITIONS
###############################################################################

echo "[4] ACTIVE POSITIONS"

OPEN_COUNT=0
ORPHANED=0
DAILY_PNL=0

if [ -f "data/account.db" ]; then
    OPEN_COUNT=$(sqlite3 data/account.db "SELECT COUNT(*) FROM positions WHERE status IN ('OPEN', 'OPENING');" 2>/dev/null || echo "0")

    if [ "$OPEN_COUNT" = "0" ]; then
        info "No open positions"
    else
        info "Open positions: $OPEN_COUNT"

        # Show position summary
        echo "Position summary:"
        sqlite3 -header -column data/account.db \
            "SELECT symbol, side, quantity, entry_price, status FROM positions WHERE status IN ('OPEN', 'OPENING');" 2>/dev/null || true
    fi

    # Check for orphaned positions
    ORPHANED=$(sqlite3 data/account.db "SELECT COUNT(*) FROM positions WHERE status='ORPHANED';" 2>/dev/null || echo "0")
    if [ "$ORPHANED" -gt 0 ]; then
        warn "Found $ORPHANED orphaned position(s) - needs attention"
        WARNINGS=$((WARNINGS + 1))
    fi

    # Check daily P&L
    PNL=$(sqlite3 data/account.db "SELECT CAST(COALESCE(daily_pnl, 0) AS INTEGER) FROM config_state LIMIT 1;" 2>/dev/null || echo "0")
    if [ "$PNL" != "0" ]; then
        DAILY_PNL=$PNL
        info "Daily P&L: \$$PNL"

        # Warn if approaching max loss (use integer comparison)
        if [ "$PNL" -lt -500 ] 2>/dev/null; then
            warn "Approaching max daily loss limit"
            WARNINGS=$((WARNINGS + 1))
        fi
    fi

    POSITIONS_JSON="{\"open\": $OPEN_COUNT, \"orphaned\": $ORPHANED, \"dailyPnl\": $DAILY_PNL}"
else
    warn "Account DB not found - cannot check positions"
    WARNINGS=$((WARNINGS + 1))
fi

echo

###############################################################################
# 5. BROKER CONNECTIVITY
###############################################################################

echo "[5] BROKER CONNECTIVITY"

if [ -n "${TRADIER_TOKEN:-}" ]; then
    TRADIER_CHECK=$(curl -s -H "Authorization: Bearer $TRADIER_TOKEN" \
        "https://api.tradier.com/v1/accounts/account" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$TRADIER_CHECK" | jq -e '.account' > /dev/null 2>&1; then
        pass "Tradier API reachable"
        BROKER_JSON="{\"status\": \"reachable\"}"
    else
        fail "Tradier API not reachable"
        ISSUES=$((ISSUES + 1))
        BROKER_JSON="{\"status\": \"unreachable\"}"
    fi
else
    warn "TRADIER_TOKEN not set"
    WARNINGS=$((WARNINGS + 1))
    BROKER_JSON="{\"status\": \"no_token\"}"
fi

echo

###############################################################################
# 6. RECENT ERRORS
###############################################################################

echo "[6] RECENT ERRORS"

# Check SPXer logs for errors
SPXER_ERRORS=$(pm2 logs spxer --nostream --lines 100 --raw 2>&1 | grep -i "error\|fail\|crash" | tail -5 || true)
SPXER_ERROR_COUNT=$(echo "$SPXER_ERRORS" | grep -c "error\|fail\|crash" || echo 0)

if [ -z "$SPXER_ERRORS" ]; then
    pass "No errors in SPXer logs"
else
    warn "Recent errors in SPXer:"
    echo "$SPXER_ERRORS" | head -3
    WARNINGS=$((WARNINGS + 1))
fi

# Check Event Handler logs
HANDLER_ERRORS=$(pm2 logs event-handler --nostream --lines 100 --raw 2>&1 | grep -i "error\|fail\|crash" | tail -5 || true)
HANDLER_ERROR_COUNT=$(echo "$HANDLER_ERRORS" | grep -c "error\|fail\|crash" || echo 0)

if [ -z "$HANDLER_ERRORS" ]; then
    pass "No errors in Event Handler logs"
else
    warn "Recent errors in Event Handler:"
    echo "$HANDLER_ERRORS" | head -3
    WARNINGS=$((WARNINGS + 1))
fi

echo

###############################################################################
# 7. POST TO DEVOPS DASHBOARD
###############################################################################

echo "[7] POSTING TO DEVOPS DASHBOARD"

TIMESTAMP_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build summary text
if [ $ISSUES -gt 0 ]; then
    SUMMARY="CRITICAL: $ISSUES issue(s) detected"
elif [ $WARNINGS -gt 3 ]; then
    SUMMARY="WARNING: $WARNINGS warning(s) - monitor closely"
else
    SUMMARY="All systems operational"
fi

# Build JSON payload
PAYLOAD=$(cat <<EOF
{
  "timestamp": "$TIMESTAMP_ISO",
  "issues": $ISSUES,
  "warnings": $WARNINGS,
  "checks": {
    "spxFreshness": $SPX_FRESHNESS_JSON,
    "optionFreshness": $OPTION_FRESHNESS_JSON,
    "spxerService": {"status": "$SPXER_STATUS", "restarts": $SPXER_RESTARTS},
    "handlerService": {"status": "$HANDLER_STATUS", "restarts": $HANDLER_RESTARTS},
    "signalDetection": $SIGNAL_JSON,
    "positions": $POSITIONS_JSON,
    "brokerConnectivity": $BROKER_JSON,
    "recentErrors": {"spxerErrors": $SPXER_ERROR_COUNT, "handlerErrors": $HANDLER_ERROR_COUNT}
  },
  "summary": "$SUMMARY"
}
EOF
)

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    http://localhost:3600/devops/monitoring 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    pass "Results posted to DevOps dashboard"
    info "View at: http://bitloom.cloud/devops/viewer"
else
    warn "Failed to post results (HTTP $HTTP_CODE)"
fi

echo

###############################################################################
# SUMMARY
###############################################################################

echo "======================================"
echo "MONITORING SUMMARY"
echo "======================================"
echo "Issues: $ISSUES"
echo "Warnings: $WARNINGS"
echo "Status: $SUMMARY"
echo

if [ $ISSUES -gt 0 ]; then
    fail "CRITICAL ISSUES DETECTED - Investigation required"
    exit 1
elif [ $WARNINGS -gt 3 ]; then
    warn "Multiple warnings - monitor closely"
    exit 0
else
    pass "Operational level maintained"
    exit 0
fi
