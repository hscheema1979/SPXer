#!/bin/bash
# Complete Trading Automation Setup
# Installs all cron jobs for pre-market through trading
#
# Timeline:
#   00:06 - Machine Fundamentals (Tier 0)
#   15:06 - Service Setup & Runtime (Tier 1)
#   00:07 - Data Pipeline (Tiers 6-10)
#   50:07 - Pre-Market Validation (Tiers 11-17)
#   30:08 - Start SPXer/SignalPoller
#   00:09 - Start Event Handler
#   XX:10 - Transition to Trading (config-calculated)
#   00:10-00:16 - Ongoing Operational Monitoring (every 30 min)

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
TARGET_MODE=${WARMUP_TARGET_MODE:-"SIMULATION"}
for arg in "$@"; do
    case $arg in
        --target-mode)
            TARGET_MODE="$2"
            shift 2
            ;;
    esac
done

echo -e "${BOLD}${CYAN}"
echo "╔════════════════════════════════════════╗"
echo "║   SPXer Complete Trading Automation  ║"
echo "║   Machine → Services → Trading       ║"
echo "╚════════════════════════════════════════╝"
echo -e "${NC}"
echo
echo "Target mode: $TARGET_MODE"
echo

# ============================================================================
# CRON BACKUP
# ============================================================================

header "Backing up current crontab"
echo

CRON_BACKUP="$HOME/spxer-crontab-backup-$(date +%Y%m%d-%H%M%S)"
crontab -l > "$CRON_BACKUP" 2>/dev/null || touch "$CRON_BACKUP"
pass "Crontab backed up to: $CRON_BACKUP"

echo

# ============================================================================
# CREATE NEW CRONTAB
# ============================================================================

header "Creating new crontab"
echo

NEW_CRON="$HOME/spxer-cron-new"
cp "$CRON_BACKUP" "$NEW_CRON"

# Remove old SPXer automation entries if they exist
grep -v "# SPXer Automation" "$NEW_CRON" > "$NEW_CRON.tmp" || true
mv "$NEW_CRON.tmp" "$NEW_CRON"

# Add comment header
cat >> "$NEW_CRON" << 'EOF'

# ============================================================================
# SPXer Trading Automation - Installed 2026-04-24
# All times are ET (Eastern Time)
# ============================================================================

EOF

pass "Cron header added"

echo

# ============================================================================
# ADD CRON ENTRIES IN SEQUENCE
# ============================================================================

header "Adding automation entries"
echo

# 06:00 AM ET - Tier 0: Machine Fundamentals
cat >> "$NEW_CRON" << EOF
# 06:00 AM ET - Tier 0: Machine Fundamentals (RAM, Disk, CPU, Network, Timezone, Clock)
0 6 * * 1-5 cd $SPXER_DIR && ./scripts/ops/check-environment.sh >> logs/cron-0600-environment-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

pass "06:00 - Machine Fundamentals check added"

# 06:15 AM ET - Tier 1: Service Setup & Runtime
cat >> "$NEW_CRON" << EOF
# 06:15 AM ET - Tier 1: Service Setup & Runtime (SPXer, Event Handler, Position Handler)
15 6 * * 1-5 cd $SPXER_DIR && ./scripts/ops/check-services-setup.sh >> logs/cron-0615-services-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

pass "06:15 - Service Setup check added"

# 07:00 AM ET - Tiers 6-10: Data Pipeline
cat >> "$NEW_CRON" << EOF
# 07:00 AM ET - Tiers 6-10: Data Pipeline (System Visibility, E2E, State, Freshness, Acceptance)
0 7 * * 1-5 cd $SPXER_DIR && ./scripts/ops/check-data-pipeline.sh >> logs/cron-0700-pipeline-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

pass "07:00 - Data Pipeline check added"

# 07:50 AM ET - Tiers 11-17: Pre-Market Validation
cat >> "$NEW_CRON" << EOF
# 07:50 AM ET - Tiers 11-17: Pre-Market Validation (Market State, Financial, Time Decay, Network, Data Quality, Human, Regulatory)
50 7 * * 1-5 cd $SPXER_DIR && ./scripts/ops/check-pre-market-validation.sh >> logs/cron-0750-validation-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

pass "07:50 - Pre-Market Validation added"

# 08:30 AM ET - Start SPXer/SignalPoller
cat >> "$NEW_CRON" << EOF
# 08:30 AM ET - Start SPXer Service (includes SignalPoller)
30 8 * * 1-5 pm2 start spxer >> logs/cron-0830-start-spxer-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

pass "08:30 - SPXer/SignalPoller startup added"

# 09:00 AM ET - Start Event Handler
cat >> "$NEW_CRON" << EOF
# 09:00 AM ET - Start Event Handler
0 9 * * 1-5 pm2 start event-handler >> logs/cron-0900-start-handler-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

pass "09:00 - Event Handler startup added"

# ============================================================================
# ONGOING OPERATIONAL MONITORING - Every 30 minutes during market hours
# ============================================================================

