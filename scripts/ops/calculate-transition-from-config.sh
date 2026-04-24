#!/bin/bash
# Calculate warmup transition time from config
# Reads AGENT_CONFIG_ID from DB, determines optimal transition time based on:
#   1. Config's activeStart time
#   2. HMA(slow) warmup time (based on timeframe)
#   3. Uses the LATER of the two

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

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   Warmup Transition Calculator        ║"
echo "║   From Config → Optimal Timing        ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo

# ============================================================================
# Get Config ID
# ============================================================================
CONFIG_ID=${AGENT_CONFIG_ID:-""}

if [ -z "$CONFIG_ID" ]; then
    fail "AGENT_CONFIG_ID not set"
    echo
    echo "Set it with:"
    echo "  export AGENT_CONFIG_ID=your-config-id"
    echo "  ./scripts/ops/calculate-transition-from-config.sh"
    echo
    exit 1
fi

header "Reading Config: $CONFIG_ID"
echo

# ============================================================================
# Read Config from DB
# ============================================================================
DB_PATH="$SPXER_DIR/data/spxer.db"

if [ ! -f "$DB_PATH" ]; then
    fail "Database not found: $DB_PATH"
    exit 1
fi

# Read config JSON
CONFIG_JSON=$(sqlite3 "$DB_PATH" "SELECT config FROM replay_configs WHERE id='$CONFIG_ID'" 2>/dev/null || echo "{}")

if [ "$CONFIG_JSON" = "{}" ]; then
    fail "Config not found in database: $CONFIG_ID"
    exit 1
fi

pass "Config loaded from database"

# ============================================================================
# Parse Config Fields
# ============================================================================

# Use jq to extract values (handle missing fields with // null)
ACTIVE_START=$(echo "$CONFIG_JSON" | jq -r '.timeWindows.activeStart // "10:00"')
SESSION_START=$(echo "$CONFIG_JSON" | jq -r '.timeWindows.sessionStart // "09:30"')
HMA_CROSS_FAST=$(echo "$CONFIG_JSON" | jq -r '.signals.hmaCrosses[0].fast // "3"' | head -1)
HMA_CROSS_SLOW=$(echo "$CONFIG_JSON" | jq -r '.signals.hmaCrosses[0].slow // "12"' | head -1)
SIGNAL_TF=$(echo "$CONFIG_JSON" | jq -r '.signals.timeframe // "3m"')
MIN_WARMUP_BARS=$(echo "$CONFIG_JSON" | jq -r '.signals.minWarmupBars // "0"')

echo "Config Settings:"
echo "  Session Start: $SESSION_START"
echo "  Active Start: $ACTIVE_START"
echo "  Signal Timeframe: $SIGNAL_TF"
echo "  HMA Cross: $HMA_CROSS_FAST × $HMA_CROSS_SLOW"
echo "  Min Warmup Bars: $MIN_WARMUP_BARS"
echo

# ============================================================================
# Calculate HMA Warmup Time
# ============================================================================

header "HMA Warmup Calculation"
echo

# Parse timeframe (e.g., "3m" -> 3 minutes)
TF_MINUTES=$(echo "$SIGNAL_TF" | sed 's/[^0-9]//g')
if [ -z "$TF_MINUTES" ]; then
    TF_MINUTES=3  # default to 3m
fi

# Calculate minutes needed for HMA(slow) to warm up
if [ "$MIN_WARMUP_BARS" -gt 0 ]; then
    WARMUP_BARS=$MIN_WARMUP_BARS
else
    WARMUP_BARS=$HMA_CROSS_SLOW
fi

HMA_WARMUP_MINUTES=$((WARMUP_BARS * TF_MINUTES))

echo "Timeframe: ${TF_MINUTES}m"
echo "HMA Warmup Bars: $WARMUP_BARS (HMA slow period or minWarmupBars)"
echo "HMA Warmup Minutes: $HMA_WARMUP_MINUTES"
echo

# Calculate when HMA warmup completes
SESSION_HOUR=$(echo "$SESSION_START" | cut -d: -f1)
SESSION_MIN=$(echo "$SESSION_START" | cut -d: -f2)
SESSION_MINUTES=$((SESSION_HOUR * 60 + SESSION_MIN))

HMA_VALID_MIN=$((SESSION_MINUTES + HMA_WARMUP_MINUTES))
HMA_VALID_HOUR=$((HMA_VALID_MIN / 60))
HMA_VALID_MINUTE=$((HMA_VALID_MIN % 60))

