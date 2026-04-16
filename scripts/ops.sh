#!/usr/bin/env bash
# SPXer Ops CLI — unified command interface for monitoring and managing the trading system.
# Usage: ./scripts/ops.sh <command> [args]
#
# Commands:
#   status            Full system overview (processes, pipeline health, positions, P&L)
#   agents            Agent detail: cycles, signals, positions, risk state
#   health            Data pipeline: providers, staleness, WAL, circuit breakers
#   pipeline          Per-stage pipeline counters (bar validation, indicators, DB writes)
#   logs [process]    Tail PM2 logs (spxer | agent | xsp | monitor | dashboard | all)
#   errors [n]        Last N error lines across all PM2 logs (default 20)
#   restart <target>  Safe restart: spxer | agent | xsp | monitor | dashboard | all
#   stop <target>     Stop a process
#   pause             Pause trading (set maintenance mode)
#   resume            Resume trading (clear maintenance mode)
#   config list       List all saved trading configs
#   config show <id>  Show config JSON
#   config diff <a> <b>  Diff two configs side-by-side
#   alerts            Recent alert history from alerter
#   db                Database stats: size, WAL, row counts
#   processes         PM2 process table

set -euo pipefail

SPXER_DIR="${SPXER_DIR:-/home/ubuntu/SPXer}"
DATA_URL="${DATA_URL:-http://localhost:3600}"
DB_PATH="${DB_PATH:-$SPXER_DIR/data/spxer.db}"
LOGS_DIR="$SPXER_DIR/logs"
MAINTENANCE_FILE="$LOGS_DIR/agent-maintenance.json"

# ── Colours ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}✅ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠️  $*${RESET}"; }
err()  { echo -e "${RED}🚨 $*${RESET}"; }
hdr()  { echo -e "\n${BOLD}${CYAN}── $* ──${RESET}"; }

# ── Helpers ───────────────────────────────────────────────────────────────────
api() {
  curl -sf "$DATA_URL$1" 2>/dev/null || echo 'null'
}

pm2_status() {
  pm2 jlist 2>/dev/null | python3 -c "
import sys, json
procs = json.load(sys.stdin)
for p in procs:
    name   = p['name']
    status = p['pm2_env']['status']
    mem    = p.get('monit', {}).get('memory', 0) // 1024 // 1024
    restarts = p['pm2_env'].get('restart_time', 0)
    uptime_ms = p['pm2_env'].get('pm_uptime', 0)
    uptime_s  = (int(__import__('time').time()*1000) - uptime_ms) // 1000 if uptime_ms else 0
    uptime_str = f'{uptime_s//3600}h{(uptime_s%3600)//60}m' if uptime_s > 0 else '—'
    flag = '✅' if status == 'online' else '🔴'
    print(f'  {flag}  {name:<22} {status:<10} mem={mem}MB  restarts={restarts}  up={uptime_str}')
" 2>/dev/null || echo "  (pm2 unavailable)"
}

