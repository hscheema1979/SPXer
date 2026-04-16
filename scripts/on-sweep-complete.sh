#!/bin/bash
# on-sweep-complete.sh — Polls until all 4 sweep shards finish, then runs a task.
#
# Usage:
#   nohup bash scripts/on-sweep-complete.sh &
#   # or:
#   bash scripts/on-sweep-complete.sh &
#
# What it does:
#   1. Polls every 30s checking if any autosweep processes are still running
#   2. Once all shards are done, writes a marker file and runs the post-sweep task
#   3. The post-sweep task is defined in the TASK section at the bottom
#
# You can also just run it in tmux/screen and watch the output.

set -euo pipefail
cd /home/ubuntu/SPXer

POLL_INTERVAL=30     # seconds between checks
MARKER_FILE="logs/sweep-complete.marker"
LOG_FILE="logs/post-sweep.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Watching for sweep completion..." | tee "$LOG_FILE"

while true; do
  # Count running autosweep processes (the actual node workers, not the npm wrappers)
  RUNNING=$(ps aux | grep 'autosweep.ts' | grep -v grep | grep 'node.*tsx' | wc -l)
  
  if [ "$RUNNING" -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] All sweep shards completed!" | tee -a "$LOG_FILE"
    echo "$(date '+%Y-%m-%d %H:%M:%S')" > "$MARKER_FILE"
    break
  fi
  
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Still running: $RUNNING sweep processes. Checking again in ${POLL_INTERVAL}s..."
  sleep "$POLL_INTERVAL"
done

# ══════════════════════════════════════════════════════════════════════════════
# POST-SWEEP TASK — edit this section to define what runs after the sweep
# ══════════════════════════════════════════════════════════════════════════════

echo "" | tee -a "$LOG_FILE"
echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "  POST-SWEEP: Keltner Channel Trend Filter Implementation" | tee -a "$LOG_FILE"
echo "════════════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Option A: Notify you (simplest — just creates a marker + logs)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] SWEEP COMPLETE — Ready for Keltner Channel implementation" | tee -a "$LOG_FILE"
echo "  Design spec: docs/keltner-channel-trend-filter.md" | tee -a "$LOG_FILE"
echo "  To start implementation, ask Claude:" | tee -a "$LOG_FILE"
echo "    'Implement the Keltner Channel trend filter from docs/keltner-channel-trend-filter.md'" | tee -a "$LOG_FILE"

# Option B: Auto-run sweep analysis first (uncomment to enable)
# echo "[$(date)] Running sweep results analysis..." | tee -a "$LOG_FILE"
# npx tsx scripts/autosweep.ts --status >> "$LOG_FILE" 2>&1

# Option C: Auto-start the KC implementation via pi (uncomment to enable)
# This would require pi to be running and accepting commands.
# echo "Implement the Keltner Channel trend filter per docs/keltner-channel-trend-filter.md" | pi --non-interactive >> "$LOG_FILE" 2>&1

echo "" | tee -a "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Post-sweep task finished." | tee -a "$LOG_FILE"
