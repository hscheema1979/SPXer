#!/bin/bash
# Transition from WARMUP to LIVE/SIMULATION mode
# Reads config to validate timing and transition appropriately
# Runs at config-specific transition time (calculated from HMA period × timeframe)

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
info() { echo -e "${BLUE}ℹ️${NC} $1"; }
header() { echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPXER_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$SPXER_DIR"

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   WARMUP → TRADING MODE TRANSITION     ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo
echo "Time: $(TZ='America/New_York' date '+%Y-%m-%d %H:%M:%S %Z')"
echo

# ============================================================================
# Read Config to Determine Expected Transition Time
# ============================================================================

CONFIG_ID=${AGENT_CONFIG_ID:-""}

if [ -n "$CONFIG_ID" ]; then
    header "Reading Config: $CONFIG_ID"
    echo

    DB_PATH="$SPXER_DIR/data/spxer.db"

    if [ -f "$DB_PATH" ]; then
        CONFIG_JSON=$(sqlite3 "$DB_PATH" "SELECT config FROM replay_configs WHERE id='$CONFIG_ID'" 2>/dev/null || echo "{}")

        if [ "$CONFIG_JSON" != "{}" ]; then
            # Parse config values
            ACTIVE_START=$(echo "$CONFIG_JSON" | jq -r '.timeWindows.activeStart // null')
            SESSION_START=$(echo "$CONFIG_JSON" | jq -r '.timeWindows.sessionStart // "09:30"')
            HMA_SLOW=$(echo "$CONFIG_JSON" | jq -r '.signals.hmaCrosses[0].slow // "12"' | head -1)
            SIGNAL_TF=$(echo "$CONFIG_JSON" | jq -r '.signals.timeframe // "3m"')
            MIN_WARMUP_BARS=$(echo "$CONFIG_JSON" | jq -r '.signals.minWarmupBars // "0"')

            info "Config found:"
            echo "  Session Start: $SESSION_START"
            echo "  Active Start: ${ACTIVE_START:-'not set'}"
            echo "  Signal Timeframe: $SIGNAL_TF"
            echo "  HMA Slow Period: $HMA_SLOW"
            echo "  Min Warmup Bars: $MIN_WARMUP_BARS"
            echo

            # Calculate expected transition time
            TF_MINUTES=$(echo "$SIGNAL_TF" | sed 's/[^0-9]//g')
            TF_MINUTES=${TF_MINUTES:-3}

            WARMUP_BARS=${MIN_WARMUP_BARS:-$HMA_SLOW}
            HMA_WARMUP_MINUTES=$((WARMUP_BARS * TF_MINUTES))

            SESSION_HOUR=$(echo "$SESSION_START" | cut -d: -f1)
            SESSION_MIN=$(echo "$SESSION_START" | cut -d: -f2)
            SESSION_MINUTES=$((SESSION_HOUR * 60 + SESSION_MIN))

            HMA_VALID_MIN=$((SESSION_MINUTES + HMA_WARMUP_MINUTES))
            BUFFER_MINUTES=15
            HMA_TRANSITION_MIN=$((HMA_VALID_MIN + BUFFER_MINUTES))

            # Use activeStart if later, otherwise use HMA transition time
            if [ -n "$ACTIVE_START" ]; then
                ACTIVE_HOUR=$(echo "$ACTIVE_START" | cut -d: -f1)
                ACTIVE_MIN=$(echo "$ACTIVE_START" | cut -d: -f2)
                ACTIVE_MINUTES=$((ACTIVE_HOUR * 60 + ACTIVE_MIN))

                if [ $ACTIVE_MINUTES -gt $HMA_TRANSITION_MIN ]; then
                    EXPECTED_MIN=$ACTIVE_MINUTES
                    EXPECTED_HOUR=$ACTIVE_HOUR
                    EXPECTED_MINUTE=$ACTIVE_MIN
                    REASON="Config's activeStart"
                else
                    EXPECTED_MIN=$HMA_TRANSITION_MIN
                    EXPECTED_HOUR=$((HMA_TRANSITION_MIN / 60))
                    EXPECTED_MINUTE=$((HMA_TRANSITION_MIN % 60))
                    REASON="HMA warmup + buffer"
                fi
            else
                EXPECTED_MIN=$HMA_TRANSITION_MIN
                EXPECTED_HOUR=$((HMA_TRANSITION_MIN / 60))
                EXPECTED_MINUTE=$((HMA_TRANSITION_MIN % 60))
                REASON="HMA warmup + buffer"
            fi

            echo "Expected transition: $(printf '%02d:%02d' $EXPECTED_HOUR $EXPECTED_MINUTE) AM ET (based on $REASON)"
            echo
        else
            warn "Config not found in database: $CONFIG_ID"
            EXPECTED_MIN=""
        fi
    else
        warn "Database not found: $DB_PATH"
        EXPECTED_MIN=""
    fi
else
    warn "AGENT_CONFIG_ID not set - cannot validate expected transition time"
    EXPECTED_MIN=""
fi

echo

# ============================================================================
# Validate Current Time (if config read successfully)
# ============================================================================

if [ -n "$EXPECTED_MIN" ]; then
    header "Validating Transition Time"
    echo

    HOUR=$(date '+%H')
    MINUTE=$(date '+%M')
    TIME_MIN=$((HOUR * 60 + MINUTE))

    # Allow 5-minute window before/after expected time
    if [ $TIME_MIN -lt $((EXPECTED_MIN - 5)) ] || [ $TIME_MIN -gt $((EXPECTED_MIN + 5)) ]; then
        warn "Current time: $(date '+%H:%M') ET"
        echo "Expected time: $(printf '%02d:%02d' $EXPECTED_HOUR $EXPECTED_MINUTE) ET (based on your config)"
        echo
        echo "Why the difference?"
        echo "  • Your config: HMA(${HMA_SLOW}) on ${SIGNAL_TF} timeframe"
        echo "  • HMA warmup: ${WARMUP_BARS} bars × ${TF_MINUTES}min = ${HMA_WARMUP_MINUTES} minutes"
        echo "  • Market opens: $SESSION_START"
        echo "  • HMA valid at: $(date -d "$SESSION_START today + ${HMA_WARMUP_MINUTES} minutes" '+%H:%M' 2>/dev/null || echo 'calculation error')"
        echo "  • With buffer: $(printf '%02d:%02d' $EXPECTED_HOUR $EXPECTED_MINUTE)"
        echo

        # If activeStart was the deciding factor, explain
        if [ "$REASON" = "Config's activeStart" ]; then
            echo "Note: Transition time determined by config's activeStart ($ACTIVE_START)"
            echo "      This is later than HMA warmup would allow"
            echo
        fi

        read -p "Continue anyway? (y/N): " CONTINUE
        if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
            echo "Aborted"
            exit 0
        fi
    else
        pass "Transition time validated: $(date '+%H:%M') ET (within expected window)"
    fi
    echo
fi

# ============================================================================
# Determine Target Mode
# ============================================================================

header "Target Execution Mode"
echo

TARGET_MODE=${WARMUP_TARGET_MODE:-"SIMULATION"}
echo "Target execution mode: $TARGET_MODE"
echo

# Confirmation if LIVE mode
if [ "$TARGET_MODE" = "LIVE" ]; then
    echo -e "${BOLD}${RED}⚠️  WARNING: Transitioning to LIVE MODE${NC}"
    echo
    echo "This will enable real trading with actual money."
    echo
    echo "Pre-flight checklist:"
    echo "  [ ] Warmup signals looked healthy"
    echo "  [ ] No errors in warmup logs"
    echo "  [ ] Strike band correctly centered"
    echo "  [ ] Two-person confirmation obtained"
    echo
    read -p "Type 'CONFIRM' to proceed with LIVE mode: " CONFIRMATION
    if [ "$CONFIRMATION" != "CONFIRM" ]; then
        fail "LIVE mode transition aborted"
        exit 1
    fi
    echo
fi

# ============================================================================
# Warmup Summary
# ============================================================================

header "Warmup Summary"
echo

# Count warmup signals from logs
WARMUP_SIGNALS=$(pm2 logs event-handler --nostream --lines 1000 2>&1 | grep -c "WARMUP:" || echo "0")
echo "Signals tracked during warmup: $WARMUP_SIGNALS"

# Check for errors
ERROR_COUNT=$(pm2 logs event-handler --nostream --lines 1000 2>&1 | grep -c "ERROR\|FAIL" || echo "0")
if [ $ERROR_COUNT -eq 0 ]; then
    pass "No errors in warmup logs"
else
    warn "Found $ERROR_COUNT error(s) in warmup logs"
    pm2 logs event-handler --nostream --lines 50 | grep "ERROR\|FAIL" | tail -5
    echo
    read -p "Continue despite errors? (y/N): " CONTINUE
    if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
        echo "Aborted"
        exit 1
    fi
fi

echo

# ============================================================================
# Stop Handler
# ============================================================================

header "Step 1: Stop Handler (WARMUP mode)"
echo

pm2 stop event-handler || {
    fail "Failed to stop handler"
    exit 1
}

pass "Handler stopped"

sleep 3

# Verify handler stopped
HANDLER_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="event-handler") | .pm2_env.status' 2>/dev/null || echo "unknown")
if [ "$HANDLER_STATUS" = "stopped" ]; then
    pass "Handler confirmed stopped"
