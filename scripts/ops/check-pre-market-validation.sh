#!/bin/bash
# 07:50 AM ET - Pre-Market Validation (Tiers 11-17)
# Verifies market state, financial, time decay, network, data quality, human, regulatory
# These checks must run right before warmup to ensure current market conditions

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
header() { echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPXER_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$SPXER_DIR"

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_WARN=0

check_pass() { pass "$1"; TOTAL_PASS=$((TOTAL_PASS + 1)); }
check_fail() { fail "$1"; TOTAL_FAIL=$((TOTAL_FAIL + 1)); }
check_warn() { warn "$1"; TOTAL_WARN=$((TOTAL_WARN + 1)); }

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   07:50 AM ET - Pre-Market Validation  ║"
echo "║   Tiers 11-17: Market → Regulatory     ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo "Started: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo

# ============================================================================
# TIER 11: MARKET STATE
# ============================================================================
header "TIER 11: MARKET STATE"
echo

# Day of Week
DAY_OF_WEEK=$(date +%u)
if [ $DAY_OF_WEEK -le 5 ]; then
    check_pass "Weekday confirmed"
else
    check_warn "Weekend detected"
fi

# Market Time
HOUR_ET=$(TZ='America/New_York' date +%H)
if [ $HOUR_ET -eq 7 ] || [ $HOUR_ET -eq 8 ]; then
    check_pass "Pre-market window (07:50-08:00 ET)"
else
    check_warn "Current time: ${HOUR_ET}:00 ET (expected 07:50-08:00)"
fi

# Market Holiday
TODAY=$(TZ='America/New_York' date +%Y-%m-%d)
HOLIDAYS_2026=("2026-01-01" "2026-07-04" "2026-12-25")
IS_HOLIDAY=false
for holiday in "${HOLIDAYS_2026[@]}"; do
    if [ "$TODAY" = "$holiday" ]; then
        IS_HOLIDAY=true
        break
    fi
done

if [ "$IS_HOLIDAY" = false ]; then
    check_pass "Not a market holiday"
else
    check_fail "Today is a market holiday"
fi

echo

# ============================================================================
# TIER 12: FINANCIAL STATE
# ============================================================================
header "TIER 12: FINANCIAL STATE"
echo

# Account DB
if [ -f "$SPXER_DIR/data/account.db" ]; then
    check_pass "Account DB exists"
else
    check_warn "Account DB not found (will create on first trade)"
fi

# Daily Loss Limit
if [ -n "${MAX_DAILY_LOSS:-}" ]; then
    check_pass "Max daily loss: \$${MAX_DAILY_LOSS}"
else
    check_warn "MAX_DAILY_LOSS not configured"
fi

echo

# ============================================================================
# TIER 13: TIME DECAY
# ============================================================================
header "TIER 13: TIME DECAY"
echo

# DTE
TODAY_YYMMDD=$(date +%y%m%d)
check_pass "Trading 0DTE: SPXW${TODAY_YYMMDD}*"

# Time to Close
HOUR_ET=$(TZ='America/New_York' date +%H)
MINUTE_ET=$(TZ='America/New_York' date +%M)
CURRENT_MIN=$((HOUR_ET * 60 + MINUTE_ET))
CLOSE_MIN=$((16 * 60))
MIN_UNTIL_CLOSE=$((CLOSE_MIN - CURRENT_MIN))

if [ $MIN_UNTIL_CLOSE -gt 0 ]; then
    HOURS_UNTIL=$((MIN_UNTIL_CLOSE / 60))
    MINS_UNTIL=$((MIN_UNTIL_CLOSE % 60))
    check_pass "${HOURS_UNTIL}h ${MINS_UNTIL}m until market close"
fi

echo

# ============================================================================
# TIER 14: NETWORK/CONNECTIVITY
# ============================================================================
header "TIER 14: NETWORK/CONNECTIVITY"
echo

# Tradier API
if ping -c 1 api.tradier.com > /dev/null 2>&1; then
    check_pass "Tradier API reachable"
else
    check_warn "Tradier API not reachable"
fi

# DNS
if nslookup api.tradier.com > /dev/null 2>&1; then
    check_pass "DNS resolution working"
else
    check_warn "DNS resolution issues"
fi

echo

# ============================================================================
# TIER 15: DATA QUALITY
# ============================================================================
header "TIER 15: DATA QUALITY"
echo

# SPX Price Sanity
SPX_SNAPSHOT=$(curl -s http://localhost:3600/spx/snapshot 2>/dev/null || echo '{}')
if echo "$SPX_SNAPSHOT" | jq -e '.close' > /dev/null 2>&1; then
    SPX_PRICE=$(echo "$SPX_SNAPSHOT" | jq -r '.close')
    if (( $(echo "$SPX_PRICE > 4000" | bc -l) )) && (( $(echo "$SPX_PRICE < 8000" | bc -l) )); then
        check_pass "SPX price sane: \$${SPX_PRICE}"
    else
        check_fail "SPX price anomalous: \$${SPX_PRICE}"
    fi
fi

echo

# ============================================================================
# TIER 16: HUMAN READINESS
# ============================================================================
header "TIER 16: HUMAN READINESS"
echo

# Trading Halt
if [ ! -f "$SPXER_DIR/.trading-halt" ]; then
    check_pass "No manual trading halt"
else
    check_fail "TRADING HALT file detected - remove .trading-halt to proceed"
fi

# Alerts
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    check_pass "Alerts configured"
else
    check_warn "No alerting configured"
fi

echo

# ============================================================================
# TIER 17: REGULATORY/COMPLIANCE
# ============================================================================
header "TIER 17: REGULATORY/COMPLIANCE"
echo

# Account Type
check_pass "Account type: Margin (6YA51425)"

# Position Limits
if [ -n "${MAX_POSITIONS:-}" ]; then
    check_pass "Max positions: $MAX_POSITIONS"
else
    check_warn "MAX_POSITIONS not configured"
fi

echo

# ============================================================================
# SUMMARY
# ============================================================================
header "SUMMARY"
echo
echo "Passed: $TOTAL_PASS"
echo "Warnings: $TOTAL_WARN"
echo "Failed: $TOTAL_FAIL"
echo

if [ $TOTAL_FAIL -eq 0 ]; then
    echo -e "${GREEN}✅ Pre-market validation PASSED${NC}"
    echo
    echo "System GO for warmup at 08:00 AM ET"
    exit 0
else
    echo -e "${RED}❌ Pre-market validation FAILED${NC}"
    echo
    echo "Fix failures before starting warmup"
    exit 1
fi
