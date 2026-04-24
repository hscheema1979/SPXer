#!/bin/bash
###############################################################################
# Ongoing Operational Monitoring
# Purpose: Run every 30 minutes DURING TRADING HOURS to verify the system
#          maintains operational level throughout the trading cycle
#
# Focus: Data freshness, signal detection, service health, positions
#
# Posts results to /devops/monitoring for dashboard display
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

###############################################################################
# 1. DATA FRESHNESS - Most Critical
###############################################################################

echo "[1] DATA FRESHNESS"

# Check SPX data freshness
SPX_HEALTH=$(curl -s "$BASE_URL/health" 2>/dev/null || echo '{}')
SPX_STALE=$(echo "$SPX_HEALTH" | jq -r '.data.SPX.staleSec // -1' 2>/dev/null || echo "-1")

if [ "$SPX_STALE" != "-1" ]; then
    if [ $SPX_STALE -lt 120 ]; then
        pass "SPX data fresh (${SPX_STALE}s old)"
    elif [ $SPX_STALE -lt 300 ]; then
        warn "SPX data stale (${SPX_STALE}s old)"
        WARNINGS=$((WARNINGS + 1))
    else
        fail "SPX data VERY stale (${SPX_STALE}s old)"
        ISSUES=$((ISSUES + 1))
    fi
else
    fail "Cannot check SPX freshness"
    ISSUES=$((ISSUES + 1))
fi

# Check option data freshness (should have recent bars)
OPTION_STALE=$(curl -s "$BASE_URL/health" 2>/dev/null | jq -r '.data | to_entries | map(.value.staleSec) | max // -1' 2>/dev/null || echo "-1")

if [ "$OPTION_STALE" != "-1" ]; then
    if [ $OPTION_STALE -lt 600 ]; then
        pass "Option bars fresh (max ${OPTION_STALE}s old)"
    elif [ $OPTION_STALE -lt 1200 ]; then
        warn "Option bars stale (max ${OPTION_STALE}s old)"
        WARNINGS=$((WARNINGS + 1))
    else
        fail "Option bars VERY stale (max ${OPTION_STALE}s old)"
        ISSUES=$((ISSUES + 1))
    fi
else
    fail "Cannot check option freshness"
    ISSUES=$((ISSUES + 1))
fi

echo

###############################################################################
# 2. SERVICE HEALTH - Are processes running?
###############################################################################

echo "[2] SERVICE HEALTH"

# Check SPXer
if pm2 describe spxer &> /dev/null; then
    SPXER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="spxer") | .pm2_env.status')
    if [ "$SPXER_STATUS" = "online" ]; then
        pass "SPXer service ONLINE"

        # Check restart count
        RESTARTS=$(pm2 jlist | jq -r '.[] | select(.name=="spxer") | .pm2_env.restart_time')
        if [ "$RESTARTS" -gt 10 ]; then
            warn "SPXer restarted ${RESTARTS} times - check stability"
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
if pm2 describe event-handler &> /dev/null; then
    HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
    if [ "$HANDLER_STATUS" = "online" ]; then
        pass "Event Handler ONLINE"

        RESTARTS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.restart_time')
        if [ "$RESTARTS" -gt 5 ]; then
            warn "Event Handler restarted ${RESTARTS} times - check stability"
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

echo

###############################################################################
# 3. SIGNAL DETECTION - Are signals being detected?
###############################################################################

echo "[3] SIGNAL DETECTION"

LATEST_SIGNAL=$(curl -s "$BASE_URL/signal/latest" 2>/dev/null || echo '{"signal":null}')

HAS_SIGNAL=$(echo "$LATEST_SIGNAL" | jq -r '.signal // "null"' 2>/dev/null || echo "null")