# 10:00 AM - 4:00 PM ET every 30 minutes
cat >> "$NEW_CRON" << EOF
# Ongoing Operational Monitoring - Every 30 minutes from 10:00 AM to 4:00 PM ET
# Focus: Data freshness, signal detection, service health, positions, connectivity
0 10 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-10-\$(date +\\%Y\\%m\\%d).log 2>&1
30 10 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-1030-\$(date +\\%Y\\%m\\%d).log 2>&1
0 11 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-11-\$(date +\\%Y\\%m\\%d).log 2>&1
30 11 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-1130-\$(date +\\%Y\\%m\\%d).log 2>&1
0 12 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-12-\$(date +\\%Y\\%m\\%d).log 2>&1
30 12 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-1230-\$(date +\\%Y\\%m\\%d).log 2>&1
0 13 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-13-\$(date +\\%Y\\%m\\%d).log 2>&1
30 13 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-1330-\$(date +\\%Y\\%m\\%d).log 2>&1
0 14 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-14-\$(date +\\%Y\\%m\\%d).log 2>&1
30 14 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-1430-\$(date +\\%Y\\%m\\%d).log 2>&1
0 15 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-15-\$(date +\\%Y\\%m\\%d).log 2>&1
30 15 * * 1-5 cd $SPXER_DIR && ./scripts/ops/monitor-operational.sh >> logs/cron-operational-1530-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF

pass "Ongoing Operational Monitoring added (every 30 min, 10 AM - 4 PM ET)"

echo

# Calculate transition time from config if available
if [ -n "${AGENT_CONFIG_ID:-}" ]; then
    info "Calculating transition time from config: $AGENT_CONFIG_ID"

    # Run calculator and parse output
    CALC_OUTPUT=$($SCRIPT_DIR/calculate-transition-from-config.sh 2>&1)

    # Extract the cron line
    TRANSITION_CRON=$(echo "$CALC_OUTPUT" | grep "0 [0-9][0-9] \* \* 1-5.*transition-from-warmup" | tail -1 || "")

    if [ -n "$TRANSITION_CRON" ]; then
        echo "$TRANSITION_CRON" >> "$NEW_CRON"
        pass "Config-calculated transition time added"
    else
        # Default: 10:15 AM ET for 3m timeframe
        warn "Could not calculate from config, using default 10:15 AM"
        cat >> "$NEW_CRON" << EOF
# 10:15 AM ET - Transition to Trading (DEFAULT - set AGENT_CONFIG_ID for accuracy)
15 10 * * 1-5 export WARMUP_TARGET_MODE=$TARGET_MODE && cd $SPXER_DIR && ./scripts/ops/transition-from-warmup.sh >> logs/cron-1015-transition-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF
    fi
else
    # No config ID - use default 10:15 AM
    warn "AGENT_CONFIG_ID not set, using default 10:15 AM transition"
    cat >> "$NEW_CRON" << EOF
# 10:15 AM ET - Transition to Trading (DEFAULT - set AGENT_CONFIG_ID for accuracy)
15 10 * * 1-5 export WARMUP_TARGET_MODE=$TARGET_MODE && cd $SPXER_DIR && ./scripts/ops/transition-from-warmup.sh >> logs/cron-1015-transition-\$(date +\\%Y\\%m\\%d).log 2>&1
EOF
fi

echo

# ============================================================================
# INSTALL CRONTAB
# ============================================================================

header "Installing crontab"
echo

echo "Cron entries to be installed:"
echo "─────────────────────────────────"
grep "# SPXer Automation" -A 200 "$NEW_CRON" | grep -E "^[0-9]|#" | head -30
echo "─────────────────────────────────"
echo

read -p "Install these cron jobs? (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted"
    rm -f "$NEW_CRON"
    exit 0
fi

# Install new crontab
crontab "$NEW_CRON"
pass "Crontab installed"
rm -f "$NEW_CRON"

echo

# ============================================================================
# VERIFY INSTALLATION
# ============================================================================

header "Verifying installation"
echo

echo "Current crontab (SPXer entries):"
crontab -l | grep -A 30 "# SPXer Automation" | head -35
echo

# Verify cron service
if systemctl is-active --quiet cron 2>/dev/null || systemctl is-active --quiet crond 2>/dev/null; then
    pass "Cron service is running"
else
    warn "Cron service may not be running - check with: systemctl status cron"
fi

echo
header "Installation Complete"
echo

echo -e "${GREEN}${BOLD}✅ AUTOMATION INSTALLED${NC}"
echo
echo "Daily Schedule:"
echo "  06:00 AM ET - Machine Fundamentals (Tier 0)"
echo "  06:15 AM ET - Service Setup & Runtime (Tier 1)"
echo "  07:00 AM ET - Data Pipeline (Tiers 6-10)"
echo "  07:50 AM ET - Pre-Market Validation (Tiers 11-17)"
echo "  08:30 AM ET - Start SPXer/SignalPoller"
echo "  09:00 AM ET - Start Event Handler"
echo "  10:XX AM ET - Transition to Trading (from config)"
echo "  10:00-16:00 ET - Ongoing Operational Monitoring (every 30 min)"
echo
echo "Monitor logs:"
echo "  tail -f logs/cron-0600-environment-$(date +%Y%m%d).log"
echo "  tail -f logs/cron-0615-services-$(date +%Y%m%d).log"
echo "  tail -f logs/cron-1015-transition-$(date +%Y%m%d).log"
echo
echo "To remove automation:"
echo "  crontab -e  # Delete SPXer entries"
echo "  crontab $CRON_BACKUP  # Restore old crontab"
echo

exit 0
