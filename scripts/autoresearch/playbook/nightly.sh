#!/usr/bin/env bash
# Nightly regime-playbook cycle (LOCAL cron). Refresh regimes from latest data,
# then rebuild the OOS-validated matrix from the dashboard daily P&L.
export PATH="/usr/bin:$PATH"
cd /home/ubuntu/SPXer
LOG=scripts/autoresearch/playbook/nightly.log
{
  echo "===== playbook cycle $(date -u +%FT%TZ) ====="
  nice -n 15 npx tsx scripts/diag/regime-classify.ts --symbol SPX
  nice -n 15 npx tsx scripts/diag/regime-classify.ts --symbol NDX
  nice -n 15 npx tsx scripts/autoresearch/playbook/playbook-cycle.ts
  echo "===== done $(date -u +%FT%TZ) ====="
} >> "$LOG" 2>&1
