# Event Handler Migration — Roles & Responsibilities (R&R)

**Date**: 2026-04-23
**Status**: Defining ownership for event-driven architecture transition
**Purpose**: Clear accountability for migration from polling agent to event handler

---

## Core Teams

### 1. Architecture Team
**Lead**: TBD
**Members**: TBD

**Responsibilities**:
- Own the technical architecture decision (polling vs event-driven)
- Review and approve edge case fixes
- Ensure replay system parity with live agent
- Design cross-cutting concerns (state persistence, error handling)

**Decision Authority**:
- ✅ Approve architectural changes
- ✅ Sign off on breaking changes
- ✅ Define testing requirements
- ❌ Not responsible for implementation details

**Deliverables**:
- Architecture decision record (ADR)
- Edge case analysis
- Integration test requirements

---

### 2. Implementation Team
**Lead**: TBD
**Members**: TBD

**Responsibilities**:
- Implement event handler fixes (critical edge cases)
- Write unit and integration tests
- Code reviews for event handler changes
- Debug production issues

**Decision Authority**:
- ✅ Approve code changes to event handler
- ✅ Define implementation timeline
- ✅ Sign off on test coverage
- ❌ Not responsible for architectural decisions

**Deliverables**:
- Working event handler with all edge cases fixed
- Test suite (unit + integration)
- Code documentation

---

### 3. QA / Testing Team
**Lead**: TBD
**Members**: TBD

**Responsibilities**:
- Create test scenarios for edge cases
- Execute full-day paper trading tests
- Chaos testing (crashes, network partitions)
- Validate P&L matches broker

**Decision Authority**:
- ✅ Sign off on test completeness
- ✅ Reject deployment if tests fail
- ✅ Define test coverage requirements
- ❌ Not responsible for writing production code

**Deliverables**:
- Test plan document
- Test execution reports
- Bug reports with reproduction steps

---

### 4. Ops / DevOps Team
**Lead**: TBD
**Members**: TBD

**Responsibilities**:
- Deploy event handler to staging/production
- Monitor logs and alerts
- Handle rollbacks if needed
- Maintain PM2 ecosystem configuration

**Decision Authority**:
- ✅ Approve production deployment
- ✅ Define monitoring requirements
- ✅ Trigger rollbacks
- ❌ Not responsible for code quality

**Deliverables**:
- Deployment checklist
- Monitoring dashboard setup
- Runbooks for common issues

---

### 5. Trading Team (Business Stakeholders)
**Lead**: TBD
**Members**: TBD

**Responsibilities**:
- Define trading requirements (max positions, risk gates)
- Validate P&L calculations match broker
- Test new configs in replay before live deployment
- Approve go-live for production trading

**Decision Authority**:
- ✅ Approve live trading with real money
- ✅ Define risk parameters (stop loss, position size)
- ✅ Reject deployment if P&L doesn't match
- ❌ Not responsible for technical implementation

**Deliverables**:
- Trading requirements document
- Replay test results for new configs
- Live trading sign-off

---

## R&R Matrix (Cross-Functional)

### Phase 1: Current State Audit
| Task | Owner | Approver | Due Date |
|------|-------|----------|----------|
| Document what's working vs broken | Architecture | Implementation | Day 1 |
| Identify edge cases | Architecture | QA | Day 1 |
| Assess risk level | Trading | Architecture | Day 1 |

### Phase 2: Critical Fixes
| Task | Owner | Approver | Due Date |
|------|-------|----------|----------|
| Implement OCO retry | Implementation | Architecture | Day 1-2 |
| Implement exit polling fixes | Implementation | Architecture | Day 1-2 |
| Implement state persistence | Implementation | Architecture | Day 2-3 |
| Code review | Implementation | Architecture | Day 3 |
| Unit tests | Implementation | QA | Day 3 |

### Phase 3: Testing
| Task | Owner | Approver | Due Date |
|------|-------|----------|----------|
| Create test plan | QA | Implementation | Day 3 |
| Execute unit tests | QA | Implementation | Day 3 |
| Execute integration tests | QA | Implementation | Day 4 |
| Full-day paper test | QA | Trading | Day 4 |
| Chaos testing | QA | Architecture | Day 4 |

### Phase 4: Staging Deployment
| Task | Owner | Approver | Due Date |
|------|-------|----------|----------|
| Deploy to staging | Ops | Architecture | Day 4 |
| Monitor staging | Ops | Implementation | Day 4-5 |
| Fix staging bugs | Implementation | QA | Day 5 |

### Phase 5: Production Deployment
| Task | Owner | Approver | Due Date |
|------|-------|----------|----------|
| Pre-flight checklist | Ops | Trading | Day 5 |
| Deploy to production (paper mode) | Ops | Trading | Week 2 |
| Monitor paper mode | Ops | Trading | Week 2 |
| Deploy to production (live mode) | Ops | Trading | Week 3-4 |
| Remove old polling agent | Ops | Architecture | Week 4 |

---

## Decision Rights Framework

### Type 1: Technical Decisions (Architecture Team)
**Examples**:
- Should we use polling or event-driven?
- How should state persistence work?
- What's the retry strategy for API failures?

**Process**:
1. Architecture team proposes
2. Implementation team reviews feasibility
3. Architecture team makes final call
4. Document decision in ADR

