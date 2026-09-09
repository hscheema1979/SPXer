#!/bin/bash
# full-sweep-orchestrate.sh
#
# Runs the SPX HMA full-grid sweep in 18 chunks (TF × MA-pair), one at a time,
# 4 workers each. After each chunk, regenerates the SPXHMA dashboard files so
# Studio /dashboard/backtest/ → SPXHMA progressively populates.
#
# Edge-first ordering: 3m → 2m → 5m → 1m → 2+3 → 2+3+5
#                      within each TF: 3x12 → 3x9 → 3x21
#
# Run from repo root:
#   bash scripts/diag/full-sweep-orchestrate.sh
#
# Env:
#   DAYS=365   override day-count (default 365)
#   GATE_END=16:00   override session end (default 16:00, full day)
#   DRY_RUN=1  print plan and exit
set -euo pipefail

DAYS="${DAYS:-365}"
GATE_END="${GATE_END:-16:00}"
WORKERS="${WORKERS:-4}"
OUT_DIR="scripts/autoresearch/output/full-sweep-spxhma"
mkdir -p "$OUT_DIR"

# Edge-first chunk ordering. Each entry: <chunk-id>|<signal-label>
# Restricted to 3m/2m/5m × all 3 MA-pairs (9 chunks). 1m + multi-TF dropped.
CHUNKS=(
  "01|HMA 3m 3x12"
  "02|HMA 3m 3x9"
  "03|HMA 3m 3x21"
  "04|HMA 2m 3x12"
  "05|HMA 2m 3x9"
  "06|HMA 2m 3x21"
  "07|HMA 5m 3x12"
  "08|HMA 5m 3x9"
  "09|HMA 5m 3x21"
)

# Offsets — 11 strikes (-25..+25 by 5) on SPX
OFFSETS="SPX:-25,-20,-15,-10,-5,0,5,10,15,20,25"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY RUN — would execute:"
  for entry in "${CHUNKS[@]}"; do
    chunk_id="${entry%%|*}"
    sig_label="${entry#*|}"
    echo "  chunk ${chunk_id}: --signals '${sig_label}' (full ${OFFSETS}, days=${DAYS}, gate-end=${GATE_END})"
  done
  exit 0
fi

start_all=$(date +%s)
for entry in "${CHUNKS[@]}"; do
  chunk_id="${entry%%|*}"
  sig_label="${entry#*|}"
  safe_label="${sig_label// /-}"
  safe_label="${safe_label//+/p}"   # 2+3 → 2p3 for filename safety
  out_file="${OUT_DIR}/chunk-${chunk_id}-${safe_label}.json"

  if [[ -f "$out_file" ]]; then
    echo "[orchestrate] chunk ${chunk_id} ${sig_label} — already exists, skipping"
    continue
  fi

  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "[orchestrate] chunk ${chunk_id}/9 — ${sig_label}"
  echo "════════════════════════════════════════════════════════════════"
  start=$(date +%s)
  npx tsx scripts/diag/hma3m-tpsl-study.ts \
    --symbols SPX --days "${DAYS}" --workers "${WORKERS}" \
    --gate-end "${GATE_END}" \
    --signals "${sig_label}" \
    --offsets "${OFFSETS}" \
    --emit-trades \
    --out "${out_file}" 2>&1 | tail -30
  end=$(date +%s)
  echo "[orchestrate] chunk ${chunk_id} done in $((end - start))s ($(((end - start) / 60))m)"

  # Reshape merged set into dashboard files. Build --in args from all completed
  # chunks so SPXHMA grows progressively. Also include the focused-configs runs
  # so the trade-emitting 8 fixed rows (with hourly + daily + risk) survive.
  in_args=()
  for done_file in "${OUT_DIR}"/chunk-*.json; do
    [[ -e "$done_file" ]] || continue
    in_args+=(--in "${done_file}::09:30-${GATE_END}")
  done
  # Focused-configs windows (these have trades → power Daily/Risk/Hourly tabs).
  if [[ -f scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d-trades.json ]]; then
    in_args+=(--in "scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d-trades.json::09:30-12:00")
  fi
  if [[ -f scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d-fullday.json ]]; then
    in_args+=(--in "scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d-fullday.json::09:30-16:00")
  fi
  # Hourly comes from the focused-configs full-day run (only that file has trade
  # rows currently — the full-grid chunks lose them in the save path).
  hourly_arg=(--hourly "scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d-fullday.json::09:30-16:00")

  echo "[orchestrate] regenerating dashboard files from $((${#in_args[@]} / 2)) chunks"
  npx tsx scripts/diag/hma3m-to-dashboard.ts \
    "${in_args[@]}" \
    "${hourly_arg[@]}" \
    --ticker spxhma 2>&1 | tail -10
  echo "[orchestrate] dashboard refreshed — visible at SPXHMA profile"
done

end_all=$(date +%s)
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "[orchestrate] ALL 18 CHUNKS COMPLETE in $((end_all - start_all))s ($(((end_all - start_all) / 60))m)"
echo "════════════════════════════════════════════════════════════════"