if [ "$HAS_SIGNAL" != "null" ]; then
    SIGNAL_TIME=$(echo "$LATEST_SIGNAL" | jq -r '.signal.ts // "unknown"' 2>/dev/null || echo "unknown")
    SIGNAL_DIR=$(echo "$LATEST_SIGNAL" | jq -r '.signal.direction // "unknown"' 2>/dev/null || echo "unknown")
    SIGNAL_PRICE=$(echo "$LATEST_SIGNAL" | jq -r '.signal.price // "unknown"' 2>/dev/null || echo "unknown")

    info "Last signal: $SIGNAL_DIR @ \$${SIGNAL_PRICE} at $SIGNAL_TIME"

    # Check signal age
    if [ "$SIGNAL_TIME" != "unknown" ]; then
        SIGNAL_UNIX=$(date -d "$SIGNAL_TIME" +%s 2>/dev/null || echo 0)
        CURRENT_UNIX=$(date +%s)
        SIGNAL_AGE_MIN=$(( (CURRENT_UNIX - SIGNAL_UNIX) / 60 ))

        if [ $SIGNAL_AGE_MIN -lt 60 ]; then
            pass "Signal fresh (${SIGNAL_AGE_MIN} min old)"
        elif [ $SIGNAL_AGE_MIN -lt 180 ]; then
            warn "Signal aging (${SIGNAL_AGE_MIN} min old)"
            WARNINGS=$((WARNINGS + 1))
        else
            fail "Signal stale (${SIGNAL_AGE_MIN} min old)"
            ISSUES=$((ISSUES + 1))
        fi
    fi
else
    warn "No signals detected yet"
    WARNINGS=$((WARNINGS + 1))
fi

echo

###############################################################################
# 4. ACTIVE POSITIONS - Track what's open
###############################################################################

echo "[4] ACTIVE POSITIONS"

if [ -f "data/account.db" ]; then
    # Check account DB for open positions
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

    # Check daily P&L from broker
    PNL=$(sqlite3 data/account.db "SELECT CAST(daily_pnl AS INTEGER) FROM config_state WHERE config_id=(SELECT config_id FROM positions LIMIT 1);" 2>/dev/null || echo "0")
    if [ "$PNL" != "0" ]; then
        info "Daily P&L: \$$PNL"

        # Warn if approaching max loss (use integer comparison)
        if [ "$PNL" -lt -500 ] 2>/dev/null; then
            warn "Approaching max daily loss limit"
            WARNINGS=$((WARNINGS + 1))
        fi
    fi
else
    warn "Account DB not found - cannot check positions"
    WARNINGS=$((WARNINGS + 1))
fi

echo

###############################################################################
# 5. CONNECTIVITY - Can we reach brokers?
###############################################################################

echo "[5] BROKER CONNECTIVITY"

if [ -n "${TRADIER_TOKEN:-}" ]; then
    TRADIER_CHECK=$(curl -s -H "Authorization: Bearer $TRADIER_TOKEN" \
        "https://api.tradier.com/v1/accounts/account" 2>/dev/null || echo '{"error":"failed"}')

    if echo "$TRADIER_CHECK" | jq -e '.account' > /dev/null 2>&1; then
        pass "Tradier API reachable"
    else
        fail "Tradier API not reachable"
        ISSUES=$((ISSUES + 1))
    fi
else
    warn "TRADIER_TOKEN not set"
    WARNINGS=$((WARNINGS + 1))
fi

echo

###############################################################################
# 6. RECENT ERRORS - Check logs for problems
###############################################################################

echo "[6] RECENT ERRORS"

# Check SPXer logs for errors in last 30 minutes
SPXER_ERRORS=$(pm2 logs spxer --nostream --lines 100 --raw 2>&1 | grep -i "error\|fail\|crash" | tail -5 || true)

if [ -z "$SPXER_ERRORS" ]; then
    pass "No errors in SPXer logs"
else
    warn "Recent errors in SPXer:"
    echo "$SPXER_ERRORS" | head -3
    WARNINGS=$((WARNINGS + 1))
fi

# Check Event Handler logs
HANDLER_ERRORS=$(pm2 logs event-handler --nostream --lines 100 --raw 2>&1 | grep -i "error\|fail\|crash" | tail -5 || true)

if [ -z "$HANDLER_ERRORS" ]; then
    pass "No errors in Event Handler logs"
else
    warn "Recent errors in Event Handler:"
    echo "$HANDLER_ERRORS" | head -3
    WARNINGS=$((WARNINGS + 1))
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
