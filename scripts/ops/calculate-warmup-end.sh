#!/bin/bash
# Calculate warmup end time based on HMA slow period and timeframe
# This determines when the first valid signal can occur on today's data

set -euo pipefail

# Configuration
HMA_SLOW=${1:-12}          # Slow HMA period (default 12)
TIMEFRAME_MINUTES=${2:-3}  # Timeframe in minutes (default 3)
BUFFER_MINUTES=${3:-15}    # Buffer after first valid cross (default 15)

echo "Warmup End Time Calculator"
echo "========================="
echo
echo "Configuration:"
echo "  HMA Slow Period: $HMA_SLOW"
echo "  Timeframe: ${TIMEFRAME_MINUTES}m"
echo "  Buffer: ${BUFFER_MINUTES} minutes"
echo

# Calculate minutes needed for HMA(slow) to become valid
MINUTES_NEEDED=$((HMA_SLOW * TIMEFRAME_MINUTES))

echo "Calculation:"
echo "  Bars needed: $HMA_SLOW"
echo "  Minutes per bar: ${TIMEFRAME_MINUTES}m"
echo "  Total minutes: $MINUTES_NEEDED"
echo

# Calculate time when HMA(slow) becomes valid
# Market opens at 09:30 AM ET = 9:30 = 570 minutes
MARKET_OPEN_MIN=570
FIRST_VALID_MIN=$((MARKET_OPEN_MIN + MINUTES_NEEDED))
FIRST_VALID_HOUR=$((FIRST_VALID_MIN / 60))
FIRST_VALID_MINUTE=$((FIRST_VALID_MIN % 60))

echo "Market opens: 09:30 AM ET"
echo "HMA($HMA_SLOW) valid at: $(printf '%02d:%02d' $FIRST_VALID_HOUR $FIRST_VALID_MINUTE) AM ET"
echo

# Add buffer
TRANSITION_MIN=$((FIRST_VALID_MIN + BUFFER_MINUTES))
TRANSITION_HOUR=$((TRANSITION_MIN / 60))
TRANSITION_MINUTE=$((TRANSITION_MIN % 60))

echo "With ${BUFFER_MINUTES}m buffer: $(printf '%02d:%02d' $TRANSITION_HOUR $TRANSITION_MINUTE) AM ET"
echo

# Output for cron
echo "Recommended cron entry:"
echo "0 $(printf '%02d' $TRANSITION_HOUR) * * 1-5 cd /home/ubuntu/SPXer && ./scripts/ops/transition-from-warmup.sh"
echo

# Summary
echo "Summary:"
echo "  Warmup starts: 08:00 AM ET"
echo "  Market opens: 09:30 AM ET"
echo "  First HMA($HMA_SLOW) valid: $(printf '%02d:%02d' $FIRST_VALID_HOUR $FIRST_VALID_MINUTE) AM ET"
echo "  Transition to trading: $(printf '%02d:%02d' $TRANSITION_HOUR $TRANSITION_MINUTE) AM ET"
echo "  Total warmup duration: $((TRANSITION_HOUR * 60 + TRANSITION_MINUTE - 8 * 60)) minutes"
echo

# Export for use in other scripts
export TRANSITION_HOUR
export TRANSITION_MINUTE
export WARMUP_END_TIME="${TRANSITION_HOUR}:${TRANSITION_MINUTE}"

exit 0
