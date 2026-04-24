#!/bin/bash
# Tier 1: Service Setup & Runtime Check
# Verifies all services are configured in PM2 and running
# Attempts recovery if services are down

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ PASS${NC}: $1"; }
warn() { echo -e "${YELLOW}⚠️  WARN${NC}: $1"; }
fail() { echo -e "${RED}❌ FAIL${NC}: $1"; }
info() { echo -e "${BLUE}ℹ️  INFO${NC}: $1"; }
section() { echo -e "${BOLD}${CYAN}═══ $1 ═══${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPXER_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
cd "$SPXER_DIR"

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_WARN=0

check_pass() { pass "$1"; TOTAL_PASS=$((TOTAL_PASS + 1)); }
check_fail() { fail "$1"; TOTAL_FAIL=$((TOTAL_FAIL + 1)); }
check_warn() { warn "$1"; TOTAL_WARN=$((TOTAL_WARN + 1)); }

section "TIER 1: SERVICE SETUP & RUNTIME"
echo

# Services to check
SERVICES=("spxer" "event-handler")

for service in "${SERVICES[@]}"; do
    section "Service: $service"
    echo

    # 1. CHECK SETUP: Is service configured in PM2?
    if pm2 describe "$service" &> /dev/null; then
        check_pass "$service configured in PM2"
    else
        check_fail "$service NOT configured in PM2"
        info "  → Fix: Run 'pm2 start <script>' for $service"
        echo
        continue
    fi
    echo

    # 2. CHECK RUNTIME: Is service currently running?
    STATUS=$(pm2 jlist | jq -r ".[] | select(.name==\"$service\") | .pm2_env.status" 2>/dev/null || echo "unknown")

    if [ "$STATUS" = "online" ]; then
        check_pass "$service is RUNNING (status: $STATUS)"

        # Additional health checks for running services
        case "$service" in
            spxer)
                # Check if signal poller is active
                if pm2 logs "$service" --nostream --lines 50 2>&1 | grep -q "SignalPoller.*starting\|SignalPoller.*Started"; then
                    pass "SignalPoller active in $service"
                else
                    warn "SignalPoller may not be active in $service"
                fi

                # Check if HTTP server responding
                if curl -s http://localhost:3600/health > /dev/null 2>&1; then
                    pass "HTTP server responding (port 3600)"
                else
                    warn "HTTP server not responding (port 3600)"
                fi
                ;;

            event-handler)
                # Check if WebSocket connected
                if pm2 logs "$service" --nostream --lines 50 2>&1 | grep -q "WebSocket.*connected\|Connected to ws://"; then
                    pass "WebSocket connected"
                else
                    warn "WebSocket may not be connected (check logs)"
                fi
                ;;
        esac

    elif [ "$STATUS" = "stopped" ]; then
        check_warn "$service is STOPPED (status: $STATUS)"
        echo
        info "Attempting to start $service..."

        # 3. RECOVERY: Try to start the service
        if pm2 start "$service" &> /dev/null; then
            sleep 3

            # Verify it started successfully
            NEW_STATUS=$(pm2 jlist | jq -r ".[] | select(.name==\"$service\") | .pm2_env.status" 2>/dev/null || echo "unknown")
            if [ "$NEW_STATUS" = "online" ]; then
                check_pass "$service started successfully (was stopped, now: $NEW_STATUS)"
            else
                check_fail "$service failed to start (status: $NEW_STATUS)"
                info "  → Check logs: pm2 logs $service --lines 50"
            fi
        else
            check_fail "$service failed to start (pm2 start command failed)"
            info "  → Check logs: pm2 logs $service --lines 50"
            info "  → Check error: pm2 describe $service"
        fi

    elif [ "$STATUS" = "errored" ]; then
        check_fail "$service is ERRORED (status: $STATUS)"
        echo
        info "Attempting to restart $service..."

        # 3. RECOVERY: Try to restart errored service
        pm2 delete "$service" &> /dev/null || true
        sleep 2

        if pm2 start "$service" &> /dev/null; then
            sleep 3

            NEW_STATUS=$(pm2 jlist | jq -r ".[] | select(.name==\"$service\") | .pm2_env.status" 2>/dev/null || echo "unknown")
            if [ "$NEW_STATUS" = "online" ]; then
                check_pass "$service restarted successfully (was errored, now: $NEW_STATUS)"
            else
                check_fail "$service failed to restart (status: $NEW_STATUS)"
                info "  → Check logs: pm2 logs $service --lines 100"
            fi
        else
            check_fail "$service failed to restart (pm2 start command failed)"
            info "  → Check logs: pm2 logs $service --lines 100"
        fi

    else
        check_fail "$service in unexpected state: $STATUS"
        info "  → Check: pm2 describe $service"
    fi

    echo
done

# ============================================================================
# POSITION HANDLER CHECK (if exists)
# ============================================================================

section "Service: position handler (optional)"
echo

if pm2 describe "position-handler" &> /dev/null; then
    check_pass "position-handler configured in PM2"

    POS_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="position-handler") | .pm2_env.status' 2>/dev/null || echo "unknown")
    info "position-handler status: $POS_STATUS"
else
    info "position-handler NOT configured in PM2 (may not be needed)"
fi

echo

# ============================================================================
# SUMMARY
# ============================================================================

section "TIER 1 SUMMARY"
echo
echo "Passed: $TOTAL_PASS"
echo "Warnings: $TOTAL_WARN"
echo "Failed: $TOTAL_FAIL"
echo

if [ $TOTAL_FAIL -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✅ ALL SERVICES CONFIGURED AND RUNNING${NC}"
    exit 0
else
    echo -e "${RED}${BOLD}❌ SERVICE ISSUES DETECTED${NC}"
    echo
    echo "Next steps:"
    echo "  1. Review failed services above"
    echo "  2. Check logs: pm2 logs <service> --lines 100"
    echo "  3. Check errors: pm2 describe <service>"
    echo "  4. Manual restart if needed: pm2 restart <service>"
    exit 1
fi
