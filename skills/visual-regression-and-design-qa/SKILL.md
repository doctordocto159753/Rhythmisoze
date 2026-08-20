# Skill — Visual Regression & Design QA

## Use when
Finishing a UI change, merging design work, reviewing agent output or preparing release.

## Goal
Make visual craft testable so that small local changes cannot silently degrade the system.

## Required coverage
Capture stable states for:
- landing/entry;
- tempo ready;
- countdown;
- recording;
- processing;
- review;
- instrument loading/selected;
- workspace empty/populated;
- export;
- publish;
- share page;
- errors.

Each should include representative:
- desktop;
- mobile;
- Persian;
- English;
- reduced motion where layout differs.

## Review dimensions
- hierarchy;
- alignment;
- spacing;
- proportions;
- typography;
- contrast;
- truncation;
- overflow;
- icon direction;
- 3D/DOM integration;
- state transition continuity.

## 3D rules
- make deterministic screenshot states where possible;
- fix camera/seed/time for regression captures;
- review performance separately from static snapshots.

## Failure triage
Classify a visual bug as:
- token;
- primitive;
- component;
- composition;
- locale;
- responsive;
- state;
- 3D/performance.

Fix at the highest reusable level that actually caused it.

## Definition of done
A UI change is final only after real-page visual inspection in addition to isolated component review.
