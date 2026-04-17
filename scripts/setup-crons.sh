#!/usr/bin/env bash
#
# setup-crons.sh — Install all automated housekeeping for SPXer.
#
# Usage:
#   ./scripts/setup-crons.sh              # Install everything
#   ./scripts/setup-crons.sh --dry-run    # Show what would be done
#   ./scripts/setup-crons.sh --uninstall  # Remove everything
#
# Idempotent: safe to run multiple times. Uses marker comments to
# replace previous entries rather than duplicating them.

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────

SPXER_DIR="/home/ubuntu/SPXer"
DATA_DIR="${SPXER_DIR}/data"
LOG_DIR="${SPXER_DIR}/logs"
BACKUP_DIR="${DATA_DIR}/backups"
DB_PATH="${DATA_DIR}/spxer.db"
LOGROTATE_CONF="/etc/logrotate.d/spxer"
CRON_MARKER_START="# SPXER-CRON-START"
CRON_MARKER_END="# SPXER-CRON-END"

DRY_RUN=false
UNINSTALL=false

# ── Argument parsing ─────────────────────────────────────────────────

for arg in "$@"; do
    case "$arg" in
        --dry-run)  DRY_RUN=true ;;
        --uninstall) UNINSTALL=true ;;
        -h|--help)
            echo "Usage: $0 [--dry-run] [--uninstall]"
            echo "  --dry-run    Show what would be done without making changes"
            echo "  --uninstall  Remove all SPXer crons and logrotate config"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--dry-run] [--uninstall]"
            exit 1
            ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────────────

info()  { echo -e "\033[1;32m[OK]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m $*"; }
step()  { echo -e "\033[1;36m==>\033[0m $*"; }
dry()   { echo -e "\033[1;35m[DRY-RUN]\033[0m $*"; }

# Strip existing SPXer cron block from a crontab string.
strip_spxer_crons() {
    sed "/${CRON_MARKER_START}/,/${CRON_MARKER_END}/d"
}

# ── Logrotate config ────────────────────────────────────────────────

LOGROTATE_CONTENT="/home/ubuntu/.pm2/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    size 50M
    copytruncate
    missingok
    notifempty
}

${SPXER_DIR}/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    size 20M
    copytruncate
    missingok
    notifempty
}
"

install_logrotate() {
    step "Installing logrotate config at ${LOGROTATE_CONF}"
    if $DRY_RUN; then
        dry "Would write ${LOGROTATE_CONF} with contents:"
        echo "$LOGROTATE_CONTENT"
        return
    fi
    echo "$LOGROTATE_CONTENT" | sudo tee "$LOGROTATE_CONF" > /dev/null
    sudo chmod 644 "$LOGROTATE_CONF"
    info "Logrotate config installed"
}

remove_logrotate() {
    step "Removing logrotate config"
    if $DRY_RUN; then
        dry "Would remove ${LOGROTATE_CONF}"
        return
    fi
    if [ -f "$LOGROTATE_CONF" ]; then
        sudo rm -f "$LOGROTATE_CONF"
        info "Logrotate config removed"
    else
        warn "Logrotate config not found (already removed)"
    fi
}

# ── Crontab entries ─────────────────────────────────────────────────

CRON_BLOCK="${CRON_MARKER_START}
# WAL checkpoint handled in-app by src/storage/db.ts (PASSIVE every 15m, TRUNCATE every 2h)

# DB backup (local + remote to srvr) — 5 AM ET (9 UTC) Tue-Sat
0 9 * * 2-6 ${SPXER_DIR}/scripts/backup-db.sh >> ${LOG_DIR}/backup.log 2>&1

# Bar purge — Sunday 3 AM ET (7 UTC)
0 7 * * 0 cd ${SPXER_DIR} && npx tsx scripts/purge-bars.ts >> ${LOG_DIR}/purge.log 2>&1

# Agent start — 9:25 AM ET (13:25 UTC) weekdays
25 13 * * 1-5 ${SPXER_DIR}/scripts/agent-scheduler.sh start >> ${LOG_DIR}/agent-scheduler.log 2>&1

# Agent stop — 4:20 PM ET (20:20 UTC) weekdays
20 20 * * 1-5 ${SPXER_DIR}/scripts/agent-scheduler.sh stop >> ${LOG_DIR}/agent-scheduler.log 2>&1

