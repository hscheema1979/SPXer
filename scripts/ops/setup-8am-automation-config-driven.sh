#!/bin/bash
# Setup script for Staged Pre-Market Automation (CONFIG-DRIVEN)
# Reads AGENT_CONFIG_ID to calculate optimal transition time
# All timing derived from config, not hard-coded
#
# Timeline:
#   06:00 AM ET - Early Infrastructure (Tiers 1-5)
#   07:00 AM ET - Data Pipeline (Tiers 6-10)
#   07:50 AM ET - Pre-Market Validation (Tiers 11-17)
#   08:00 AM ET - Warmup starts
#   CALCULATED - Transition time (from config HMA + timeframe)
#
# Usage: ./scripts/ops/setup-8am-automation-config-driven.sh [--target-mode MODE] [--manual]

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

# Parse arguments
TARGET_MODE="SIMULATION"
MANUAL_MODE=false
for arg in "$@"; do
    case $arg in
        --target-mode)
            TARGET_MODE="$2"
            shift 2
            ;;
        --manual)
            MANUAL_MODE=true
            shift
            ;;
    esac
done

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   SPXer Config-Driven Automation       ║"
echo "║   All Timing From Config              ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo
echo "Target mode: $TARGET_MODE"
echo "Manual mode: $MANUAL_MODE"
echo

# ============================================================================
# CHECK CONFIG ID
# ============================================================================
header "Checking Configuration"
echo

if [ -z "${AGENT_CONFIG_ID:-}" ]; then
    warn "AGENT_CONFIG_ID not set"
    echo
    echo "Timing will be calculated from defaults."
    echo "For accurate timing, set your config ID:"
    echo "  export AGENT_CONFIG_ID=your-config-id"
    echo "  ./scripts/ops/setup-8am-automation-config-driven.sh"
    echo
else
    pass "Config ID: $AGENT_CONFIG_ID"

    # Verify config exists
    DB_PATH="$SPXER_DIR/data/spxer.db"
    if [ -f "$DB_PATH" ]; then
        CONFIG_EXISTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM replay_configs WHERE id='$AGENT_CONFIG_ID'" 2>/dev/null || echo "0")
        if [ "$CONFIG_EXISTS" -gt 0 ]; then
            pass "Config found in database"
        else
            warn "Config not found in database: $AGENT_CONFIG_ID"
        fi
    fi
fi

echo

# ============================================================================
# CALCULATE TRANSITION TIME (FROM CONFIG IF AVAILABLE)
# ============================================================================
header "Transition Time Calculation"
echo

if [ -n "${AGENT_CONFIG_ID:-}" ]; then
    info "Running config-based calculator..."
    echo

    if $SCRIPT_DIR/calculate-transition-from-config.sh 2>&1 | tee /tmp/calc-output.txt; then
        # Extract the calculated cron time
        TRANSITION_HOUR=$(grep "Transition Time:" /tmp/calc-output.txt | grep -o "[0-9][0-9]:[0-9][0-9]" | cut -d: -f1)
        TRANSITION_MINUTE=$(grep "Transition Time:" /tmp/calc-output.txt | grep -o "[0-9][0-9]:[0-9][0-9]" | cut -d: -f2)

        if [ -n "$TRANSITION_HOUR" ] && [ -n "$TRANSITION_MINUTE" ]; then
            pass "Calculated transition: ${TRANSITION_HOUR}:${TRANSITION_MINUTE} AM ET"
            USE_CONFIG_TIME=true
        else
            warn "Could not parse calculated time, using default"
            USE_CONFIG_TIME=false
        fi
    else
        warn "Calculator failed, using default time"
        USE_CONFIG_TIME=false
    fi
else
    warn "No config ID - using default 10:15 AM ET"
    USE_CONFIG_TIME=false
fi

echo

# ============================================================================
# VERIFY PREREQUISITES
# ============================================================================
header "Step 1: Verifying Prerequisites"
echo

# Check crontab
if ! command -v crontab &> /dev/null; then
    fail "crontab not found"
    exit 1
fi
pass "crontab available"

# Check scripts
SCRIPTS=(
    "$SCRIPT_DIR/check-early-infrastructure.sh"
    "$SCRIPT_DIR/check-data-pipeline.sh"
    "$SCRIPT_DIR/check-pre-market-validation.sh"
    "$SCRIPT_DIR/start-warmup-with-checklist.sh"
    "$SCRIPT_DIR/transition-from-warmup.sh"
)