### Type 2: Implementation Decisions (Implementation Team)
**Examples**:
- Which library to use for WebSocket reconnection?
- How to structure the persistence module?
- What error messages to log?

**Process**:
1. Implementation team decides
2. Architecture team reviews for consistency
3. Implement and move forward

### Type 3: Business Decisions (Trading Team)
**Examples**:
- What's the max position size?
- What stop loss percentage to use?
- When to go live with real money?

**Process**:
1. Trading team defines requirements
2. Architecture team ensures feasibility
3. Trading team makes final call

### Type 4: Deployment Decisions (Ops Team)
**Examples**:
- When to deploy to staging?
- When to deploy to production?
- When to rollback?

**Process**:
1. Ops team proposes deployment window
2. Implementation team confirms code ready
3. Trading team approves for production
4. Ops team executes

---

## Escalation Path

### Level 1: Team Lead
**Scope**: Decisions within team purview
- Technical → Architecture Lead
- Implementation → Implementation Lead
- Testing → QA Lead
- Ops → Ops Lead
- Trading → Trading Lead

### Level 2: Cross-Functional Lead
**Scope**: Decisions affecting multiple teams
- Escalate to project lead or CTO
- Example: Replay system needs changes to support new architecture

### Level 3: Business Owner
**Scope**: High-impact decisions with financial risk
- Escalate to business owner or CEO
- Example: Go-live with live trading

---

## Communication Plan

### Daily Standups (15 min)
**Attendees**: Implementation, QA, Ops leads
**Topics**:
- What was fixed yesterday?
- What's being fixed today?
- Any blockers?

### Weekly Sync (1 hour)
**Attendees**: All team leads
**Topics**:
- Progress against timeline
- Cross-team dependencies
- Risks and issues

### Stakeholder Updates (weekly email)
**Recipients**: Trading team, business owners
**Content**:
- Deployment status
- P&L impact (if live)
- Known issues

---

## Handoff Criteria

### Architecture → Implementation
**When**: Architecture decision record created
**Includes**:
- Problem statement
- Proposed solution
- Edge cases to consider
- Testing requirements

### Implementation → QA
**When**: Code complete with unit tests
**Includes**:
- Working code
- Unit tests (passing)
- Documentation of edge cases
- Test scenarios

### QA → Ops
**When**: All tests passing
**Includes**:
- Test execution report
- Known issues (if any)
- Deployment checklist
- Monitoring requirements

### Ops → Trading
**When**: Deployed to staging/production
**Includes**:
- Deployment confirmation
- Access to logs/dashboards
- Runbook for common issues

---

## Success Metrics by Team

### Architecture Team
- ✅ Replay system parity maintained
- ✅ Edge cases identified and documented
- ✅ Architecture decision records created

### Implementation Team
- ✅ All critical fixes implemented
- ✅ Unit test coverage >80%
- ✅ Code review approval received

### QA Team
- ✅ All test scenarios executed
- ✅ Zero critical bugs in production
- ✅ Full-day paper test passed

### Ops Team
- ✅ Zero unplanned downtime
- ✅ Monitoring alerts configured
- ✅ Rollback tested

### Trading Team
- ✅ P&L matches broker within 0.1%
- ✅ No missed entries due to bugs
- ✅ Live trading approved

---

## RACI Chart (Responsible, Accountable, Consulted, Informed)

| Activity | Architecture | Implementation | QA | Ops | Trading |
|----------|--------------|----------------|----|----|---------|
| Define architecture | A/R | C | I | I | I |
| Implement fixes | C | A/R | I | I | I |
| Write tests | C | C | A/R | I | I |
| Deploy to staging | C | I | C | A/R | I |
| Deploy to production | C | I | C | A/R | A |
| Approve live trading | I | I | I | C | A/R |
| Monitor production | C | I | I | A/R | C |

**Legend**:
- **A** = Accountable (one person makes final decision)
- **R** = Responsible (does the work)
- **C** = Consulted (provides input)
- **I** = Informed (kept up to date)

---

## Open Questions

### To Be Defined
1. **Who is the Architecture Lead?**
   - Currently TBD
   - Needs: Systems design experience, familiarity with codebase

2. **Who is the Implementation Lead?**
   - Currently TBD
   - Needs: TypeScript/Node.js experience, familiarity with Tradier API

3. **Who is the QA Lead?**
   - Currently TBD
   - Needs: Testing mindset, attention to detail

4. **Who is the Ops Lead?**
   - Currently TBD
   - Needs: DevOps experience, familiarity with PM2

5. **Who is the Trading Lead?**
   - Currently TBD
   - Needs: Trading experience, risk management mindset

### To Be Decided
1. **What's the go-live criteria?**
   - Full-day paper test with zero issues?
   - 3 consecutive days of paper trading?
   - Trading team sign-off required?

2. **What's the rollback trigger?**
   - >5% exit failure rate?
   - Any critical alert?
   - P&L doesn't match broker?

3. **What's the monitoring SLA?**
   - Response time for critical alerts?
   - Uptime requirement for handler?

---

## Next Steps

1. **Assign team leads** — Fill TBD roles
2. **Kickoff meeting** — Align on timeline and expectations
3. **Create project board** — Track tasks and owners
4. **Set up communication channels** — Slack, email, standup schedule
5. **Begin Phase 1** — Current state audit

---

**END OF ROLES & RESPONSIBILITIES**
