# gate evidence — FR-001 → test

- run: 2026-08-29T15:58:46.709Z
- head before: 78d7f3ca2 on feat/multi-dte-credit-sweep
- checks: 12/12 passed

## CHECK: npm run build
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: npm run test
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: npx vitest run tests/diag/sweep-parallel.test.ts
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: npx vitest run tests/ops/eod-lock.test.ts
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: npx vitest run tests/ops/pipeline-health.test.ts
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: tail -400 logs/eod-pipeline.log | grep -c '=== EOD pipeline done ==='
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: tail -400 logs/eod-pipeline.log | grep -E '\[(SPX|NDX)\] incremental OK'
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: grep -q 'skip — previous run still active' logs/eod-pipeline.log
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: bash scripts/ops/sweep-reaper.sh --dry-run
- exit 0 — PASS
- EXPECT ok no processes were killed

## CHECK: grep -q 'exec 9<>"$LOCK"' scripts/ops/eod-pipeline.sh
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: test -z "$(pm2 jlist 2>/dev/null | grep -o 'replay2\?-viewer' | head -1)"
- exit 0 — PASS
- EXPECT ok exit 0

## CHECK: test -z "$(ss -tln 2>/dev/null | grep ':3602' | head -1)"
- exit 0 — PASS
- EXPECT ok exit 0