for script in "${SCRIPTS[@]}"; do
    if [ ! -f "$script" ]; then
        fail "Script not found: $script"
        exit 1
    fi
    chmod +x "$script"
done
pass "All scripts found and executable"

# Create logs directory
LOG_DIR="$SPXER_DIR/logs"
mkdir -p "$LOG_DIR"
pass "Logs directory: $LOG_DIR"

echo

# ============================================================================
# CREATE CRON ENTRIES
# ============================================================================
header "Step 2: Creating Cron Entries"
echo

# Backup existing crontab
CRON_BACKUP="$HOME/spxer-crontab-backup-$(date +%Y%m%d-%H%M%S)"
crontab -l > "$CRON_BACKUP" 2>/dev/null || touch "$CRON_BACKUP"
pass "Crontab backed up to: $CRON_BACKUP"

# Create new crontab
NEW_CRON="$HOME/spxer-cron-new"
cp "$CRON_BACKUP" "$NEW_CRON"

# Add header
{
    echo ""
    echo "# ============================================================================ "
    echo "# SPXer Config-Driven Pre-Market Automation - Added $(date)"
    echo "# All timing calculated from: $AGENT_CONFIG_ID:-default}"
    echo "# ============================================================================ "
} >> "$NEW_CRON"

# Add time-independent checks (06:00, 07:00, 07:50, 08:00)
cat >> "$NEW_CRON" << EOF

# 06:00 AM ET - Early Infrastructure (Tiers 1-5)
0 6 * * 1-5 cd $SPXER_DIR && ./scripts/ops/check-early-infrastructure.sh >> logs/cron-0600-\$(date +\\%Y\\%m\\%d).log 2>&1

# 07:00 AM ET - Data Pipeline (Tiers 6-10)
0 7 * * 1-5 cd $SPXER_DIR && ./scripts/ops/check-data-pipeline.sh >> logs/cron-0700-\$(date +\\%Y\\%m\\%d).log 2>&1

# 07:50 AM ET - Pre-Market Validation (Tiers 11-17)
50 7 * * 1-5 cd $SPXER_DIR && ./scripts/ops/check-pre-market-validation.sh >> logs/cron-0750-\$(date +\\%Y\\%m\\%d).log 2>&1

# 08:00 AM ET - Warmup Starts
0 8 * * 1-5 export WARMUP_TARGET_MODE=$TARGET_MODE && cd $SPXER_DIR && ./scripts/ops/start-warmup-with-checklist.sh >> logs/cron-0800-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

# Add transition cron (config-driven or default)
if [ "$MANUAL_MODE" = false ]; then
    if [ "$USE_CONFIG_TIME" = true ] && [ -n "$TRANSITION_HOUR" ]; then
        # Use calculated time from config
        cat >> "$NEW_CRON" << EOF

# ${TRANSITION_HOUR}:${TRANSITION_MINUTE} AM ET - Transition to $TARGET_MODE
# Calculated from config: $AGENT_CONFIG_ID
# Transition script will validate against config on each run
0 ${TRANSITION_HOUR} * * 1-5 export WARMUP_TARGET_MODE=$TARGET_MODE && cd $SPXER_DIR && ./scripts/ops/transition-from-warmup.sh >> logs/cron-${TRANSITION_HOUR}${TRANSITION_MINUTE}-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF
        pass "Transition cron: ${TRANSITION_HOUR}:${TRANSITION_MINUTE} AM ET (from config)"
    else
        # Use default time
        cat >> "$NEW_CRON" << EOF

# 10:15 AM ET - Transition to $TARGET_MODE (DEFAULT - set AGENT_CONFIG_ID for accuracy!)
# To calculate accurate time for your config:
#   export AGENT_CONFIG_ID=your-config-id
#   ./scripts/ops/calculate-transition-from-config.sh
15 10 * * 1-5 export WARMUP_TARGET_MODE=$TARGET_MODE && cd $SPXER_DIR && ./scripts/ops/transition-from-warmup.sh >> logs/cron-1015-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF
        warn "Transition cron: 10:15 AM ET (default - may not match your config!)"
        echo "  Run calculator: ./scripts/ops/calculate-transition-from-config.sh"
    fi