else
    warn "Handler status: $HANDLER_STATUS (may still be stopping)"
fi

echo

# ============================================================================
# Update Execution Mode
# ============================================================================

header "Step 2: Update Execution Mode"
echo

export AGENT_EXECUTION_MODE=$TARGET_MODE
echo "AGENT_EXECUTION_MODE=$TARGET_MODE"

# Persist in PM2 ecosystem
pm2 ecosystem generate > ecosystem.config.js.tmp 2>/dev/null || true
if [ -f ecosystem.config.js.tmp ]; then
    sed -i "s/AGENT_EXECUTION_MODE: '.*'/AGENT_EXECUTION_MODE: '$TARGET_MODE'/" ecosystem.config.js.tmp
    mv ecosystem.config.js.tmp ecosystem.config.js
    pass "Updated ecosystem.config.js"
fi

echo

# ============================================================================
# Start Handler
# ============================================================================

header "Step 3: Start Handler ($TARGET_MODE mode)"
echo

pm2 start event-handler --update-env || {
    fail "Failed to start handler"
    exit 1
}

pass "Handler started"

sleep 5

# ============================================================================
# Verify Transition
# ============================================================================

header "Step 4: Verify Transition"
echo

LOGS=$(pm2 logs event-handler --nostream --lines 20 2>&1 || true)

