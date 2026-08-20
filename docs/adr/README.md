# Architecture Decision Records

An ADR records a decision that would otherwise have to be reconstructed by
reading code and guessing. Playbook §3 puts accepted ADRs above user stories and
above the current implementation in the source-of-truth order, which means:

- an ADR may not be contradicted by a commit; it is amended or superseded first;
- "no major dependency or backend decision is final without an ADR" (US-0003).

## Index

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-processing-backend.md) | Transcription backend | Accepted for development, **not for release** |
| [ADR-002](ADR-002-synthesis-engine.md) | Synthesis engine and instrument sound source | Accepted, with a known gap |
| [ADR-003](ADR-003-styling-system.md) | CSS Modules and design tokens instead of Tailwind | Accepted |
| [ADR-004](ADR-004-publish-identity.md) | Anonymous publishing with a management token | Accepted |

## Template

```markdown
# ADR-00N — <decision in a noun phrase>

**Status:** Proposed | Accepted | Superseded by ADR-00M | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** who
**Related:** stories, PRD sections, playbook sections

## Context
What forced a decision. Facts and constraints, not preferences.

## Options considered
Each with what it would cost and what it would buy. An option nobody seriously
considered does not belong here.

## Decision
What was chosen, stated so that a reader can tell whether the code follows it.

## Evidence
Measurements, benchmarks, or an explicit statement that there are none yet.

## Consequences
Positive and negative. The negative half is the half that matters later.

## Follow-up
What would reopen this.
```

## Rules

- One decision per record. A record that decides three things cannot be
  superseded cleanly.
- Never edit an accepted ADR's decision. Write a new one that supersedes it.
- If a benchmark has not been run, say so in the ADR rather than omitting the
  section. An unmeasured claim presented as measured is the failure this
  directory exists to prevent.
