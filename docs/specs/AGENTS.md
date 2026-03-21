<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# docs/specs — Architecture Specifications

## Purpose

Comprehensive architecture and design specifications for the SPXer system. Reference material explaining system design, data flows, and key architectural decisions.

## Key Files

| File | Description |
|------|-------------|
| `2026-03-18-spxer-design.md` | Full system architecture spec — data pipeline, indicator engine, regime classifier, two-tier judgment system, contract model |

## For AI Agents

### Working In This Directory

1. **Read before modifying core architecture** — Design spec explains the rationale for two-tier judgment, sticky band model, and narrative-driven context
2. **Update spec if behavior changes** — If you modify regime classification, indicator computation, or judgment flow, update the spec
3. **Reference from CLAUDE.md** — Major architectural decisions documented here should be linked from project CLAUDE.md

## Design Topics Covered

The main architecture spec includes:

- **Data Pipeline** — Providers → Bar Builder → Indicators → Storage → Server
- **Indicator Engine** — Incremental (state-based) vs batch computation, Tier 1/2 indicators
- **Regime Classifier** — Time-of-day tags, trend detection, signal gates
- **Two-Tier Judgment** — Scanners (Tier 1) vs Judges (Tier 2), escalation thresholds
- **Market Narrative** — Rolling context, trajectory tracking, overnight setup
- **Contract Tracking** — Sticky band model, state transitions (UNSEEN → ACTIVE → STICKY → EXPIRED)
- **Strike Selection** — Deterministic OTM selection, price range, distance OTM
- **Risk Management** — Daily loss limits, position limits, time cutoffs

<!-- MANUAL: Add spec-specific notes or design decision references below -->