if echo "$LOGS" | grep -q "$TARGET_MODE MODE"; then
    pass "Execution mode confirmed: $TARGET_MODE"
else
    warn "Mode not confirmed in logs - check manually"
    echo "Recent logs:"
    pm2 logs event-handler --nostream --lines 10
fi

if echo "$LOGS" | grep -q "WebSocket connected"; then
    pass "WebSocket connected"
else
    info "WebSocket connection may be pending"
fi

# Check if mode switch worked via HTTP API
if curl -s http://localhost:3600/agent/mode > /dev/null 2>&1; then
    sleep 3
    MODE_CHECK=$(curl -s http://localhost:3600/agent/mode | jq -r '.mode' 2>/dev/null || echo "unknown")
    if [ "$MODE_CHECK" = "$TARGET_MODE" ]; then
        pass "HTTP API confirms mode: $TARGET_MODE"
    else
        warn "HTTP API mode: $MODE_CHECK (expected: $TARGET_MODE)"
    fi
fi

echo
header "Transition Complete"
echo

echo -e "${GREEN}🚀 Handler now running in $TARGET_MODE mode${NC}"
echo
echo "What happens now:"
if [ "$TARGET_MODE" = "SIMULATION" ]; then
    echo "  ✅ Live signals from data service"
    echo "  ✅ FakeBroker simulates orders locally"
    echo "  ✅ TP/SL fills based on real price feeds"
    echo "  ❌ No real orders to Tradier"
elif [ "$TARGET_MODE" = "LIVE" ]; then
    echo "  ✅ Live signals from data service"
    echo "  ✅ Real orders to Tradier production"
    echo "  ✅ Real money at risk"
    echo -e "${RED}  ⚠️  Monitor positions closely${NC}"
fi
echo
echo "Monitor trading activity:"
echo "  pm2 logs event-handler"
echo "  curl -s http://localhost:3600/agent/simulation | jq ."
echo
echo -e "${BOLD}${GREEN}📈 Market is OPEN - Good luck!${NC}"

exit 0
