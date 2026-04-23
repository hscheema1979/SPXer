#!/bin/bash
SPXER_URL="${SPXER_URL:-http://localhost:3600}"
AGENTS=("runner-itm5" "runner-atm" "runner-otm5" "scalp-itm5" "scalp-atm" "scalp-otm5")
LOGFILE="/home/ubuntu/SPXer/logs/status-monitor.log"

while true; do
  TS=$(date '+%H:%M:%S')
  echo "" >> "$LOGFILE"
  echo "=== $TS ===" >> "$LOGFILE"

  HEALTH=$(curl -s "$SPXER_URL/health" 2>/dev/null)
  SPX_PRICE=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.lastSpxPrice??'?')}catch(e){console.log('?')}})" 2>/dev/null || echo "?")
  TRACKED=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.trackedContracts??'?')}catch(e){console.log('?')}})" 2>/dev/null || echo "?")
  HEALTH_STATUS=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.status??'?')}catch(e){console.log('?')}})" 2>/dev/null || echo "?")
  echo "SPXER | spx=$SPX_PRICE | tracked=$TRACKED | $HEALTH_STATUS" >> "$LOGFILE"

  for AGENT in "${AGENTS[@]}"; do
    FILE="/home/ubuntu/SPXer/logs/agent-status-$AGENT.json"
    if [ -f "$FILE" ]; then
      node -e "
const d=require('fs').readFileSync('$FILE','utf8');
const j=JSON.parse(d);
console.log('$AGENT | c='+(j.cycle??0)+' spx='+(j.spxPrice??0).toFixed(2)+' open='+(j.openPositions??0)+' pnl=\$'+(j.dailyPnL??0).toFixed(0)+' '+(j.lastAction??'?')+' '+(j.timeET??''));
" >> "$LOGFILE" 2>&1
    fi
  done

  pm2 jlist 2>/dev/null | node -e "
let data='';
process.stdin.on('data',c=>data+=c);
process.stdin.on('end',()=>{
  JSON.parse(data).filter(p=>['spxer','runner','scalp'].some(x=>p.name.includes(x))).forEach(p=>{
    const up=p.pm2_env?.pm_uptime?Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)+'s':'?';
    const mem=Math.round((p.monit?.memory||0)/1024/1024)+'MB';
    console.log(p.name.padEnd(14)+(p.pm2_env?.status||'?').padEnd(10)+up.padEnd(8)+mem);
  });
});
" >> "$LOGFILE" 2>&1

  sleep 120
done

  pm2 jlist 2>/dev/null | node -e "
let data='';
process.stdin.on('data',c=>data+=c);
process.stdin.on('end',()=>{
  JSON.parse(data).filter(p=>['spxer','runner','scalp'].some(x=>p.name.includes(x))).forEach(p=>{
    const up=p.pm2_env?.pm_uptime?Math.round((Date.now()-p.pm2_env.pm_uptime)/1000)+'s':'?';
    const mem=Math.round((p.monit?.memory||0)/1024/1024)+'MB';
    console.log(p.name.padEnd(14)+(p.pm2_env?.status||'?').padEnd(10)+up.padEnd(8)+mem);
  });
});
" >> "$LOGFILE" 2>&1

  sleep 120
done