# DD-003 — In-app design catalog instead of Storybook

**Status:** Accepted
**Date:** 2026-08-19
**Related:** D-0801, D-0802, US-0002

---

## Context

D-0801 asks for a Storybook catalog covering core controls, recording states,
processing states, instrument items, workspace items and share components, in
English and Persian, including reduced-motion and error states.

The *requirement* underneath it is stated in the story itself: "so that agents
can inspect the real system before inventing new patterns." That is what has to
be satisfied. This record documents a deviation from the named tool, per the
playbook's rule that a lower-level artifact may differ from a higher-level
source only when the difference is recorded rather than silent.

## Decision

**A route at `/[locale]/design` renders the catalog using the production
components.**

What it gives, that a Storybook instance would have to reproduce:

- the real CSS cascade, including the token layer and the `[lang='fa']`
  overrides — a decorator would have to re-establish both, and a drift between
  them would be invisible;
- the real locale provider, so Persian and English are genuine renders rather
  than a mocked context;
- every hard-to-reach state directly: five button kinds × five states, six
  surface tones, all three recording phases, three processing progress values,
  the piano roll in melody / rhythm / empty states, five error panels, and the
  full instrument registry with its live licence audit;
- a stable anchor per section, so a screenshot suite targets them by URL.
  `tests/e2e/design-catalog.spec.ts` uses exactly those anchors, which is what
  satisfies D-0802's "critical states have snapshots at agreed sizes".

## What is given up

Stated so nobody discovers it later:

- no per-component addon panel for poking props interactively;
- no automatic documentation generated from types;
- no isolated iframe per story, so a global style regression appears as a
  catalog-wide failure rather than as one story's.

## Why not both

Storybook 9 with the Next.js framework would add a second build, a second
styling context and a set of decorators duplicating `LocaleProvider` — for a
capability the route already provides. The cost is real and continuous; the
marginal benefit is the addon panel.

## Follow-up

This decision does not foreclose Storybook. The catalog composes the same
production components a story would, so stories can be added on top without
changing a single component. If that happens, supersede this record rather than
leaving it contradicted.