else
    # Manual mode - just reminders
    cat >> "$NEW_CRON" << EOF

# Manual reminders - transition time calculated from your config
# Run calculator to see your time: ./scripts/ops/calculate-transition-from-config.sh
0 6 * * 1-5 echo "⏰ 06:00 - Early infrastructure: cd $SPXER_DIR && ./scripts/ops/check-early-infrastructure.sh" | logger -t spxer
0 7 * * 1-5 echo "⏰ 07:00 - Data pipeline: cd $SPXER_DIR && ./scripts/ops/check-data-pipeline.sh" | logger -t spxer
50 7 * * 1-5 echo "⏰ 07:50 - Pre-market validation: cd $SPXER_DIR && ./scripts/ops/check-pre-market-validation.sh" | logger -t spxer
0 8 * * 1-5 echo "⏰ 08:00 - Start warmup: cd $SPXER_DIR && ./scripts/ops/start-warmup-with-checklist.sh" | logger -t spxer
EOF
    pass "Cron entries: Manual reminders (time calculated from config)"
fi

echo

# ============================================================================
# INSTALL CRONTAB
# ============================================================================
header "Step 3: Installing Crontab"
echo

echo "Cron schedule to be installed:"
echo "─────────────────────────────────"
echo "06:00 AM ET: Early Infrastructure"
echo "07:00 AM ET: Data Pipeline"
echo "07:50 AM ET: Pre-Market Validation"
echo "08:00 AM ET: Warmup Starts"
if [ "$USE_CONFIG_TIME" = true ] && [ -n "$TRANSITION_HOUR" ]; then
    echo "${TRANSITION_HOUR}:${TRANSITION_MINUTE} AM ET: Transition to $TARGET_MODE (from config)"
else
    echo "10:15 AM ET: Transition to $TARGET_MODE (default - see above)"
fi
echo "─────────────────────────────────"
echo

read -p "Install these cron jobs? (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted"
    rm -f "$NEW_CRON"
    exit 0
fi

crontab "$NEW_CRON"
pass "Crontab installed"
rm -f "$NEW_CRON"

echo

# ============================================================================
# VERIFY INSTALLATION
# ============================================================================
header "Step 4: Verification"
echo

echo "Current crontab (SPXer entries):"
echo "─────────────────────────────────"
crontab -l | grep -A 25 "SPXer Config-Driven" || echo "No SPXer entries found"
echo "─────────────────────────────────"
echo

pass "Setup complete!"
echo

# ============================================================================
# SUMMARY
# ============================================================================
header "Summary"
echo

echo -e "${GREEN}${BOLD}✅ Config-driven automation installed!${NC}"
echo
echo "Key Points:"
echo "  • All timing reads from config (not hard-coded)"
echo "  • Transition script validates against config on each run"
echo "  • If you change HMA/timeframe, recalculate with:"
echo "    ./scripts/ops/calculate-transition-from-config.sh"
echo
if [ -n "${AGENT_CONFIG_ID:-}" ]; then
    echo "Current Config: $AGENT_CONFIG_ID"
else
    echo "⚠️  AGENT_CONFIG_ID not set"
    echo "  Set it for accurate timing: export AGENT_CONFIG_ID=your-id"
    echo "  Then re-run: ./scripts/ops/setup-8am-automation-config-driven.sh"
fi
echo
echo "Monitor logs:"
echo "  tail -f logs/cron-0600-\$(date +%Y%m%d).log  # 06:00 checks"
echo "  tail -f logs/cron-0700-\$(date +%Y%m%d).log  # 07:00 checks"
echo "  tail -f logs/cron-0750-\$(date +%Y%m%d).log  # 07:50 checks"
echo "  tail -f logs/cron-0800-\$(date +%Y%m%d).log  # 08:00 warmup"
if [ "$USE_CONFIG_TIME" = true ] && [ -n "$TRANSITION_HOUR" ]; then
    echo "  tail -f logs/cron-${TRANSITION_HOUR}${TRANSITION_MINUTE}-\$(date +%Y%m%d).log  # ${TRANSITION_HOUR}:${TRANSITION_MINUTE} transition"
else
    echo "  tail -f logs/cron-1015-\$(date +%Y%m%d).log  # 10:15 transition (default)"
fi
echo
echo "Cron backup: $CRON_BACKUP"
echo

exit 0