# Agent watchdog — every 5 min weekdays
*/5 * * * 1-5 ${SPXER_DIR}/scripts/agent-watchdog.sh >> ${LOG_DIR}/agent-scheduler.log 2>&1
${CRON_MARKER_END}"

install_crons() {
    step "Installing crontab entries"
    if $DRY_RUN; then
        dry "Would add the following cron block:"
        echo "$CRON_BLOCK"
        return
    fi

    # Get existing crontab (suppress "no crontab" error)
    local existing
    existing=$(crontab -l 2>/dev/null || true)

    # Strip any previous SPXer block
    local cleaned
    cleaned=$(echo "$existing" | strip_spxer_crons)

    # Append new block
    local new_crontab
    if [ -z "$cleaned" ]; then
        new_crontab="$CRON_BLOCK"
    else
        new_crontab="${cleaned}
${CRON_BLOCK}"
    fi

    echo "$new_crontab" | crontab -
    info "Crontab entries installed ($(echo "$CRON_BLOCK" | grep -c '^\*\|^[0-9]') jobs)"
}

remove_crons() {
    step "Removing crontab entries"
    if $DRY_RUN; then
        dry "Would remove cron block between ${CRON_MARKER_START} and ${CRON_MARKER_END}"
        return
    fi

    local existing
    existing=$(crontab -l 2>/dev/null || true)

    if echo "$existing" | grep -q "$CRON_MARKER_START"; then
        local cleaned
        cleaned=$(echo "$existing" | strip_spxer_crons)
        if [ -z "$(echo "$cleaned" | tr -d '[:space:]')" ]; then
            crontab -r 2>/dev/null || true
            info "Crontab cleared (was only SPXer entries)"
        else
            echo "$cleaned" | crontab -
            info "SPXer cron entries removed"
        fi
    else
        warn "No SPXer cron entries found (already removed)"
    fi
}

# ── Backup directory ─────────────────────────────────────────────────

create_backup_dir() {
    step "Creating backup directory at ${BACKUP_DIR}"
    if $DRY_RUN; then
        dry "Would run: mkdir -p ${BACKUP_DIR}"
        return
    fi
    mkdir -p "$BACKUP_DIR"
    info "Backup directory ready"
}

remove_backup_dir() {
    step "Backup directory at ${BACKUP_DIR}"
    if $DRY_RUN; then
        dry "Would leave backup directory in place (contains data)"
        return
    fi
    warn "Leaving backup directory in place (may contain backups)"
}

# ── Verify ───────────────────────────────────────────────────────────

verify() {
    echo ""
    step "Verification"
    echo ""

    echo "--- Crontab ---"
    crontab -l 2>/dev/null || echo "(empty)"
    echo ""

    echo "--- Logrotate (${LOGROTATE_CONF}) ---"
    if [ -f "$LOGROTATE_CONF" ]; then
        cat "$LOGROTATE_CONF"
    else
        echo "(not installed)"
    fi
    echo ""

    echo "--- Backup directory ---"
    if [ -d "$BACKUP_DIR" ]; then
        echo "${BACKUP_DIR} exists"
        ls -la "$BACKUP_DIR" 2>/dev/null || true
    else
        echo "${BACKUP_DIR} does not exist"
    fi
}

# ── Main ─────────────────────────────────────────────────────────────

echo "========================================"
echo "  SPXer Housekeeping Setup"
echo "========================================"
echo ""

if $DRY_RUN; then
    echo "  Mode: DRY RUN (no changes will be made)"
elif $UNINSTALL; then
    echo "  Mode: UNINSTALL"
else
    echo "  Mode: INSTALL"
fi
echo ""

if $UNINSTALL; then
    remove_crons
    remove_logrotate
    remove_backup_dir
    echo ""
    info "Uninstall complete"
    if ! $DRY_RUN; then
        verify
    fi
    exit 0
fi

# Preflight checks
if ! command -v sqlite3 &>/dev/null; then
    echo "ERROR: sqlite3 not found. Install with: sudo apt install sqlite3"
    exit 1
fi

if [ ! -f "$DB_PATH" ]; then
    warn "Database not found at ${DB_PATH} — crons will fail until it exists"
fi

create_backup_dir
install_logrotate
install_crons

echo ""
info "All housekeeping installed"

if ! $DRY_RUN; then
    verify
fi
