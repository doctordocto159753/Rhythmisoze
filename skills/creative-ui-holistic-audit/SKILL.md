# Skill — Holistic Creative UI Audit

## Use when
A design feels primitive, locally patched, inconsistent, over-styled or when one fix risks damaging neighboring elements.

## Goal
Review the composition across scales before changing individual pixels.

## Audit from outside in
1. Page field and focal center.
2. Major zones and negative space.
3. Sequence of attention.
4. Relative scale and proportion.
5. Component groups.
6. Typography rhythm.
7. Control geometry.
8. Micro-spacing.
9. Motion/state changes.
10. Edge cases and responsive transformation.

## Audit from inside out
For the complained-about element, ask:
- what system rule produced this?
- what neighboring elements depend on that rule?
- should the fix happen at token, primitive, composition or instance level?

## Change protocol
- Do not patch before identifying the level of failure.
- Make the smallest system-level correction that resolves all related instances.
- Re-review the entire screen.
- Re-review one previous and one next state.
- Check mobile and opposite locale.

## Avoid
- “fix button position” without re-checking the row/container;
- compensating margin hacks;
- adding visual complexity to hide structural weakness;
- accepting approximate proportions when reference intent is exact.

## Deliverable
A short audit with:
- root causes;
- system-level fixes;
- screens/states affected;
- before/after visual checks.
