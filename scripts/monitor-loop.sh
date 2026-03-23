#!/bin/bash
# SPXer 2-Minute Monitoring Loop
cd /home/ubuntu/SPXer

while true; do
  clear
  printf "╔════════════════════════════════════════════════════════════════════╗\n"
  printf "║  SPXer Status Assessment                                          ║\n"
  printf "║  $(date '+%Y-%m-%d %H:%M:%S') ET                                                   ║\n"
  printf "╚════════════════════════════════════════════════════════════════════╝\n\n"
  
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  printf "│ MARKET DATA\n"
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  sqlite3 data/spxer.db "SELECT '  SPX: $' || ROUND(close, 2) || '  RSI: ' || ROUND(indicators->>'$.rsi14', 2) || '  Time: ' || strftime('%H:%M:%S', datetime(ts, 'unixepoch', 'localtime')) FROM bars WHERE symbol='SPX' AND timeframe='1m' ORDER BY ts DESC LIMIT 1;" 2>/dev/null || echo "  No SPX data"
  
  printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  printf "│ SERVICE STATUS\n"
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  HEALTH=$(curl -s http://localhost:3600/health 2>/dev/null)
  if [ -n "$HEALTH" ]; then
    echo "  ✓ SPXer Service - RUNNING (port 3600)"
    echo "$HEALTH" | jq -r 'to_entries | .[] | "    \(.key): \(.value)"' 2>/dev/null | head -6
  else
    echo "  ✗ SPXer Service - DOWN"
  fi
  pm2 list 2>/dev/null | grep -E "spxer|live-monitor" | awk '{print "  " $2 " - " $12 " (uptime: " $10 ")"}' | head -2
  
  printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  printf "│ TRADING AGENT\n"
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  if [ -f logs/agent-status.json ]; then
    CYCLE=$(jq -r '.cycle // "N/A"' logs/agent-status.json)
    ACTION=$(jq -r '.lastAction // "unknown"' logs/agent-status.json)
    POSITIONS=$(jq -r '.openPositions // 0' logs/agent-status.json)
    PNL=$(jq -r '.dailyPnL // 0' logs/agent-status.json)
    JUDGE=$(jq -r '.judgeCallsToday // 0' logs/agent-status.json)
    NEXT=$(jq -r '.nextCheckSecs // "N/A"' logs/agent-status.json)
    
    printf "  Cycle: %s | Action: %s | Positions: %s\n" "$CYCLE" "$ACTION" "$POSITIONS"
    printf "  Daily P&L: \$%s | Judge Calls: %s | Next check: %ss\n\n" "$PNL" "$JUDGE" "$NEXT"
    
    printf "  Latest Reasoning:\n"
    jq -r '.lastReasoning // "No reasoning"' logs/agent-status.json | fold -w 80 -s | sed 's/^/    /' | head -4
  else
    echo "  ⚠ Agent status not available"
  fi
  
  printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  printf "│ SCANNER ANALYSIS\n"
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  if [ -f logs/agent-status.json ]; then
    jq -r '.scannerReads[]? | select(.read != "" and .read != null) | "  \(.id | ascii_upcase): \(.read[0:100])"' logs/agent-status.json 2>/dev/null | head -5
    SETUP_COUNT=$(jq -r '.scannerReads | map(.setups // 0) | add' logs/agent-status.json 2>/dev/null)
    if [ "$SETUP_COUNT" -gt 0 ]; then
      echo ""
      jq -r '.scannerReads[]? | select(.setups > 0) | .setupDetails[]? | "     → \(.symbol): \(.setupType) (\(.confidence * 100)%)"' logs/agent-status.json 2>/dev/null | head -3
    fi
  else
    echo "  No scanner data"
  fi
  
  printf "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  printf "│ TIMING\n"
  printf "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  if [ -f logs/agent-activity.jsonl ]; then
    NOW=$(date +%s)
    FILE_TIME=$(stat -c %Y logs/agent-activity.jsonl)
    LAST_AGE=$((NOW - FILE_TIME))
    if [ $LAST_AGE -lt 120 ]; then
      printf "  ✓ Last scan: %ds ago\n" $LAST_AGE
    elif [ $LAST_AGE -lt 300 ]; then
      printf "  ⚠ Last scan: %ds ago\n" $LAST_AGE
    else
      printf "  ✗ Last scan: %ds ago (STALE)\n" $LAST_AGE
    fi
  fi
  
  printf "\nNext update in 2 minutes... (Press Ctrl+C to exit)\n\n"
  sleep 120
done
