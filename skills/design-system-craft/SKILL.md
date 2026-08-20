# Skill — Design System Craft

## Use when
Creating or changing reusable components, tokens, spacing, typography, controls, states or Storybook.

## Goal
Make repeated decisions consistent without flattening the product's artistic character.

## System layers
1. semantics;
2. tokens;
3. primitives;
4. musical controls;
5. compositions;
6. spatial/3D layer.

## Mandatory rules
- Use semantic tokens, not raw colors in product components.
- Use logical CSS properties for bidirectional layouts.
- Define state tables for interactive controls.
- Tokenize typography for Persian and Latin separately where metrics require it.
- Motion has tokens for duration/easing and reduced-motion behavior.
- A new component is allowed only when an existing primitive/composition cannot express the behavior cleanly.
- Document hard-to-reach states in Storybook.

## Component review
For each component inspect:
- purpose;
- anatomy;
- hierarchy;
- hover/focus/pressed/disabled/loading/error;
- Persian/English;
- mobile;
- keyboard;
- screen reader;
- reduced motion;
- neighboring layout impact.

## Avoid
- one-off pixel values;
- per-screen copies of the same control;
- using “Card” as a universal layout primitive;
- mixing art direction into business logic;
- visual tokens named after literal colors rather than meaning.

## Definition of done
A component is not done until its Storybook states and at least one real page composition are both reviewed.
