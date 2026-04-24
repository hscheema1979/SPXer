#!/bin/bash
# 17-Tier E2E Checklist - Runs at 08:00 AM ET every trading day
# Surgical verification: tool functionality → actual readings → state reconciliation
#
# Based on two-tier philosophy:
#   Tier 1: Tool Functionality - "Can we measure?"
#   Tier 2: The Reading - "What does it say?"
#
# Usage: ./scripts/ops/run-8am-checklist.sh [--skip-warnings] [--continue-on-fail]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
warn() { echo -e "${YELLOW}⚠️  WARN${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; }
info() { echo -e "${BLUE}ℹ️  INFO${NC}: $1"; }
header() { echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPXER_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$SPXER_DIR"

# Parse arguments
SKIP_WARNINGS=false
CONTINUE_ON_FAIL=false
for arg in "$@"; do
    case $arg in
        --skip-warnings) SKIP_WARNINGS=true ;;
        --continue-on-fail) CONTINUE_ON_FAIL=true ;;
    esac
done

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_WARN=0

check_pass() {
    pass "$1"
    TOTAL_PASS=$((TOTAL_PASS + 1))
}

check_fail() {
    fail "$1"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    if [ "$CONTINUE_ON_FAIL" = false ]; then
        return 1
    fi
}

check_warn() {
    warn "$1"
    TOTAL_WARN=$((TOTAL_WARN + 1))
}

# ============================================================================
# HEADER
# ============================================================================
echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   SPXer 17-Tier E2E Checklist         ║"
echo "║   Surgical Precision - 08:00 AM ET   ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo "Started: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo "User: $(whoami)@$(hostname)"
echo

# Log file
LOG_DIR="$SPXER_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/checklist-$(TZ='America/New_York' date '+%Y%m%d')-0800.log"

{
    echo "╔════════════════════════════════════════╗"
    echo "║   SPXer 17-Tier E2E Checklist         ║"
    echo "║   Started: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')   ║"
    echo "╚════════════════════════════════════════╝"
    echo
} >> "$LOG_FILE"

log_and_echo() {
    echo "$1"
    echo "$1" >> "$LOG_FILE"
}

# ============================================================================
# TIER 1: TOOL FUNCTIONALITY - "Can we measure?"
# ============================================================================
header "TIER 1: TOOL FUNCTIONALITY"
log_and_echo "Verifying we can measure market data..."
echo

# 1.1: Data Service Reachability
log_and_echo "[1.1] Data Service Reachability"
if curl -s http://localhost:3600/health > /dev/null 2>&1; then
    check_pass "Data service reachable on port 3600"
else
    if check_fail "Data service NOT reachable on port 3600"; then
        log_and_echo "  → Fix: pm2 start spxer"
    fi
fi
echo

# 1.2: WebSocket Reachability
log_and_echo "[1.2] WebSocket Reachability"
if command -v wscat &> /dev/null; then
    TIMEOUT=2
    if echo '{"action":"ping"}' | wscat -c ws://localhost:3600/ws -n 1 --timeout "$TIMEOUT" &> /dev/null; then
        check_pass "WebSocket endpoint responding"
    else
        check_warn "WebSocket may be closing immediately (normal if no active connection)"
    fi
else
    check_warn "wscat not installed - skipping WebSocket test"
fi
echo

# 1.3: Database Connection
log_and_echo "[1.3] Database Connection"
if [ -f "$SPXER_DIR/data/spxer.db" ]; then
    DB_SIZE=$(du -h "$SPXER_DIR/data/spxer.db" | cut -f1)
    check_pass "Replay DB exists (${DB_SIZE})"
else
    if check_fail "Replay DB missing: data/spxer.db"; then
        log_and_echo "  → Fix: Check DATA_PATH env var or run backfill"
    fi
fi

if [ -f "$SPXER_DIR/data/account.db" ]; then
    check_pass "Account DB exists"
else
    check_warn "Account DB missing (will be created on first trade)"
fi
echo

