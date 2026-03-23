#!/bin/bash

echo "═══════════════════════════════════════════════════════════"
echo "  Autoresearch Progress Check"
echo "═══════════════════════════════════════════════════════════"

# Count running verify-metric processes
RUNNING=$(ps aux | grep "verify-metric\|npm exec tsx" | grep -v grep | wc -l)

# Show last few results
if [ -f .autoresearch-results.tsv ]; then
  echo ""
  echo "[CURRENT BEST CONFIGS]"
  tail -5 .autoresearch-results.tsv | awk -F'\t' '{printf "  %s: WR=%.0f%% P&L=$%s\n", $2, $6*100, $7}'
  echo ""
  echo "Total results: $(( $(wc -l < .autoresearch-results.tsv) - 1 ))"
else
  echo "  [No results yet]"
fi

echo ""
echo "[PROCESSES] $RUNNING running (0 = complete)"
echo ""

# Show agent status
pm2 show spxer-agent 2>/dev/null | grep -E "status|cpu|memory|uptime" | head -10

echo ""
echo "[LAST LOG] Latest autoresearch activity:"
tail -3 /tmp/sessions-1-8.log 2>/dev/null || echo "  (no log yet)"
echo ""
