#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# SPXer Database Backup Script
#
# Performs a hot SQLite backup locally, then SCP's to srvr (Windows
# PC on Tailscale) at E:\SPXer-Backups.
#
# Usage:
#   ./scripts/backup-db.sh              # Full backup (local + remote)
#   ./scripts/backup-db.sh --local-only # Skip remote copy
#   ./scripts/backup-db.sh --dry-run    # Show what would be done
#
# Cron (5 AM ET = 9 UTC, Tue-Sat):
#   0 9 * * 2-6 /home/ubuntu/SPXer/scripts/backup-db.sh >> /home/ubuntu/SPXer/logs/backup.log 2>&1
# ──────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────

DB_PATH="/home/ubuntu/SPXer/data/spxer.db"
LOCAL_BACKUP_DIR="/home/ubuntu/SPXer/data/backups"
LOCAL_RETENTION_DAYS=3

REMOTE_HOST="srvr"                          # SSH config alias → harpreet@100.126.182.128
REMOTE_DIR="E:\\SPXer-Backups"              # Windows path on srvr
REMOTE_RETENTION_DAYS=14                     # Keep 2 weeks on the big disk

STAMP="$(date +%Y%m%d)"
TIMESTAMP="$(date -Iseconds)"
BACKUP_NAME="spxer-${STAMP}.db"

# ── Flags ─────────────────────────────────────────────────────────

DRY_RUN=false
LOCAL_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --local-only) LOCAL_ONLY=true ;;
    --help|-h)
      echo "Usage: backup-db.sh [--local-only] [--dry-run]"
      exit 0
      ;;
  esac
done

log() { echo "${TIMESTAMP} $*"; }

# ── Pre-flight ────────────────────────────────────────────────────

if [ ! -f "$DB_PATH" ]; then
  log "ERROR: Database not found at $DB_PATH"
  exit 1
fi

DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
log "Starting backup — DB size: ${DB_SIZE}"

# ── Step 1: Local hot backup ─────────────────────────────────────

mkdir -p "$LOCAL_BACKUP_DIR"
LOCAL_DEST="${LOCAL_BACKUP_DIR}/${BACKUP_NAME}"

if [ "$DRY_RUN" = true ]; then
  log "[DRY-RUN] Would backup $DB_PATH → $LOCAL_DEST"
else
  log "Local backup → $LOCAL_DEST"
  sqlite3 "$DB_PATH" ".backup $LOCAL_DEST"
  BACKUP_SIZE=$(du -h "$LOCAL_DEST" | cut -f1)
  log "Local backup complete (${BACKUP_SIZE})"
fi

# ── Step 2: Prune old local backups ──────────────────────────────

if [ "$DRY_RUN" = true ]; then
  log "[DRY-RUN] Would prune local backups older than ${LOCAL_RETENTION_DAYS}d"
else
  PRUNED=$(find "$LOCAL_BACKUP_DIR" -name "spxer-*.db" -mtime +${LOCAL_RETENTION_DAYS} -print -delete | wc -l)
  REMAINING=$(ls "$LOCAL_BACKUP_DIR"/spxer-*.db 2>/dev/null | wc -l)
  log "Local: pruned ${PRUNED} old backups, ${REMAINING} remaining"
fi

# ── Step 3: Remote copy to srvr ──────────────────────────────────

if [ "$LOCAL_ONLY" = true ]; then
  log "Skipping remote backup (--local-only)"
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  log "[DRY-RUN] Would SCP $LOCAL_DEST → ${REMOTE_HOST}:${REMOTE_DIR}\\${BACKUP_NAME}"
  log "[DRY-RUN] Would prune remote backups older than ${REMOTE_RETENTION_DAYS}d"
  exit 0
fi

# Check if srvr is reachable (3s timeout)
if ! ssh -o ConnectTimeout=3 -o BatchMode=yes "$REMOTE_HOST" "echo ok" >/dev/null 2>&1; then
  log "WARNING: srvr (${REMOTE_HOST}) unreachable — skipping remote backup"
  log "Local backup succeeded. Remote will catch up next run."
  exit 0
fi

log "Remote copy → ${REMOTE_HOST}:${REMOTE_DIR}\\${BACKUP_NAME}"
scp -o ConnectTimeout=10 "$LOCAL_DEST" "${REMOTE_HOST}:\"${REMOTE_DIR}\\${BACKUP_NAME}\""
log "Remote copy complete"

# Prune old remote backups (PowerShell via SSH)
log "Pruning remote backups older than ${REMOTE_RETENTION_DAYS} days..."
ssh -o ConnectTimeout=10 "$REMOTE_HOST" "powershell -Command \"Get-ChildItem 'E:\\SPXer-Backups\\spxer-*.db' | Where-Object { \$_.LastWriteTime -lt (Get-Date).AddDays(-${REMOTE_RETENTION_DAYS}) } | Remove-Item -Force -Verbose\"" 2>&1 || log "WARNING: Remote prune failed (non-fatal)"

REMOTE_COUNT=$(ssh -o ConnectTimeout=10 "$REMOTE_HOST" "powershell -Command \"(Get-ChildItem 'E:\\SPXer-Backups\\spxer-*.db').Count\"" 2>/dev/null || echo "?")
log "Remote: ${REMOTE_COUNT} backups on srvr"

log "Backup complete — local + remote"
