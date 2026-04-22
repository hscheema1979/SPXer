#!/usr/bin/env bash
# Run all missing replay configs (200+ day configs) for recent dates
# Usage: bash scripts/run-missing-replays.sh [--dry-run] [--concurrency=N]

set -euo pipefail
cd "$(dirname "$0")/.."

DB="data/spxer.db"
CONCURRENCY=8
DRY_RUN=false

for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    --concurrency=*) CONCURRENCY="${arg#--concurrency=}" ;;
  esac
done

echo "=== Missing Replay Runner ==="
echo "Concurrency: $CONCURRENCY | Dry run: $DRY_RUN"
echo ""

# Get all missing config-date pairs for 200+ day configs, recent dates only
PAIRS=$(sqlite3 "$DB" "
WITH qualifying_configs AS (
  SELECT rc.id
  FROM replay_configs rc
  LEFT JOIN replay_results rr ON rc.id = rr.configId
  GROUP BY rc.id
  HAVING COUNT(DISTINCT rr.date) >= 200
),
recent_dates AS (
  SELECT DISTINCT date FROM replay_results WHERE date >= '2026-04-01'
),
all_combos AS (
  SELECT qc.id as configId, rd.date
  FROM qualifying_configs qc
  CROSS JOIN recent_dates rd
),
existing AS (
  SELECT configId, date FROM replay_results WHERE date >= '2026-04-01'
)
SELECT ac.date || '|' || ac.configId
FROM all_combos ac
LEFT JOIN existing e ON ac.configId = e.configId AND ac.date = e.date
WHERE e.configId IS NULL
ORDER BY ac.date, ac.configId;
")

TOTAL=$(echo "$PAIRS" | grep -c '|' || true)
echo "Total missing pairs: $TOTAL"
echo ""

if [ "$DRY_RUN" = "true" ]; then
  echo "$PAIRS" | head -20
  echo "... (dry run, not running)"
  exit 0
fi

# Run in parallel batches
COMPLETED=0
FAILED=0
PIDS=()
PAIR_ARRAY=()

while IFS= read -r line; do
  [ -z "$line" ] && continue
  PAIR_ARRAY+=("$line")
done <<< "$PAIRS"

run_one() {
  local date="$1"
  local config_id="$2"
  local result
  if npx tsx src/replay/cli.ts run "$date" --config-id="$config_id" --no-scanners --no-judge 2>&1 | tail -1 | grep -q "trades\|0 trade\|No bars"; then
    echo "  ✓ $date | $config_id"
    return 0
  else
    # Re-check if result actually got written
    local count
    count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM replay_results WHERE configId='$config_id' AND date='$date';" 2>/dev/null || echo 0)
    if [ "$count" -gt 0 ]; then
      echo "  ✓ $date | $config_id (wrote $count result)"
      return 0
    else
      echo "  ✗ $date | $config_id (FAILED)"
      return 1
    fi
  fi
}

export -f run_one
export DB

# Use xargs for parallel execution if available
if command -v parallel &>/dev/null; then
  printf '%s\n' "${PAIR_ARRAY[@]}" | \
    parallel --jobs "$CONCURRENCY" --colsep '|' \
    'npx tsx src/replay/cli.ts run {1} --config-id={2} --no-scanners --no-judge > /dev/null 2>&1 && echo "  ✓ {1} | {2}" || echo "  ✗ {1} | {2}"'
else
  # Fall back to xargs -P
  printf '%s\n' "${PAIR_ARRAY[@]}" | \
    xargs -P "$CONCURRENCY" -I{} bash -c '
      line="{}"
      date="${line%%|*}"
      config="${line##*|}"
      if npx tsx src/replay/cli.ts run "$date" --config-id="$config" --no-scanners --no-judge > /dev/null 2>&1; then
        echo "  ✓ $date | $config"
      else
        echo "  ✗ $date | $config"
      fi
    '
fi

echo ""
echo "=== Done ==="
