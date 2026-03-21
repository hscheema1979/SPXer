<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# docs — Documentation & Design

## Purpose

Architecture specifications, design documents, and implementation plans. Reference material for understanding system design and decision rationale.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `specs/` | Architecture and design specifications — see `specs/AGENTS.md` |
| `plans/` | Feature implementation plans and design docs — see `plans/AGENTS.md` |
| `superpowers/plans/` | Implementation details and technical planning — see `superpowers/plans/AGENTS.md` |

## For AI Agents

### Working In This Directory

1. **Read before major changes** — Design docs explain architectural decisions. Understand rationale before modifying core behavior.
2. **Update docs after changes** — If behavior changes, update corresponding design doc to keep documentation in sync.
3. **Link from CLAUDE.md** — Major architectural decisions should be documented in project root CLAUDE.md.

## Key Design Principles (From Specs)

All specs are based on:

1. **Two-tier assessment** — Scanners flag, judges decide (prevents reactive trading)
2. **Narrative-driven** — Context matters (trajectory, overnight setup, recent events)
3. **Deterministic execution** — Strike selection and orders are code, not LLM-chosen
4. **Sticky band model** — Contracts tracked ±$100 around SPX until expiry
5. **Incremental indicators** — Computed from rolling state, O(1) per bar
6. **Agentic over simple** — Systems should build context and anticipate, not just react

## Documentation Index

| Document | Scope |
|----------|-------|
| `specs/2026-03-18-spxer-design.md` | Full system architecture, data flow, regime classifier, two-tier judgment |
| `plans/market-narrative-implementation.md` | Market narrative feature design, trajectory tracking, escalation briefs |
| `superpowers/plans/2026-03-18-spxer-implementation.md` | Detailed implementation breakdown, module structure, integration points |

## For Writers & Planners

- Start with `specs/` to understand overall architecture
- Check `plans/` for feature-specific design decisions
- Refer to `superpowers/plans/` for implementation details before coding

<!-- MANUAL: Add documentation index notes, linking to key decision documents -->