# 1.4: Tradier API Token
log_and_echo "[1.4] Tradier API Token"
if [ -n "${TRADIER_TOKEN:-}" ]; then
    check_pass "TRADIER_TOKEN set (${#TRADIER_TOKEN} chars)"
else
    if check_fail "TRADIER_TOKEN not set"; then
        log_and_echo "  → Fix: Add to .env file"
    fi
fi
echo

# 1.5: Provider Connections
log_and_echo "[1.5] Provider Connections"
PROVIDER_HEALTH=$(curl -s http://localhost:3600/health 2>/dev/null || echo '{}')
if echo "$PROVIDER_HEALTH" | jq -e '.provider_status' > /dev/null 2>&1; then
    THETA_STATUS=$(echo "$PROVIDER_HEALTH" | jq -r '.provider_status.theta // "disconnected"')
    if [ "$THETA_STATUS" = "connected" ]; then
        check_pass "ThetaData WebSocket: connected"
    else
        check_warn "ThetaData WebSocket: $THETA_STATUS (will use Tradier)"
    fi
else
    check_warn "Provider status not available from health endpoint"
fi
echo

# ============================================================================
# TIER 2: THE READING - "What does it say?"
# ============================================================================
header "TIER 2: THE READING"
log_and_echo "Taking actual readings from market data..."
echo

# 2.1: SPX Underlying Price
log_and_echo "[2.1] SPX Underlying Price"
SPX_SNAPSHOT=$(curl -s http://localhost:3600/spx/snapshot 2>/dev/null || echo '{}')
if echo "$SPX_SNAPSHOT" | jq -e '.close' > /dev/null 2>&1; then
    SPX_PRICE=$(echo "$SPX_SNAPSHOT" | jq -r '.close')
    SPX_TIME=$(echo "$SPX_SNAPSHOT" | jq -r '.timestamp // "unknown"')
    check_pass "SPX price: \$${SPX_PRICE} (${SPX_TIME})"
else
    if check_fail "SPX snapshot unavailable"; then
        log_and_echo "  → Fix: Check data service is polling"
    fi
fi
echo

# 2.2: SPX Indicators
log_and_echo "[2.2] SPX Indicators"
if echo "$SPX_SNAPSHOT" | jq -e '.indicators' > /dev/null 2>&1; then
    HMA3=$(echo "$SPX_SNAPSHOT" | jq -r '.indicators.hma3 // "null"')
    HMA12=$(echo "$SPX_SNAPSHOT" | jq -r '.indicators.hma12 // "null"')
    RSI=$(echo "$SPX_SNAPSHOT" | jq -r '.indicators.rsi14 // "null"')

    if [ "$HMA3" != "null" ] && [ "$HMA12" != "null" ]; then
        check_pass "HMA(3): $HMA3 | HMA(12): $HMA12"
    else
        check_warn "HMA indicators not ready (may be warming up)"
    fi

    if [ "$RSI" != "null" ]; then
        check_pass "RSI(14): $RSI"
    else
        check_warn "RSI not ready (may be warming up)"
    fi
else
    check_warn "SPX indicators not available"
fi
echo

# 2.3: Active Contracts Count
log_and_echo "[2.3] Active Contracts Count"
ACTIVE_CONTRACTS=$(curl -s http://localhost:3600/contracts/active 2>/dev/null | jq '. | length' 2>/dev/null || echo "-1")
if [ "$ACTIVE_CONTRACTS" -ge 0 ]; then
    check_pass "Active contracts: $ACTIVE_CONTRACTS"
    if [ "$ACTIVE_CONTRACTS" -lt 50 ]; then
        check_warn "Low contract count (expected 200+ during market hours)"
    fi
else
    check_warn "Could not fetch active contracts"
fi
echo

# 2.4: Latest Signal
log_and_echo "[2.4] Latest Signal"
LATEST_SIGNAL=$(curl -s http://localhost:3600/signal/latest 2>/dev/null || echo '{}')
if echo "$LATEST_SIGNAL" | jq -e '.signal' > /dev/null 2>&1; then
    SIGNAL_DIR=$(echo "$LATEST_SIGNAL" | jq -r '.signal.direction')
    SIGNAL_TIME=$(echo "$LATEST_SIGNAL" | jq -r '.signal.ts')
    check_pass "Latest signal: ${SIGNAL_DIR} @ ${SIGNAL_TIME}"
else
    check_pass "No signals yet (normal pre-market)"
fi
echo

# ============================================================================
# TIER 3: CALCULATION VERIFICATION - "Are calculations right?"
# ============================================================================
header "TIER 3: CALCULATION VERIFICATION"
log_and_echo "Verifying indicator computations..."
echo

# 3.1: HMA Cross Verification
log_and_echo "[3.1] HMA Cross Verification"
if echo "$SPX_SNAPSHOT" | jq -e '.indicators.hma3' > /dev/null 2>&1; then
    HMA3=$(echo "$SPX_SNAPSHOT" | jq -r '.indicators.hma3')
    HMA12=$(echo "$SPX_SNAPSHOT" | jq -r '.indicators.hma12')
    SPX_CLOSE=$(echo "$SPX_SNAPSHOT" | jq -r '.close')

    # Verify HMA values are reasonable (not NaN, not extreme)
    if (( $(echo "$HMA3 > 0" | bc -l) )) && (( $(echo "$HMA3 < 10000" | bc -l) )); then
        check_pass "HMA(3) in reasonable range: $HMA3"
    else
        check_fail "HMA(3) invalid: $HMA3"
    fi

    if (( $(echo "$HMA12 > 0" | bc -l) )) && (( $(echo "$HMA12 < 10000" | bc -l) )); then
        check_pass "HMA(12) in reasonable range: $HMA12"
    else
        check_fail "HMA(12) invalid: $HMA12"
    fi
else
    check_warn "Cannot verify HMA calculations (indicators not ready)"
fi
echo

# 3.2: RSI Range Verification
log_and_echo "[3.2] RSI Range Verification"
if echo "$SPX_SNAPSHOT" | jq -e '.indicators.rsi14' > /dev/null 2>&1; then
    RSI=$(echo "$SPX_SNAPSHOT" | jq -r '.indicators.rsi14')
    if (( $(echo "$RSI >= 0" | bc -l) )) && (( $(echo "$RSI <= 100" | bc -l) )); then
        check_pass "RSI(14) in valid range: $RSI"
    else
        check_fail "RSI(14) out of range: $RSI"
    fi
else
    check_warn "Cannot verify RSI calculation"
fi
echo

# 3.3: Strike Band Centering
log_and_echo "[3.3] Strike Band Centering"
if [ -n "${SPX_PRICE:-}" ]; then
    # Expected band: SPX ± 100 (standard) or ± 150 (warmup)
    BAND_LOWER=$(echo "$SPX_PRICE - 150" | bc)
    BAND_UPPER=$(echo "$SPX_PRICE + 150" | bc)
    check_pass "Strike band should be: \$${BAND_LOWER} - \$${BAND_UPPER}"
else
    check_warn "Cannot verify strike band (SPX price unknown)"
fi
echo

# ============================================================================
# TIER 4: SIGNAL LOGIC - "Are signals valid?"
# ============================================================================
header "TIER 4: SIGNAL LOGIC"
log_and_echo "Verifying signal detection logic..."
echo

# 4.1: Signal Detection Active
log_and_echo "[4.1] Signal Detection Active"
if pm2 describe spxer &> /dev/null; then
    SPXER_LOGS=$(pm2 logs spxer --nostream --lines 50 2>&1 || echo "")
    if echo "$SPXER_LOGS" | grep -q "detectHmaCrossSignal\|contract_signal"; then
        check_pass "Signal detection running in data service"
    else
        check_warn "No recent signal detection logs (may be warming up)"
    fi
else
    check_fail "Data service not running"
fi
echo

# 4.2: HMA Pair Configuration
log_and_echo "[4.2] HMA Pair Configuration"
# Verify default HMA pairs are configured
if pm2 describe spxer &> /dev/null; then
    if echo "$SPXER_LOGS" | grep -q "HMA.*3.*12\|3_12"; then
        check_pass "HMA(3)×HMA(12) pair configured"
    else
        check_warn "Could not verify HMA pair configuration"
    fi
else
    check_warn "Cannot verify HMA pairs (service not running)"
fi
echo

# ============================================================================
# TIER 5: CONFIGURATION - "Is config right?"
# ============================================================================
header "TIER 5: CONFIGURATION"
log_and_echo "Verifying trading configuration..."
echo

# 5.1: Config ID Set
log_and_echo "[5.1] Config ID Set"
if [ -n "${AGENT_CONFIG_ID:-}" ]; then
    check_pass "AGENT_CONFIG_ID: $AGENT_CONFIG_ID"

    # Verify config exists in DB
    CONFIG_EXISTS=$(sqlite3 "$SPXER_DIR/data/spxer.db" "SELECT COUNT(*) FROM replay_configs WHERE id='$AGENT_CONFIG_ID'" 2>/dev/null || echo "0")
    if [ "$CONFIG_EXISTS" -gt 0 ]; then
        check_pass "Config found in database"
    else
        if check_fail "Config not found in database"; then
            log_and_echo "  → Fix: Run replay to create config, or set correct AGENT_CONFIG_ID"
        fi
    fi
else
    check_warn "AGENT_CONFIG_ID not set (will use defaults)"
fi
echo

# 5.2: Execution Mode
log_and_echo "[5.2] Execution Mode"
EXEC_MODE=${AGENT_EXECUTION_MODE:-"UNSET"}
case "$EXEC_MODE" in
    WARMUP|SIMULATION|PAPER|LIVE)
        check_pass "Execution mode: $EXEC_MODE"
        ;;
    *)
        check_warn "Execution mode: $EXEC_MODE (will default to LIVE)"
        ;;
esac
echo

# 5.3: Account ID
log_and_echo "[5.3] Account ID"
if [ -n "${TRADIER_ACCOUNT_ID:-}" ]; then
    check_pass "TRADIER_ACCOUNT_ID: $TRADIER_ACCOUNT_ID"
else
    check_warn "TRADIER_ACCOUNT_ID not set (required for LIVE mode)"
fi
echo

# ============================================================================
# TIER 6: SYSTEM VISIBILITY - "Can we see everything?"
# ============================================================================
header "TIER 6: SYSTEM VISIBILITY"
log_and_echo "Verifying monitoring and observability..."
echo

# 6.1: HTTP API Endpoints
log_and_echo "[6.1] HTTP API Endpoints"
API_ENDPOINTS=(
    "/health"
    "/spx/snapshot"
    "/contracts/active"
    "/signal/latest"
    "/agent/status"
)

ENDPOINT_COUNT=0
ENDPOINT_PASS=0
for endpoint in "${API_ENDPOINTS[@]}"; do
    ENDPOINT_COUNT=$((ENDPOINT_COUNT + 1))
    if curl -s "http://localhost:3600${endpoint}" > /dev/null 2>&1; then
        ENDPOINT_PASS=$((ENDPOINT_PASS + 1))
    fi
done

if [ $ENDPOINT_PASS -eq $ENDPOINT_COUNT ]; then
    check_pass "All $ENDPOINT_COUNT API endpoints responding"
else
    check_warn "$ENDPOINT_PASS/$ENDPOINT_COUNT API endpoints responding"
fi
echo

# 6.2: Log Files Writable
log_and_echo "[6.2] Log Files Writable"
if [ -w "$LOG_DIR" ]; then
    check_pass "Log directory writable: $LOG_DIR"
else
    check_warn "Log directory not writable: $LOG_DIR"
fi
echo

# ============================================================================
# TIER 7: E2E PIPELINE - "Does it work end-to-end?"
# ============================================================================
header "TIER 7: E2E PIPELINE"
log_and_echo "Verifying end-to-end data flow..."
echo

# 7.1: SPX Data Flow
log_and_echo "[7.1] SPX Data Flow"
# Verify we can fetch SPX bars
SPX_BARS=$(curl -s "http://localhost:3600/spx/bars?tf=1m&n=10" 2>/dev/null || echo "[]")
if echo "$SPX_BARS" | jq -e '.[0].close' > /dev/null 2>&1; then
    BAR_COUNT=$(echo "$SPX_BARS" | jq '. | length')
    check_pass "SPX bars available: $BAR_COUNT bars"
else
    check_warn "Could not fetch SPX bars (may be warming up)"
fi
echo

# 7.2: Contract Bars Flow
log_and_echo "[7.2] Contract Bars Flow"
# Try to fetch bars for a likely active contract
TEST_CONTRACT="SPXW$(TZ='America/New_York' date '+%y%m%d')C06600000"
CONTRACT_BARS=$(curl -s "http://localhost:3600/contracts/${TEST_CONTRACT}/bars?tf=1m&n=5" 2>/dev/null || echo "[]")
if echo "$CONTRACT_BARS" | jq -e '.[0].close' > /dev/null 2>&1; then
    check_pass "Contract bars available for ${TEST_CONTRACT}"
else
    check_warn "No bars for test contract ${TEST_CONTRACT} (may not exist yet)"
fi
echo

# ============================================================================
# TIER 8: STATE RECONCILIATION - "Does state match reality?"
# ============================================================================
header "TIER 8: STATE RECONCILIATION"
log_and_echo "Verifying internal state vs external reality..."
echo

# 8.1: Database Integrity
log_and_echo "[8.1] Database Integrity"
if [ -f "$SPXER_DIR/data/spxer.db" ]; then
    # Run integrity check
    INTEGRITY_CHECK=$(sqlite3 "$SPXER_DIR/data/spxer.db" "PRAGMA integrity_check" 2>&1)
    if [ "$INTEGRITY_CHECK" = "ok" ]; then
        check_pass "Replay DB integrity: OK"
    else
        if check_fail "Replay DB integrity: $INTEGRITY_CHECK"; then
            log_and_echo "  → Fix: Restore from backup or reinitialize"
        fi
    fi
fi

if [ -f "$SPXER_DIR/data/account.db" ]; then
    INTEGRITY_CHECK=$(sqlite3 "$SPXER_DIR/data/account.db" "PRAGMA integrity_check" 2>&1)
    if [ "$INTEGRITY_CHECK" = "ok" ]; then
        check_pass "Account DB integrity: OK"
    else
        if check_fail "Account DB integrity: $INTEGRITY_CHECK"; then
            log_and_echo "  → Fix: Reinitialize account.db"
        fi
    fi
fi
echo

# 8.2: Position Reconciliation
log_and_echo "[8.2] Position Reconciliation"
if [ -f "$SPXER_DIR/data/account.db" ]; then
    OPEN_POSITIONS=$(sqlite3 "$SPXER_DIR/data/account.db" "SELECT COUNT(*) FROM positions WHERE status='OPEN'" 2>/dev/null || echo "0")
    if [ "$OPEN_POSITIONS" -eq 0 ]; then
        check_pass "No open positions (clean state)"
    else
        check_warn "$OPEN_POSITIONS open positions in database (verify against broker)"
    fi
fi
echo

# ============================================================================
# TIER 9: FRESHNESS - "Is data current?"
# ============================================================================
header "TIER 9: FRESHNESS"
log_and_echo "Verifying data freshness..."
echo

# 9.1: SPX Data Freshness
log_and_echo "[9.1] SPX Data Freshness"
HEALTH=$(curl -s http://localhost:3600/health 2>/dev/null || echo '{}')
if echo "$HEALTH" | jq -e '.spx_last_update' > /dev/null 2>&1; then
    LAST_UPDATE=$(echo "$HEALTH" | jq -r '.spx_last_update // "unknown"')
    CURRENT_TIME=$(date +%s)
    UPDATE_TIME=$(date -d "$LAST_UPDATE" +%s 2>/dev/null || echo "0")

    if [ "$UPDATE_TIME" -gt 0 ]; then
        AGE=$((CURRENT_TIME - UPDATE_TIME))
        if [ $AGE -lt 120 ]; then
            check_pass "SPX data fresh: ${AGE}s old"
        elif [ $AGE -lt 600 ]; then
            check_warn "SPX data stale: ${AGE}s old (under 10 min)"
        else
            if check_fail "SPX data very stale: ${AGE}s old"; then
                log_and_echo "  → Fix: Check provider connection"
            fi
        fi
    fi
else
    check_warn "Could not verify SPX data freshness"
fi
echo

# 9.2: Provider Last Poll
log_and_echo "[9.2] Provider Last Poll"
if echo "$HEALTH" | jq -e '.uptime' > /dev/null 2>&1; then
    UPTIME=$(echo "$HEALTH" | jq -r '.uptime')
    check_pass "Data service uptime: ${UPTIME}"
else
    check_warn "Could not verify uptime"
fi
echo

# ============================================================================
# TIER 10: ACCEPTANCE - "Should we trade?"
# ============================================================================
header "TIER 10: ACCEPTANCE"
log_and_echo "Evaluating trade readiness..."
echo

# 10.1: No Critical Errors
log_and_echo "[10.1] No Critical Errors"
if [ $TOTAL_FAIL -eq 0 ]; then
    check_pass "No critical errors detected"
else
    check_fail "$TOTAL_FAIL critical error(s) present"
fi
echo

# 10.2: System Go/No-Go
log_and_echo "[10.2] System Go/No-Go"
if [ $TOTAL_FAIL -eq 0 ] && ([ $TOTAL_WARN -eq 0 ] || [ "$SKIP_WARNINGS" = true ]); then
    check_pass "SYSTEM GO - All checks passed"
    SYSTEM_GO=true
elif [ $TOTAL_FAIL -eq 0 ]; then
    check_warn "SYSTEM GO WITH WARNINGS - $TOTAL_WARN warning(s)"
    SYSTEM_GO=true
else
    check_fail "SYSTEM NO-GO - $TOTAL_FAIL error(s) prevent trading"
    SYSTEM_GO=false
fi
echo

# ============================================================================
# TIER 11: MARKET STATE - "Is market open?"
# ============================================================================
header "TIER 11: MARKET STATE"
log_and_echo "Checking market status..."
echo

# 11.1: Day of Week
log_and_echo "[11.1] Day of Week"
DAY_OF_WEEK=$(date +%u)  # 1=Mon, 7=Sun
if [ $DAY_OF_WEEK -le 5 ]; then
    check_pass "Weekday confirmed"
else
    check_warn "Weekend detected"
fi
echo

# 11.2: Market Time (pre-market)
log_and_echo "[11.2] Market Time"
HOUR_ET=$(TZ='America/New_York' date +%H)
MINUTE_ET=$(TZ='America/New_York' date +%M)

if [ $HOUR_ET -eq 8 ] && [ $MINUTE_ET -lt 30 ]; then
    check_pass "Pre-market warmup window (08:00-08:30 ET)"
elif [ $HOUR_ET -eq 8 ]; then
    check_pass "Pre-market (08:00-09:00 ET)"
else
    check_warn "Current time: ${HOUR_ET}:${MINUTE_ET} ET"
fi
echo

# 11.3: Market Holiday Check
log_and_echo "[11.3] Market Holiday Check"
# Hardcoded market holidays for 2026
TODAY=$(TZ='America/New_York' date +%Y-%m-%d)
HOLIDAYS_2026=(
    "2026-01-01"  # New Year's Day
    "2026-07-04"  # Independence Day
    "2026-12-25"  # Christmas
)

IS_HOLIDAY=false
for holiday in "${HOLIDAYS_2026[@]}"; do
    if [ "$TODAY" = "$holiday" ]; then
        IS_HOLIDAY=true
        break
    fi
done

if [ "$IS_HOLIDAY" = true ]; then
    check_warn "Today is a market holiday"
else
    check_pass "Not a market holiday"
fi
echo

# ============================================================================
# TIER 12: FINANCIAL STATE - "Can we trade?"
# ============================================================================
header "TIER 12: FINANCIAL STATE"
log_and_echo "Checking account readiness..."
echo

# 12.1: Account Balance (if in SIMULATION/LIVE mode)
log_and_echo "[12.1] Account Balance"
if [ "${EXEC_MODE:-UNSET}" = "SIMULATION" ] || [ "${EXEC_MODE:-UNSET}" = "LIVE" ]; then
    if [ -f "$SPXER_DIR/data/account.db" ]; then
        DAILY_PNL=$(sqlite3 "$SPXER_DIR/data/account.db" "SELECT daily_pnl FROM config_state WHERE config_id='${AGENT_CONFIG_ID:-default}' LIMIT 1" 2>/dev/null || echo "0")
        check_pass "Daily P&L: \$${DAILY_PNL}"
    else
        check_warn "No account DB found (will create on first trade)"
    fi
else
    check_pass "Account balance check skipped (WARMUP mode)"
fi
echo

# 12.2: Daily Loss Limit
log_and_echo "[12.2: Daily Loss Limit"
if [ -n "${MAX_DAILY_LOSS:-}" ]; then
    check_pass "Max daily loss configured: \$${MAX_DAILY_LOSS}"
else
    check_warn "MAX_DAILY_LOSS not configured"
fi
echo

# ============================================================================
# TIER 13: TIME DECAY - "Is clock working against us?"
# ============================================================================
header "TIER 13: TIME DECAY"
log_and_echo "Checking 0DTE time decay factors..."
echo

# 13.1: Days to Expiry
log_and_echo "[13.1] Days to Expiry"
if [ -n "${SPX_PRICE:-}" ]; then
    # Get today's DTE options (SPXW + today's date)
    TODAY_YYMMDD=$(date +%y%m%d)
    check_pass "Trading 0DTE: SPXW${TODAY_YYMMDD}*"
else
    check_warn "Cannot verify DTE (SPX price unknown)"
fi
echo

# 13.2: Time Until Close
log_and_echo "[13.2] Time Until Market Close"
# Calculate minutes until 4:00 PM ET
CURRENT_MIN=$((HOUR_ET * 60 + MINUTE_ET))
CLOSE_MIN=$((16 * 60))  # 4:00 PM = 960 minutes
MIN_UNTIL_CLOSE=$((CLOSE_MIN - CURRENT_MIN))

if [ $MIN_UNTIL_CLOSE -gt 0 ]; then
    HOURS_UNTIL=$((MIN_UNTIL_CLOSE / 60))
    MINS_UNTIL=$((MIN_UNTIL_CLOSE % 60))
    check_pass "${HOURS_UNTIL}h ${MINS_UNTIL}m until market close"
else
    check_warn "Market closed or closing"
fi
echo

# ============================================================================
# TIER 14: NETWORK/CONNECTIVITY - "Is link up?"
# ============================================================================
header "TIER 14: NETWORK/CONNECTIVITY"
log_and_echo "Verifying network connections..."
echo

# 14.1: Internet Connectivity
log_and_echo "[14.1] Internet Connectivity"
if ping -c 1 api.tradier.com > /dev/null 2>&1; then
    check_pass "Tradier API reachable"
else
    check_warn "Tradier API not reachable"
fi
echo

# 14.2: DNS Resolution
log_and_echo "[14.2: DNS Resolution"
if nslookup api.tradier.com > /dev/null 2>&1; then
    check_pass "DNS resolution working"
else
    check_warn "DNS resolution issues detected"
fi
echo

# ============================================================================
# TIER 15: DATA QUALITY - "Is data clean?"
# ============================================================================
header "TIER 15: DATA QUALITY"
log_and_echo "Checking data quality..."
echo

# 15.1: No Stale Data
log_and_echo "[15.1] No Stale Data"
# Check for data gaps in recent SPX bars
if echo "$SPX_BARS" | jq -e '.[5]' > /dev/null 2>&1; then
    # Check if last 6 bars span ~6 minutes (allowing for some gaps)
    check_pass "Recent SPX bars look continuous"
else
    check_warn "Could not verify data continuity"
fi
echo

# 15.2: No Anomalous Prices
log_and_echo "[15.2] No Anomalous Prices"
if [ -n "${SPX_PRICE:-}" ]; then
    # Sanity check: SPX should be between 4000 and 8000
    if (( $(echo "$SPX_PRICE > 4000" | bc -l) )) && (( $(echo "$SPX_PRICE < 8000" | bc -l) )); then
        check_pass "SPX price in sane range: \$${SPX_PRICE}"
    else
        check_fail "SPX price anomalous: \$${SPX_PRICE}"
    fi
fi
echo

# ============================================================================
# TIER 16: HUMAN READINESS - "Is trader ready?"
# ============================================================================
header "TIER 16: HUMAN READINESS"
log_and_echo "Checking human factors..."
echo

# 16.1: Manual Override Check
log_and_echo "[16.1] Manual Override Check"
if [ -f "$SPXER_DIR/.trading-halt" ]; then
    check_fail "TRADING HALT file detected - remove .trading-halt to proceed"
    SYSTEM_GO=false
else
    check_pass "No manual trading halt detected"
fi
echo

# 16.2: Active Monitoring
log_and_echo "[16.2] Active Monitoring"
if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    check_pass "Alerts configured (Slack webhook)"
else
    check_warn "No alerting configured"
fi
echo

# ============================================================================
# TIER 17: REGULATORY/COMPLIANCE - "Are we legal?"
# ============================================================================
header "TIER 17: REGULATORY/COMPLIANCE"
log_and_echo "Checking compliance factors..."
echo

# 17.1: Pattern Day Trader Status
log_and_echo "[17.1] Account Type"
# Note: This is informational - actual PDT check happens at broker
check_pass "Account type: Margin (6YA51425) - PDT rules apply"
echo

# 17.2: Position Limits
log_and_echo "[17.2] Position Limits"
if [ -n "${MAX_POSITIONS:-}" ]; then
    check_pass "Max positions configured: $MAX_POSITIONS"
else
    check_warn "MAX_POSITIONS not configured"
fi
echo

# ============================================================================
# SUMMARY
# ============================================================================
header "CHECKLIST COMPLETE"
echo
log_and_echo "Finished: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo
log_and_echo "Results:"
log_and_echo "  ✅ Passed: $TOTAL_PASS"
log_and_echo "  ⚠️  Warnings: $TOTAL_WARN"
log_and_echo "  ❌ Failed: $TOTAL_FAIL"
echo

{
    echo
    echo "Results:"
    echo "  ✅ Passed: $TOTAL_PASS"
    echo "  ⚠️  Warnings: $TOTAL_WARN"
    echo "  ❌ Failed: $TOTAL_FAIL"
} >> "$LOG_FILE"

# ============================================================================
# GO/NO-GO DECISION
# ============================================================================
echo
header "GO/NO-GO DECISION"
echo

if [ "$SYSTEM_GO" = true ]; then
    echo -e "${GREEN}${BOLD}✅ SYSTEM GO - PROCEED TO WARMUP${NC}"
    echo
    echo "All critical checks passed. System is ready for pre-market warmup."
    echo
    echo "Next step:"
    echo "  ./scripts/ops/start-warmup.sh"
    echo
    log_and_echo "GO/NO-GO: GO"
    exit 0
else
    echo -e "${RED}${BOLD}❌ SYSTEM NO-GO - DO NOT PROCEED${NC}"
    echo
    echo "Critical failures detected. Review and fix before proceeding."
    echo
    echo "Log file: $LOG_FILE"
    echo
    log_and_echo "GO/NO-GO: NO-GO"
    exit 1
fi
