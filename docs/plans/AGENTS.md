<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# docs/plans — Feature Implementation Plans

## Purpose

Detailed implementation plans and design documents for specific features. Break down feature requirements into architectural components and integration points.

## Key Files

| File | Description |
|------|-------------|
| `market-narrative-implementation.md` | Market narrative feature — rolling context throughout day, trajectory tracking, escalation briefs |

## Market Narrative Design

The market narrative feature builds rolling context throughout the trading day:

- **Overnight Phase**: Pre-session agent reads ES bars, builds overnight context (range, character, gap, key levels)
- **Pre-Market Phase**: Implied open, auction range, regime expectation
- **Intraday Phase**: Each cycle appends events (bar time, SPX price, RSI, regime, notable moves)
- **Trajectory Tracking**: Session high/low, RSI high/low with timestamps, key moves logged
- **Escalation Brief**: When escalating to judge, narrative built into context (e.g., "RSI traveled from 18→85 in 47 minutes")

**Why**: Judge doesn't receive isolated signals — it receives context. "RSI is 85" means nothing without "...because of the 37-point rally since 10 AM."

## For AI Agents

### Working In This Directory

1. **Read before implementing features** — Each plan explains feature scope, integration points, and design constraints
2. **Follow the plan** — Implement feature according to design doc to maintain consistency
3. **Update plan if requirements change** — If design changes during implementation, update the plan document

## Design Principles Across Plans

All plans follow:

1. **Incremental development** — Features implemented in phases, tested at each step
2. **Integration points** — Each feature clearly defines how it integrates with existing system
3. **Testing strategy** — Unit tests, integration tests, end-to-end validation via replay scripts
4. **Performance targets** — Latency, throughput, memory constraints specified

<!-- MANUAL: Add plan-specific notes, feature status, or implementation roadmap below -->
