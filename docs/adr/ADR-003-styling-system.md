# ADR-003 — CSS Modules and design tokens instead of Tailwind

**Status:** Accepted
**Date:** 2026-08-19
**Related:** PRD §7 stack table, D-0102, D-0103, D-0104, Playbook §3

---

## Context

The PRD's stack table lists "Tailwind + shadcn/ui" for the interface layer, with
the stated reason **"speed"**. Playbook §3 puts an accepted ADR above the
current implementation but below an accepted PRD decision, and forbids silently
overriding a higher-level source — so a departure has to be recorded here and
reported, which is what this record does.

Three requirements pull against a utility-first default:

1. **Bidirectional layout.** Persian is a first-class presentation (Gate G5).
   Every spacing and alignment decision has to use logical properties
   (`inline-start`, `margin-inline`, `padding-block`). Tailwind supports logical
   utilities, but its idiomatic classes are physical, and the failure mode —
   one `pl-4` that should have been `ps-4` — is invisible in English and broken
   in Persian.
2. **The design package's anti-directions.** It explicitly prohibits generic
   card grids, default rounded rectangles and "premium SaaS spacing divorced
   from musical use", and requires semantic tokens named for meaning rather than
   value. shadcn/ui is a card-and-dialog vocabulary; adopting it would mean
   fighting its defaults on every screen.
3. **Tempo-linked motion.** `--beat-duration` is set from the audio clock and
   consumed by CSS. That is a custom-property mechanism, not a utility-class one.

## Options considered

| Option | Buys | Costs |
|---|---|---|
| Tailwind v4 + shadcn/ui, as the PRD suggests | Fast first draft; familiar to most contributors | Physical-direction defaults; a component vocabulary the design brief prohibits; utility sprawl in place of a token layer |
| Tailwind with a bespoke token config, no shadcn | Keeps the ecosystem | Most of the same direction risk; the token layer ends up defined twice |
| CSS Modules + a custom-property token layer | Exact control over logical properties; tokens are the only vocabulary; no build integration risk | Slower to write; no utility shorthand |

## Decision

**CSS Modules, scoped per component, over a single custom-property token layer
in `src/styles/tokens.css`.**

- Product components reference semantic tokens only. A raw hex in a component is
  a review failure.
- Layout uses logical properties throughout. `left` and `right` appear only
  where a value is genuinely physical — a canvas coordinate, or the time axis of
  the piano roll and the waveform, which must *not* mirror with text direction
  (Playbook §11).
- The token file carries the visual thesis and its five invariants as a comment,
  so the reason a rule exists is next to the rule.

## Evidence

Not a measured decision; a craft one. What can be checked is stated in
`docs/design-decisions/DD-001-visual-thesis.md` and enforced by review.

## Consequences

**Positive**

- Persian and English come from one system rather than one system plus
  corrections.
- No CSS build-plugin integration to keep current alongside Next.js.
- Tokens are a real layer, not a config file that utilities bypass.

**Negative**

- More CSS to write per component than a utility approach.
- No third-party component library to draw from; every control is built here.
  That is a real cost, accepted because the design brief rules out the
  library's vocabulary anyway.

## Follow-up

If a future contributor prefers Tailwind, the token layer is the migration path:
Tailwind's theme can be pointed at the same custom properties, and components
can move file by file. Nothing here forecloses it.
