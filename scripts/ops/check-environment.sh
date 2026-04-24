#!/bin/bash
# SECTION A1: Environment Verification
# Runs at 06:00 ET every trading day

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
warn() { echo -e "${YELLOW}⚠️  WARN${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; }
info() { echo -e "${BLUE}ℹ️  INFO${NC}: $1"; }

echo "======================================"
echo "SECTION A1: Environment Verification"
echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "======================================"
echo

FAIL_COUNT=0
WARN_COUNT=0

# 1. Date/Time Check
echo "[1] Date/Time Check"
CURRENT_DAY=$(date '+%u')  # 1=Mon, 7=Sun
CURRENT_HOUR=$(date '+%H')

# Check if weekday
if [ $CURRENT_DAY -ge 6 ]; then
    warn "Today is weekend - no trading expected"
    WARN_COUNT=$((WARN_COUNT + 1))
else
    pass "Weekday confirmed"
fi

# Check timezone
if [ "$(date '+%Z')" = "EDT" ] || [ "$(date '+%Z')" = "EST" ]; then
    pass "Timezone set to ET ($(date '+%Z'))"
else
    fail "Timezone not ET (current: $(date '+%Z'))"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo

# 2. Process Status
echo "[2] Process Status (PM2)"
if command -v pm2 &> /dev/null; then
    # Check data service
    if pm2 describe spxer &> /dev/null; then
        SPXER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="spxer") | .pm2_env.status')
        if [ "$SPXER_STATUS" = "online" ]; then
            pass "Data service (spxer): RUNNING"
        else
            fail "Data service (spxer): $SPXER_STATUS"
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi
    else
        fail "Data service (spxer): NOT FOUND"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi

    # Check event handler
    if pm2 describe event-handler &> /dev/null; then
        HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status')
        info "Event handler: $HANDLER_STATUS (should be STOPPED at 06:00)"
    else
        pass "Event handler: NOT RUNNING (will start at 09:00)"
    fi

    # Check metrics collector (optional)
    if pm2 describe metrics-collector &> /dev/null; then
        METRICS_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="metrics-collector") | .pm2_env.status')
        [ "$METRICS_STATUS" = "online" ] && pass "Metrics collector: RUNNING" || warn "Metrics collector: $METRICS_STATUS"
    else
        info "Metrics collector: NOT RUNNING (optional)"
    fi
else
    fail "PM2 not found - cannot check process status"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo

# 3. Resource Check
echo "[3] Resource Check"

# Disk space
DISK_AVAIL_GB=$(df -BG . | awk 'NR==2 {print $4}' | tr -d 'G')
if [ $DISK_AVAIL_GB -gt 10 ]; then
    pass "Disk space: ${DISK_AVAIL_GB}GB free"
else
    fail "Disk space: ${DISK_AVAIL_GB}GB free (need > 10GB)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Memory
MEM_PCT=$(free | awk 'NR==2{printf "%.0f", $3*100/$2}')
if [ $MEM_PCT -lt 80 ]; then
    pass "Memory usage: ${MEM_PCT}%"
else
    warn "Memory usage: ${MEM_PCT}% (high)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi

# CPU load (1-minute average)
LOAD_1MIN=$(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | tr -d ',')
LOAD_INT=$(echo "$LOAD_1MIN" | cut -d. -f1)
if [ $LOAD_INT -lt 2 ]; then
    pass "CPU load (1m): $LOAD_1MIN"
else
    warn "CPU load (1m): $LOAD_1MIN (elevated)"
    WARN_COUNT=$((WARN_COUNT + 1))
fi

echo
echo "======================================"
echo "A1 Summary:"
echo "  Failures: $FAIL_COUNT"
echo "  Warnings: $WARN_COUNT"
echo "======================================"

if [ $FAIL_COUNT -eq 0 ]; then
    pass "A1 COMPLETE - Proceed to A2"
    exit 0
elif [ $FAIL_COUNT -eq 1 ]; then
    warn "A1 COMPLETE with warnings - Proceed with caution"
    exit 0
else
    fail "A1 FAILED - Run ./scripts/ops/repair-environment.sh"
    exit 1
fi