agent_status() {
  local file="$LOGS_DIR/agent-status-${1}.json"
  if [[ ! -f "$file" ]]; then echo "  (no status file)"; return; fi
  python3 -c "
import json, time
with open('$file') as f: a = json.load(f)
age = int(time.time()) - a.get('ts', 0) // 1000
print(f'  Mode:       {a.get(\"mode\",\"?\")}')
print(f'  SPX Price:  {a.get(\"spxPrice\",\"?\")}')
print(f'  Positions:  {a.get(\"openPositions\",0)}  DailyPnL: \${a.get(\"dailyPnL\",0):.2f}')
print(f'  Last Action:{a.get(\"lastAction\",\"?\")}')
print(f'  Status:     {a.get(\"lastReasoning\",\"?\")[:80]}')
print(f'  Heartbeat:  {age}s ago')
" 2>/dev/null || echo "  (parse error)"
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_status() {
  hdr "PROCESSES"
  pm2_status

  hdr "PIPELINE"
  api /health | python3 -c "
import sys, json
h = json.load(sys.stdin)
if h == 'null': print('  ❌ Data service not responding'); exit()
s = h.get('status','?')
flag = '✅' if s == 'healthy' else '⚠️' if s == 'degraded' else '🔴'
print(f'  {flag}  Status: {s}  Mode: {h.get(\"mode\",\"?\")}  Uptime: {h.get(\"uptimeSec\",0)}s')
print(f'  SPX: {h.get(\"lastSpxPrice\",\"none\")}  Contracts: {h.get(\"activeContracts\",0)}/{h.get(\"trackedContracts\",0)}')
print(f'  DB: {h[\"db\"][\"sizeMb\"]}MB  WAL: {h[\"db\"][\"walSizeMb\"]}MB')
for pname, p in h.get('providers', {}).items():
    pflag = '✅' if p.get('healthy') else '🔴'
    stale = p.get('staleSec', 0)
    print(f'  {pflag}  {pname:<20} stale={stale}s  failures={p.get(\"consecutiveFailures\",0)}')
" 2>/dev/null

  hdr "AGENTS"
  echo -e "  ${BOLD}SPX Agent:${RESET}"
  agent_status "spx"
  echo -e "\n  ${BOLD}XSP Agent:${RESET}"
  agent_status "xsp"

  hdr "MAINTENANCE"
  if [[ -f "$MAINTENANCE_FILE" ]]; then
    warn "Maintenance mode ACTIVE"
    cat "$MAINTENANCE_FILE" | python3 -c "import sys,json; m=json.load(sys.stdin); print(f'  Reason: {m.get(\"reason\",\"?\")}  Set at: {m.get(\"ts\",\"?\")}')" 2>/dev/null
  else
    ok "No maintenance mode active"
  fi
}

cmd_agents() {
  hdr "SPX AGENT"
  agent_status "spx"
  hdr "XSP AGENT"
  agent_status "xsp"
  hdr "RECENT ACTIVITY"
  api /agent/activity?n=10 | python3 -c "
import sys, json
acts = json.load(sys.stdin)
if not isinstance(acts, list): print('  (no activity)'); exit()
for a in acts[-10:]:
    print(f'  [{a.get(\"timeET\",\"?\")}] {a.get(\"event\",\"?\")} — {a.get(\"summary\",\"?\")[:80]}')
" 2>/dev/null
}

cmd_health() {
  hdr "PIPELINE HEALTH"
  api /health | python3 -c "
import sys, json
h = json.load(sys.stdin)
if h == 'null': print('  ❌ Unreachable'); exit()
print(f'  Status: {h.get(\"status\",\"?\")}  Mode: {h.get(\"mode\",\"?\")}  Uptime: {h.get(\"uptimeSec\",0)}s')
print(f'  SPX: {h.get(\"lastSpxPrice\",\"none\")}')
print()
print('  Providers:')
for n, p in h.get('providers', {}).items():
    flag = '✅' if p.get('healthy') else '🔴'
    print(f'    {flag} {n:<22} stale={p.get(\"staleSec\",0)}s  failures={p.get(\"consecutiveFailures\",0)}')
print()
db = h.get('db', {})
wal = db.get('walSizeMb', 0)
wflag = '✅' if wal < 50 else '⚠️' if wal < 200 else '🔴'
print(f'  DB: {db.get(\"sizeMb\",0)}MB  WAL: {wflag} {wal}MB')
" 2>/dev/null
  hdr "CIRCUIT BREAKERS"
  api /pipeline/health | python3 -c "
import sys, json
h = json.load(sys.stdin)
if h == 'null': print('  (unavailable)'); exit()
for n, s in h.get('circuitBreakers', {}).items():
    flag = '✅' if s == 'closed' else '⚠️' if s == 'half-open' else '🔴'
    print(f'  {flag} {n:<22} {s}')
" 2>/dev/null
}

cmd_pipeline() {
  hdr "PIPELINE STAGE COUNTERS"
  api /pipeline/health | python3 -c "
import sys, json
h = json.load(sys.stdin)
if h == 'null': print('  (unavailable)'); exit()
print(f'  Mode: {h.get(\"currentMode\",\"?\")}  Uptime: {h.get(\"uptimeSec\",0)}s')
mt = h.get('lastModeTransition')
if mt: print(f'  Last transition: {mt[\"from\"]} → {mt[\"to\"]}')
print()
print('  Bar Builder:')
bb = h.get('barBuilder', {})
print(f'    Built={bb.get(\"barsBuilt\",0)}  Synthetic={bb.get(\"syntheticBars\",0)}  Interpolated={bb.get(\"gapsInterpolated\",0)}  Stale={bb.get(\"gapsStale\",0)}  Rejected={bb.get(\"barsRejected\",0)}')
print()
print('  Indicators:')
ind = h.get('indicators', {})
print(f'    Computed={ind.get(\"computed\",0)}  NaN-rejected={ind.get(\"nanRejected\",0)}  Seeds={ind.get(\"seedsCompleted\",0)}/{ind.get(\"seedsFailed\",0)+ind.get(\"seedsCompleted\",0)}')
print()
print('  DB Writes:')
db = h.get('db', {})
print(f'    Attempted={db.get(\"writesAttempted\",0)}  Succeeded={db.get(\"writesSucceeded\",0)}  Failed={db.get(\"writesFailed\",0)}  WAL@checkpoint={db.get(\"walSizeMbAtLastCheckpoint\",0)}MB')
print()
print('  Signals:')
sig = h.get('signals', {})
print(f'    Detected={sig.get(\"detected\",0)}  Synthetic-filtered={sig.get(\"syntheticFiltered\",0)}')
ls = sig.get('lastSignal')
if ls: print(f'    Last: {ls[\"symbol\"]} {ls[\"direction\"]} @ {ls[\"ts\"]}')
" 2>/dev/null
}

cmd_logs() {
  local target="${1:-spxer}"
  local process_map=(
    "spxer:spxer"
    "agent:spxer-agent"
    "xsp:spxer-xsp"
    "monitor:account-monitor"
    "dashboard:spxer-dashboard"
    "viewer:replay-viewer"
  )
  local pm2_name="$target"
  for mapping in "${process_map[@]}"; do
    local alias="${mapping%%:*}"
    local name="${mapping##*:}"
    if [[ "$alias" == "$target" ]]; then pm2_name="$name"; break; fi
  done

  if [[ "$target" == "all" ]]; then
    for mapping in "${process_map[@]}"; do
      local name="${mapping##*:}"
      echo -e "\n${BOLD}=== $name ===${RESET}"
      pm2 logs "$name" --lines 20 2>&1 | tail -20 || true
    done
  else
    pm2 logs "$pm2_name" --lines 50 2>&1 | tail -60
  fi
}

cmd_errors() {
  local n="${1:-20}"
  hdr "RECENT ERRORS (last $n)"
  for logfile in ~/.pm2/logs/*-error.log; do
    local name
    name=$(basename "$logfile" -error.log)
    local errors
    errors=$(tail -50 "$logfile" 2>/dev/null | grep -i "error\|Error\|FAIL\|CRITICAL" | tail -5)
    if [[ -n "$errors" ]]; then
      echo -e "\n  ${BOLD}$name:${RESET}"
      echo "$errors" | sed 's/^/    /'
    fi
  done
}

cmd_restart() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    err "Usage: ops restart <spxer|agent|xsp|monitor|dashboard|all>"
    exit 1
  fi

  case "$target" in
    agent|xsp)
      local pm2_name="spxer-$target"
      warn "Safe-restarting $pm2_name via agent-ctl..."
      bash "$SPXER_DIR/scripts/agent-ctl.sh" restart "$pm2_name" 2>/dev/null || pm2 restart "$pm2_name"
      ok "$pm2_name restarted"
      ;;
    spxer|monitor|dashboard|viewer)
      local pm2_name
      pm2_name=$(case "$target" in spxer) echo spxer;; monitor) echo account-monitor;; dashboard) echo spxer-dashboard;; viewer) echo replay-viewer;; esac)
      pm2 restart "$pm2_name"
      ok "$pm2_name restarted"
      ;;
    all)
      warn "Restarting ALL processes..."
      pm2 restart all
      ok "All processes restarted"
      ;;
    *)
      err "Unknown target: $target"
      exit 1
      ;;
  esac
}

cmd_stop() {
  local target="${1:-}"
  case "$target" in
    agent|xsp)
      local pm2_name="spxer-$target"
      warn "Safe-stopping $pm2_name..."
      bash "$SPXER_DIR/scripts/agent-ctl.sh" stop "$pm2_name" 2>/dev/null || pm2 stop "$pm2_name"
      ok "$pm2_name stopped"
      ;;
    *)
      pm2 stop "${1:-}" && ok "$1 stopped"
      ;;
  esac
}

cmd_pause() {
  local reason="${1:-manual pause via ops.sh}"
  echo "{\"reason\":\"$reason\",\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$MAINTENANCE_FILE"
  ok "Trading paused. Maintenance file written: $MAINTENANCE_FILE"
  warn "Run 'ops.sh resume' to clear"
}

cmd_resume() {
  if [[ -f "$MAINTENANCE_FILE" ]]; then
    rm -f "$MAINTENANCE_FILE"
    ok "Maintenance cleared — trading resumed"
  else
    echo "No maintenance file found (trading was not paused)"
  fi
}

cmd_config_list() {
  hdr "SAVED CONFIGS"
  sqlite3 "$DB_PATH" "SELECT id, json_extract(config_json,'$.name') as name, created_at FROM replay_configs ORDER BY created_at DESC LIMIT 20;" 2>/dev/null \
    | awk -F'|' '{printf "  %-36s  %-30s  %s\n", $1, $2, $3}' \
    || echo "  (sqlite3 not available or no configs found)"
}

cmd_config_show() {
  local id="${1:-}"
  if [[ -z "$id" ]]; then err "Usage: ops config show <id>"; exit 1; fi
  sqlite3 "$DB_PATH" "SELECT config_json FROM replay_configs WHERE id='$id';" 2>/dev/null \
    | python3 -m json.tool 2>/dev/null \
    || echo "Config not found: $id"
}

cmd_config_diff() {
  local a="${1:-}" b="${2:-}"
  if [[ -z "$a" || -z "$b" ]]; then err "Usage: ops config diff <id-a> <id-b>"; exit 1; fi
  local fa fb
  fa=$(mktemp) fb=$(mktemp)
  sqlite3 "$DB_PATH" "SELECT config_json FROM replay_configs WHERE id='$a';" | python3 -m json.tool > "$fa" 2>/dev/null
  sqlite3 "$DB_PATH" "SELECT config_json FROM replay_configs WHERE id='$b';" | python3 -m json.tool > "$fb" 2>/dev/null
  diff --color=always "$fa" "$fb" || true
  rm -f "$fa" "$fb"
}

cmd_db() {
  hdr "DATABASE"
  api /health | python3 -c "
import sys,json; h=json.load(sys.stdin)
db=h.get('db',{})
print(f'  Main DB: {db.get(\"sizeMb\",0)} MB')
wal=db.get('walSizeMb',0)
flag = '✅' if wal < 50 else '⚠️' if wal < 200 else '🔴'
print(f'  WAL:     {flag} {wal} MB')
" 2>/dev/null
  echo
  sqlite3 "$DB_PATH" "
    SELECT 'bars' as table_name, count(*) as rows FROM bars
    UNION ALL SELECT 'contracts', count(*) FROM contracts
    UNION ALL SELECT 'replay_configs', count(*) FROM replay_configs
    UNION ALL SELECT 'replay_runs', count(*) FROM replay_runs
    UNION ALL SELECT 'replay_results', count(*) FROM replay_results;
  " 2>/dev/null | awk -F'|' '{printf "  %-25s %s rows\n", $1, $2}' || echo "  (sqlite3 unavailable)"
}

cmd_processes() {
  pm2 list 2>/dev/null || echo "PM2 unavailable"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
CMD="${1:-status}"
shift || true

case "$CMD" in
  status)        cmd_status ;;
  agents)        cmd_agents ;;
  health)        cmd_health ;;
  pipeline)      cmd_pipeline ;;
  logs)          cmd_logs "${1:-spxer}" ;;
  errors)        cmd_errors "${1:-20}" ;;
  restart)       cmd_restart "${1:-}" ;;
  stop)          cmd_stop "${1:-}" ;;
  pause)         cmd_pause "${1:-}" ;;
  resume)        cmd_resume ;;
  config)
    subcmd="${1:-list}"; shift || true
    case "$subcmd" in
      list)   cmd_config_list ;;
      show)   cmd_config_show "${1:-}" ;;
      diff)   cmd_config_diff "${1:-}" "${2:-}" ;;
      *)      err "Unknown config subcommand: $subcmd" ;;
    esac ;;
  db)            cmd_db ;;
  processes)     cmd_processes ;;
  help|--help|-h)
    grep '^#' "$0" | head -20 | sed 's/^# //'
    ;;
  *)
    err "Unknown command: $CMD"
    echo "Run 'ops.sh help' for usage"
    exit 1
    ;;
esac
