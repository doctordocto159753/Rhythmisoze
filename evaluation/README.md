# Production evaluation framework

This directory is Rhythmisoze's permanent measurement foundation. Every quality
claim about the pipeline — and every improvement in a pull request — is graded
here against either **exact ground truth** (synthesised corpus) or **measured
behavioural baselines** (pinned real recordings).

## Layout

```
evaluation/
  corpus/
    synthetic.ts   deterministic generators with exact ground truth
    index.ts       case registry + pinned real-recording definitions
  metrics/
    pitch.ts       RPA / RCA / octave-error rate / note F1 / interval agreement
    rhythm.ts      onset precision/recall/F1 + timing deviation
    preservation.ts what our own stages did to the candidate note set
  runner.ts        executes cases through the production flow, measures
  expected/
    baseline.json  committed regression bounds (see below)
  reports/         generated output; never committed
```

The gate itself lives at `tests/evaluation/quality-gate.test.ts` and runs as
part of the normal suite (`npm test`).

## What is measured

**Voice melody and difficult cases** are synthesised at 16 kHz with known f0
paths. The voice path runs exactly as the worker runs it — extraction → judge
(with measured-register authority) → phrase interpretation — and is graded:

| metric | meaning |
|---|---|
| raw pitch accuracy | frames within 50 cents of truth |
| raw chroma accuracy | same, modulo octave |
| octave error rate | chroma right, register wrong |
| gross error rate | not even the pitch class agreed |
| note F1 | onset ±120 ms and pitch ±1 st |
| interval direction agreement | does the transcription move the way the melody moved |
| preservation | per-stage changes; octave changes must be zero |

**Rhythm** cases carry exact hit times and are graded on onset F1 and median
timing deviation.

**Routing** cases assert the intent classifier sends plucks to multipitch,
beats to rhythm.

**Pinned recordings** (`tests/fixtures/audio`) are real mouth recordings kept
as behavioural baselines: route decision plus bounded note counts. Their true
content is known to the performer, not to a file, so they guard regressions
rather than grade accuracy.

## Current baseline highlights

Measured 2026-08-26 (commit range ending `4523b30`):

- Held notes, scales, vibrato, low register, whisper level, room noise:
  **97–99.5% RPA**, note F1 ≥ 0.92.
- `diff-octave-leap` (C4→C5→C4): **RPA 65%, octave error rate 33%** — the
  YIN subharmonic problem reproduced on material with exact ground truth.
  This is the Phase-2 target.
- `voice-glissando`: frame tracking **99.3%** but note F1 **0.00** — the
  tracker follows continuous pitch perfectly while segmentation produces no
  usable note for a non-stepped phrase.
- `rhythm-beatbox-pattern` onset F1 ≈ 0.61 — over-segmentation of drum loops;
  taps are near-perfect (F1 = 1.00).

## Changing the pipeline

1. Measure first: `npx vitest run tests/evaluation` and read
   `evaluation/reports/latest.md`.
2. Make one change.
3. Re-run. Improvements raise numbers; anything that regresses a floor fails
   the gate.
4. If an improvement is intentional, regenerate the baseline deliberately:

```bash
cmd /c "set EVAL_WRITE_BASELINE=1&& npx vitest run tests/evaluation"
```

then review the `expected/baseline.json` diff in the same commit as the change
it encodes. Never regenerate just to make a failing gate pass.

## Adding corpus material

- A synthesised case: add a generator to `corpus/synthetic.ts`, export it in
  `corpus/index.ts`. Ground truth comes from the generator, so no expected file
  is needed beyond the baseline entry created on the next regeneration.
- A pinned recording: it must be license-clean and small; place the WAV under
  `tests/fixtures/audio`, add a `PinnedCase` with route expectation and loose
  note-count bounds, then regenerate the baseline.

Private or user-identifiable recordings never enter this directory; they stay
in the gitignored local workspace (`samples for tests/`, `artifacts/`).