echo "Market Session Start: $SESSION_START"
echo "HMA($HMA_CROSS_SLOW) Valid At: $(printf '%02d:%02d' $HMA_VALID_HOUR $HMA_VALID_MINUTE) AM ET"
echo

# ============================================================================
# Calculate Active Start Time
# ============================================================================

header "Active Start Window"
echo

ACTIVE_HOUR=$(echo "$ACTIVE_START" | cut -d: -f1)
ACTIVE_MIN=$(echo "$ACTIVE_START" | cut -d: -f2)
ACTIVE_MINUTES=$((ACTIVE_HOUR * 60 + ACTIVE_MIN))

echo "Config Active Start: $ACTIVE_START"
echo "Active Start (minutes from midnight): $ACTIVE_MINUTES"
echo

# ============================================================================
# Determine Transition Time
# ============================================================================

header "Transition Time Decision"
echo

# Transition time is the LATER of:
# 1. HMA valid time + buffer
# 2. Config active start time
BUFFER_MINUTES=15

HMA_TRANSITION_MIN=$((HMA_VALID_MIN + BUFFER_MINUTES))
HMA_TRANSITION_HOUR=$((HMA_TRANSITION_MIN / 60))
HMA_TRANSITION_MINUTE=$((HMA_TRANSITION_MIN % 60))

if [ $ACTIVE_MINUTES -gt $HMA_TRANSITION_MIN ]; then
    # Active start is later
    TRANSITION_MIN=$ACTIVE_MINUTES
    TRANSITION_HOUR=$ACTIVE_HOUR
    TRANSITION_MINUTE=$ACTIVE_MIN
    REASON="Config's activeStart is later than HMA warmup"
else
    # HMA warmup is later
    TRANSITION_MIN=$HMA_TRANSITION_MIN
    TRANSITION_HOUR=$HMA_TRANSITION_HOUR
    TRANSITION_MINUTE=$HMA_TRANSITION_MINUTE
    REASON="HMA warmup + buffer completes after activeStart"
fi

echo "HMA Warmup + Buffer: $(printf '%02d:%02d' $HMA_TRANSITION_HOUR $HMA_TRANSITION_MINUTE) AM ET"
echo "Config Active Start: $ACTIVE_START"
echo
echo -e "${GREEN}${BOLD}Transition Time: $(printf '%02d:%02d' $TRANSITION_HOUR $TRANSITION_MINUTE) AM ET${NC}"
echo "Reason: $REASON"
echo

# ============================================================================
# Generate Cron Entry
# ============================================================================

header "Cron Entry"
echo

echo "# Transition to SIMULATION/LIVE at $(printf '%02d:%02d' $TRANSITION_HOUR $TRANSITION_MINUTE) AM ET"
echo "# Config: $CONFIG_ID"
echo "# Timeframe: $SIGNAL_TF, HMA: ${HMA_CROSS_FAST}×${HMA_CROSS_SLOW}"
echo "0 $(printf '%02d' $TRANSITION_HOUR) * * 1-5 export WARMUP_TARGET_MODE=SIMULATION && cd $SPXER_DIR && ./scripts/ops/transition-from-warmup.sh >> logs/cron-$(printf '%02d%02d' $TRANSITION_HOUR $TRANSITION_MINUTE)-\$(date +\\%Y\\%m\\%d).log 2>&1"
echo

# ============================================================================
# Summary
# ============================================================================
header "Summary"
echo

cat << EOF
Config: $CONFIG_ID
Timeframe: $SIGNAL_TF
HMA Cross: $HMA_CROSS_FAST × $HMA_CROSS_SLOW
Min Warmup Bars: $MIN_WARMUP_BARS

Timeline:
  Warmup Starts: 08:00 AM ET
  Market Opens: $SESSION_START
  HMA($HMA_CROSS_SLOW) Valid: $(printf '%02d:%02d' $HMA_VALID_HOUR $HMA_VALID_MINUTE) AM ET
  Config Active Start: $ACTIVE_START
  ────────────────────────────────────────────
  Transition Time: $(printf '%02d:%02d' $TRANSITION_HOUR $TRANSITION_MINUTE) AM ET
  Reason: $REASON

Next Steps:
  1. Review the transition time above
  2. Install cron: ./scripts/ops/setup-8am-automation.sh
  3. Edit crontab: crontab -e
  4. Update transition cron to use: 0 $(printf '%02d' $TRANSITION_HOUR) * * 1-5 ...

EOF

exit 0
