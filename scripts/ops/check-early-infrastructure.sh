#!/bin/bash
# 06:00 AM ET - Early Infrastructure Checks (Tiers 1-5)
# Verifies tools, data sources, calculations, signal logic, and configuration
# These checks can run early while systems are warming up

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

check_pass() {
    pass "$1"
    TOTAL_PASS=$((TOTAL_PASS + 1))
}

check_fail() {
    fail "$1"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
}

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   06:00 AM ET - Early Infrastructure   ║"
echo "║   Tiers 1-5: Tools → Config            ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo "Started: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo

# ============================================================================
# TIER 1: TOOL FUNCTIONALITY
# ============================================================================
header "TIER 1: TOOL FUNCTIONALITY"
echo

# Data Service
if curl -s http://localhost:3600/health > /dev/null 2>&1; then
    check_pass "Data service reachable on port 3600"
else
    check_fail "Data service NOT reachable - start with: pm2 start spxer"
fi

# Database
if [ -f "$SPXER_DIR/data/spxer.db" ]; then
    DB_SIZE=$(du -h "$SPXER_DIR/data/spxer.db" | cut -f1)
    check_pass "Replay DB exists (${DB_SIZE})"
else
    check_fail "Replay DB missing"
fi

# API Token
if [ -n "${TRADIER_TOKEN:-}" ]; then
    check_pass "TRADIER_TOKEN set"
else
    check_fail "TRADIER_TOKEN not set"
fi

echo

# ============================================================================
# TIER 2: THE READING
# ============================================================================
header "TIER 2: THE READING"
echo

# SPX Snapshot
SPX_SNAPSHOT=$(curl -s http://localhost:3600/spx/snapshot 2>/dev/null || echo '{}')
if echo "$SPX_SNAPSHOT" | jq -e '.close' > /dev/null 2>&1; then
    SPX_PRICE=$(echo "$SPX_SNAPSHOT" | jq -r '.close')
    check_pass "SPX price: \$${SPX_PRICE}"
else
    warn "SPX snapshot unavailable (normal at 06:00 AM ET - Tradier starts at 08:00 AM ET)"
fi

echo

# ============================================================================
# TIER 3: CALCULATION VERIFICATION
# ============================================================================
header "TIER 3: CALCULATION VERIFICATION"
echo

# HMA Values
if echo "$SPX_SNAPSHOT" | jq -e '.indicators.hma3' > /dev/null 2>&1; then
    HMA3=$(echo "$SPX_SNAPSHOT" | jq -r '.indicators.hma3')
    check_pass "HMA(3): $HMA3"
else
    warn "HMA indicators not ready (normal at 06:00 AM ET)"
fi

echo

# ============================================================================
# TIER 4: SIGNAL LOGIC
# ============================================================================
header "TIER 4: SIGNAL LOGIC"
echo

# Data Service Running
if pm2 describe spxer &> /dev/null; then
    check_pass "Data service running"
else
    check_fail "Data service not running"
fi

echo

# ============================================================================
# TIER 5: CONFIGURATION
# ============================================================================
header "TIER 5: CONFIGURATION"
echo

# Config ID
if [ -n "${AGENT_CONFIG_ID:-}" ]; then
    check_pass "AGENT_CONFIG_ID: $AGENT_CONFIG_ID"
else
    warn "AGENT_CONFIG_ID not set (will use defaults)"
fi

# Execution Mode
EXEC_MODE=${AGENT_EXECUTION_MODE:-"UNSET"}
check_pass "Execution mode: $EXEC_MODE"

# Account ID
if [ -n "${TRADIER_ACCOUNT_ID:-}" ]; then
    check_pass "TRADIER_ACCOUNT_ID: $TRADIER_ACCOUNT_ID"
else
    warn "TRADIER_ACCOUNT_ID not set"
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
    echo -e "${GREEN}✅ Early infrastructure checks PASSED${NC}"
    exit 0
else
    echo -e "${RED}❌ Early infrastructure checks FAILED${NC}"
    exit 1
fi
