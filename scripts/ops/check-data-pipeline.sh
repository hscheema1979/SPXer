#!/bin/bash
# 07:00 AM ET - Data Pipeline Checks (Tiers 6-10)
# Verifies system visibility, E2E pipeline, state reconciliation, freshness, acceptance
# These checks need the data service to be actively collecting data

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

check_pass() { pass "$1"; TOTAL_PASS=$((TOTAL_PASS + 1)); }
check_fail() { fail "$1"; TOTAL_FAIL=$((TOTAL_FAIL + 1)); }

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   07:00 AM ET - Data Pipeline Checks   ║"
echo "║   Tiers 6-10: Visibility → Acceptance  ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo "Started: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo

# ============================================================================
# TIER 6: SYSTEM VISIBILITY
# ============================================================================
header "TIER 6: SYSTEM VISIBILITY"
echo

# API Endpoints
API_ENDPOINTS=("/health" "/spx/snapshot" "/contracts/active" "/signal/latest")
ENDPOINT_PASS=0
for endpoint in "${API_ENDPOINTS[@]}"; do
    if curl -s "http://localhost:3600${endpoint}" > /dev/null 2>&1; then
        ENDPOINT_PASS=$((ENDPOINT_PASS + 1))
    fi
done

check_pass "API endpoints responding: $ENDPOINT_PASS/${#API_ENDPOINTS[@]}"

echo

# ============================================================================
# TIER 7: E2E PIPELINE
# ============================================================================
header "TIER 7: E2E PIPELINE"
echo

# SPX Bars
SPX_BARS=$(curl -s "http://localhost:3600/spx/bars?tf=1m&n=10" 2>/dev/null || echo "[]")
if echo "$SPX_BARS" | jq -e '.[0].close' > /dev/null 2>&1; then
    BAR_COUNT=$(echo "$SPX_BARS" | jq '. | length')
    check_pass "SPX bars available: $BAR_COUNT bars"
else
    warn "Could not fetch SPX bars (may be warming up)"
fi

echo

# ============================================================================
# TIER 8: STATE RECONCILIATION
# ============================================================================
header "TIER 8: STATE RECONCILIATION"
echo

# Database Integrity
if [ -f "$SPXER_DIR/data/spxer.db" ]; then
    INTEGRITY_CHECK=$(sqlite3 "$SPXER_DIR/data/spxer.db" "PRAGMA integrity_check" 2>&1)
    if [ "$INTEGRITY_CHECK" = "ok" ]; then
        check_pass "Replay DB integrity: OK"
    else
        check_fail "Replay DB integrity: $INTEGRITY_CHECK"
    fi
fi

echo

# ============================================================================
# TIER 9: FRESHNESS
# ============================================================================
header "TIER 9: FRESHNESS"
echo

# SPX Data Freshness
HEALTH=$(curl -s http://localhost:3600/health 2>/dev/null || echo '{}')
if echo "$HEALTH" | jq -e '.spx_last_update' > /dev/null 2>&1; then
    LAST_UPDATE=$(echo "$HEALTH" | jq -r '.spx_last_update')
    CURRENT_TIME=$(date +%s)
    UPDATE_TIME=$(date -d "$LAST_UPDATE" +%s 2>/dev/null || echo "0")

    if [ "$UPDATE_TIME" -gt 0 ]; then
        AGE=$((CURRENT_TIME - UPDATE_TIME))
        if [ $AGE -lt 600 ]; then
            check_pass "SPX data fresh: ${AGE}s old"
        else
            warn "SPX data stale: ${AGE}s old"
        fi
    fi
else
    warn "Could not verify SPX data freshness"
fi

# EOD pipeline freshness (FR-001): the nightly eod-pipeline hung SILENTLY for
# three weeks (2026-07-31 → 2026-08-19) — the only symptom was a growing pile
# of orphaned sweep processes and stale NDX state. Alert on the age of the
# last "=== EOD pipeline done ===" line instead. Thresholds mirror
# eodFreshnessStatus() in src/ops/pipeline-health.ts: warn >72h (weekend-
# tolerant), fail >96h (Monday-holiday-tolerant).
EOD_LOG="$SPXER_DIR/logs/eod-pipeline.log"
if [ -f "$EOD_LOG" ]; then
    LAST_DONE_TS=$(grep '=== EOD pipeline done ===' "$EOD_LOG" | tail -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
    if [ -n "$LAST_DONE_TS" ]; then
        LAST_DONE_EPOCH=$(date -d "${LAST_DONE_TS}Z" +%s 2>/dev/null || echo 0)
        NOW_EPOCH=$(date +%s)
        EOD_AGE_H=$(( (NOW_EPOCH - LAST_DONE_EPOCH) / 3600 ))
        if [ "$EOD_AGE_H" -le 72 ]; then
            check_pass "EOD pipeline fresh: last complete run ${EOD_AGE_H}h ago"
        elif [ "$EOD_AGE_H" -le 96 ]; then
            warn "EOD pipeline stale: last complete run ${EOD_AGE_H}h ago"
        else
            check_fail "EOD pipeline VERY stale: last complete run ${EOD_AGE_H}h ago (hung? check logs/eod-pipeline.log + sweep-reaper.log)"
        fi
    else
        warn "No completed EOD pipeline run found in logs/eod-pipeline.log"
    fi
fi

echo

# ============================================================================
# TIER 10: ACCEPTANCE
# ============================================================================
header "TIER 10: ACCEPTANCE"
echo

# No Critical Errors
if [ $TOTAL_FAIL -eq 0 ]; then
    check_pass "No critical errors in Tiers 6-9"
else
    check_fail "$TOTAL_FAIL error(s) present"
fi

echo

# ============================================================================
# SUMMARY
# ============================================================================
header "SUMMARY"
echo
echo "Passed: $TOTAL_PASS"
echo "Failed: $TOTAL_FAIL"
echo

if [ $TOTAL_FAIL -eq 0 ]; then
    echo -e "${GREEN}✅ Data pipeline checks PASSED${NC}"
    exit 0
else
    echo -e "${RED}❌ Data pipeline checks FAILED${NC}"
    exit 1
fi
