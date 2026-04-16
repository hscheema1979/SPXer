#!/bin/bash
#
# claude-monitor.sh — Comprehensive system monitor loop
# Checks every 5 minutes for ~2 hours, logs to logs/claude-monitor.log
#

set -uo pipefail
cd /home/ubuntu/SPXer

LOG="logs/claude-monitor.log"
ITERATIONS=24      # 24 × 5min = 2 hours
INTERVAL=300       # 5 minutes

mkdir -p logs

log() {
  local ts=$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S ET')
  echo "[$ts] $*" >> "$LOG"
  echo "[$ts] $*"
}

separator() {
  log "════════════════════════════════════════════════════════════════"
}

check_pm2() {
  log "── PM2 Process Status ──"
  local procs=("spxer" "spxer-agent" "spxer-xsp" "account-monitor" "spxer-watchdog" "replay-viewer" "spxer-dashboard")
  for p in "${procs[@]}"; do
    local status=$(pm2 show "$p" 2>/dev/null | grep "status" | head -1 | awk '{print $4}')
    local uptime=$(pm2 show "$p" 2>/dev/null | grep "uptime" | head -1 | awk '{print $4}')
    local restarts=$(pm2 show "$p" 2>/dev/null | grep "restarts" | head -1 | awk '{print $4}')
    local mem=$(pm2 show "$p" 2>/dev/null | grep "heap size" | head -1 | awk '{print $5 $6}')
    if [ -z "$status" ]; then
      status="not found"
    fi
    log "  $p: $status (up: $uptime, restarts: $restarts)"

    # Alert on unexpected states
    case "$p" in
      spxer)
        if [ "$status" != "online" ]; then
          log "  ⚠️  ALERT: Data service is DOWN!"
        fi
        ;;
      spxer-xsp)
        # Check if during market hours (9:30-16:00 ET)
        local hour=$(TZ=America/New_York date +%-H)
        local min=$(TZ=America/New_York date +%-M)
        local et_mins=$((hour * 60 + min))
        if [ "$et_mins" -ge 570 ] && [ "$et_mins" -lt 960 ] && [ "$status" != "online" ]; then
          log "  ⚠️  ALERT: XSP agent is DOWN during market hours!"
        fi
        ;;
    esac
  done
}

check_data_service() {
  log "── Data Service Health ──"
  local health=$(curl -s --max-time 10 http://localhost:3600/health 2>/dev/null)
  if [ -z "$health" ]; then
    log "  ⚠️  ALERT: Data service not responding!"
    return
  fi

  local status=$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  local uptime=$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['uptimeSec'])" 2>/dev/null)
  log "  Status: $status, Uptime: ${uptime}s"

  # Check providers
  for provider in tradier yahoo tvScreener option-stream tradier-options; do
    local prov_healthy=$(echo "$health" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=d.get('providers',{}).get('$provider',{})
print(f\"healthy={p.get('healthy','?')}, staleSec={p.get('staleSec','?')}, failures={p.get('consecutiveFailures','?')}\")
" 2>/dev/null)
    if [ -n "$prov_healthy" ]; then
      log "  Provider $provider: $prov_healthy"
    fi
  done

  # Check SPX data freshness
  local spx_stale=$(echo "$health" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('data',{}).get('SPX',{}).get('staleSec',0)
print(s)
" 2>/dev/null)
  log "  SPX data staleness: ${spx_stale}s"
  if [ -n "$spx_stale" ] && [ "$spx_stale" -gt 120 ] 2>/dev/null; then
    log "  ⚠️  ALERT: SPX data very stale (${spx_stale}s)!"
  fi
}

check_agent_status() {
  log "── Agent Status ──"
  local agent_status=$(curl -s --max-time 10 http://localhost:3600/agent/status 2>/dev/null)
  if [ -z "$agent_status" ]; then
    log "  Agent status endpoint not available"
    return
  fi

  local spx_price=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('spxPrice','?'))" 2>/dev/null)
  local open_pos=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('openPositions','?'))" 2>/dev/null)
  local daily_pnl=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dailyPnL','?'))" 2>/dev/null)
  local mode=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null)
  local paper=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('paper','?'))" 2>/dev/null)
  local last_action=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastAction','?'))" 2>/dev/null)
  local reasoning=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('lastReasoning','?'))" 2>/dev/null)
  local mins_to_close=$(echo "$agent_status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('minutesToClose','?'))" 2>/dev/null)

  log "  SPX: $spx_price | Mode: $mode | Paper: $paper"
  log "  Open positions: $open_pos | Daily P&L: \$$daily_pnl | Minutes to close: $mins_to_close"
  log "  Last action: $last_action"
  log "  Reasoning: $reasoning"

  # Alert on daily loss
  if [ -n "$daily_pnl" ] && [ "$daily_pnl" != "?" ]; then
    local loss_threshold=-300
    if (( $(echo "$daily_pnl < $loss_threshold" | bc -l 2>/dev/null) )); then
      log "  ⚠️  ALERT: Daily P&L ($daily_pnl) exceeds loss threshold ($loss_threshold)!"
    fi
  fi
}

