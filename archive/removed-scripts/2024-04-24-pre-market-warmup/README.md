# Archived Scripts - Pre-Market Warmup Implementation

**Archive Date**: 2024-04-24
**Reason**: Replaced by 17-tier staged verification approach

## What Was Archived

### Placeholder Scripts (15 files)
These were part of the original `daily-checklist-runner.sh` plan but never implemented:
- `check-data-quality.sh`
- `check-databases.sh`
- `check-providers.sh`
- `validate-configs.sh`
- `reconcile-positions.sh`
- `test-alerts.sh`
- `test-signal-pipeline.sh`
- `final-go-check.sh`
- `post-market-reconcile.sh`
- `archive-day.sh`
- `daily-report.sh`
- `daily-signoff.sh`
- `prepare-tomorrow.sh`
- `shutdown-handler.sh`
- `start-handler.sh`

### Old Setup Script (1 file)
- `setup-8am-automation.sh` (hard-coded 10:15 AM transition)
  → Replaced by: `setup-8am-automation-config-driven.sh`

### Other Old Scripts (3 files)
- `daily-checklist-runner.sh` (referenced placeholder scripts)
- `run-8am-checklist.sh` (monolithic 17-tier script)
- `8am-cron.txt` (old cron examples)

## Replacement Architecture

The old placeholder-based approach was replaced with a **config-driven, staged verification system**:

### New Scripts (Active)
```
scripts/ops/
├── check-early-infrastructure.sh     # 06:00 ET - Tiers 1-5
├── check-data-pipeline.sh            # 07:00 ET - Tiers 6-10
├── check-pre-market-validation.sh    # 07:50 ET - Tiers 11-17
├── start-warmup.sh                    # Standalone warmup starter
├── start-warmup-with-checklist.sh    # Warmup with final validation
├── transition-from-warmup.sh          # Config-driven transition
├── setup-8am-automation-config-driven.sh  # Config-driven cron setup
├── calculate-transition-from-config.sh # Calculate timing from config
└── calculate-warmup-end.sh            # Generic calculator
```

### Key Improvements

1. **No Placeholders** - All checks are fully implemented
2. **Config-Driven** - All timing derived from AGENT_CONFIG_ID
3. **Staged Approach** - Checks spread across pre-market window
4. **Two-Tier Philosophy** - Tool functionality → actual readings

## Why The Old Approach Didn't Work

The original `daily-checklist-runner.sh` tried to do too much in one script:
- Attempted 50+ checks across 5 sections (A1-E2)
- Created placeholders for future implementation
- Became complex and hard to maintain

The new 17-tier approach:
- Focused verification (17 essential tiers)
- Separated into time-appropriate phases
- Fully implemented, no placeholders
- Config-driven timing (not hard-coded)

## Migration Guide

If you need to restore any archived functionality:

1. **Pre-market validation**: Use `check-pre-market-validation.sh` (Tiers 11-17)
2. **Data pipeline checks**: Use `check-data-pipeline.sh` (Tiers 6-10)
3. **Position reconciliation**: This is now in `check-data-pipeline.sh` Tier 8
4. **Config validation**: This is now in `check-early-infrastructure.sh` Tier 5

## Documentation

See:
- `docs/PRE-MARKET-WARMUP.md` - Warmup architecture and usage
- `docs/8AM-AUTOMATION.md` - Daily automation timeline
- `docs/WARMUP-TIME-CALCULATION.md` - Time calculation from config

---

**Archived By**: Claude (Sonnet 4.6)
**Date**: 2024-04-24
**Reason**: Pre-market warmup refactor - replaced by staged 17-tier verification