check_broker_positions() {
  log "── Broker Positions ──"
  # Check both accounts for open positions
  for account in 6YA51425 6YA58635; do
    local label="SPX"
    [ "$account" = "6YA58635" ] && label="XSP"

    local token=$(grep TRADIER_TOKEN /home/ubuntu/SPXer/.env 2>/dev/null | head -1 | cut -d= -f2)
    if [ -z "$token" ]; then
      log "  Cannot check broker — no TRADIER_TOKEN"
      return
    fi

    local positions=$(curl -s --max-time 10 \
      -H "Authorization: Bearer $token" \
      -H "Accept: application/json" \
      "https://api.tradier.com/v1/accounts/$account/positions" 2>/dev/null)

    local pos_count=$(echo "$positions" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=d.get('positions',{})
if p == 'null' or not p:
    print(0)
else:
    pos=p.get('position',[])
    if isinstance(pos, dict): pos=[pos]
    print(len(pos))
" 2>/dev/null)

    if [ "$pos_count" = "0" ] || [ -z "$pos_count" ]; then
      log "  $label ($account): No open positions"
    else
      log "  $label ($account): $pos_count open position(s)"
      echo "$positions" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=d.get('positions',{}).get('position',[])
if isinstance(p, dict): p=[p]
for pos in p:
    print(f\"    {pos.get('symbol','?')}: qty={pos.get('quantity','?')}, cost={pos.get('cost_basis','?')}\")
" 2>/dev/null >> "$LOG"
    fi

    # Check open orders
    local orders=$(curl -s --max-time 10 \
      -H "Authorization: Bearer $token" \
      -H "Accept: application/json" \
      "https://api.tradier.com/v1/accounts/$account/orders" 2>/dev/null)

    local open_orders=$(echo "$orders" | python3 -c "
import sys,json
d=json.load(sys.stdin)
o=d.get('orders',{})
if o == 'null' or not o:
    print(0)
else:
    ol=o.get('order',[])
    if isinstance(ol, dict): ol=[ol]
    active=[x for x in ol if x.get('status') in ('open','pending','partially_filled')]
    print(len(active))
    for a in active:
        print(f\"    Order #{a.get('id','?')}: {a.get('side','?')} {a.get('quantity','?')} {a.get('option_symbol',a.get('symbol','?'))} @ {a.get('price',a.get('stop_price','market'))} [{a.get('status','?')}]\")
" 2>/dev/null)

    local order_count=$(echo "$open_orders" | head -1)
    if [ "$order_count" = "0" ] || [ -z "$order_count" ]; then
      log "  $label ($account): No open orders"
    else
      log "  $label ($account): $order_count open order(s)"
      echo "$open_orders" | tail -n +2 >> "$LOG"
    fi
  done
}

check_watchdog() {
  log "── Watchdog Status ──"
  if [ -f "logs/watchdog-status.json" ]; then
    local wd=$(cat logs/watchdog-status.json 2>/dev/null)
    local wd_healthy=$(echo "$wd" | python3 -c "import sys,json; print(json.load(sys.stdin).get('healthy','?'))" 2>/dev/null)
    local wd_actions=$(echo "$wd" | python3 -c "import sys,json; a=json.load(sys.stdin).get('actions',[]); print(', '.join(a) if a else 'none')" 2>/dev/null)
    log "  Healthy: $wd_healthy, Recent actions: $wd_actions"
  else
    log "  No watchdog status file"
  fi
}

check_recent_signals() {
  log "── Recent Signals ──"
  local signal=$(curl -s --max-time 10 http://localhost:3600/signal/latest 2>/dev/null)
  if [ -n "$signal" ]; then
    echo "$signal" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('signal')
if s:
    print(f\"  Direction: {s.get('direction','?')}, Price: {s.get('price','?')}, TS: {s.get('ts','?')}\")
else:
    print('  No signal')
" 2>/dev/null >> "$LOG"
  fi
}

check_memory() {
  log "── System Resources ──"
  local mem_usage=$(free -h | awk '/^Mem:/ {printf "%s/%s (%.0f%%)", $3, $2, $3/$2*100}')
  local disk_usage=$(df -h /home/ubuntu | awk 'NR==2 {printf "%s/%s (%s)", $3, $2, $5}')
  local db_size=$(du -sh /home/ubuntu/SPXer/data/spxer.db 2>/dev/null | awk '{print $1}')
  log "  Memory: $mem_usage"
  log "  Disk: $disk_usage"
  log "  DB size: $db_size"
}

check_recent_errors() {
  log "── Recent Errors (last 5 min) ──"
  local since=$(date -d '5 minutes ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date '+%Y-%m-%d %H:%M:%S')

  # Check XSP error log
  local xsp_errors=$(tail -20 /home/ubuntu/.pm2/logs/spxer-xsp-error.log 2>/dev/null | grep -c "❌\|Error\|FATAL" 2>/dev/null || echo "0")
  local spxer_errors=$(tail -20 /home/ubuntu/.pm2/logs/spxer-error.log 2>/dev/null | grep -c "Error\|FATAL" 2>/dev/null || echo "0")
  local watchdog_errors=$(tail -20 /home/ubuntu/.pm2/logs/watchdog-error.log 2>/dev/null | grep -c "UNHEALTHY\|Killed" 2>/dev/null || echo "0")

  log "  XSP agent errors (recent): $xsp_errors"
  log "  Data service errors (recent): $spxer_errors"
  log "  Watchdog alerts (recent): $watchdog_errors"
}

# ── Main Loop ─────────────────────────────────────────────────────

log ""
separator
log "🔍 Claude Monitor Starting — $ITERATIONS checks, ${INTERVAL}s interval"
log "   Market hours remaining: ~$(( (960 - $(TZ=America/New_York date +%-H) * 60 - $(TZ=America/New_York date +%-M)) )) minutes"
separator

for ((i=1; i<=ITERATIONS; i++)); do
  separator
  log "CHECK $i/$ITERATIONS"

  check_pm2
  check_data_service
  check_agent_status
  check_broker_positions
  check_watchdog
  check_recent_signals
  check_recent_errors
  check_memory

  separator
  log "Next check in ${INTERVAL}s..."
  log ""

  if [ "$i" -lt "$ITERATIONS" ]; then
    sleep "$INTERVAL"
  fi
done

log "Monitor complete — $ITERATIONS checks done."
