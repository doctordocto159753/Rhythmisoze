# Architecture quality gate

**US-0005 / Playbook §7. Status: NOT RUN.**

This document defines the method and records that it has not been executed. It
is the blocking item in ADR-001.

## Why it is not run

The corpus does not exist. Q-A2 records that the owner will supply real audio
examples and expected outputs; none were available at implementation time, and
Q-A3 (target devices) is unanswered, so there is no device matrix to run against
either.

What exists instead is a *correctness* fixture set: synthesised signals with
known right answers — a 220 Hz sine is A3, four clicks 0.5 s apart are four
onsets at those times. Those prove the DSP does what it claims. They say nothing
about accuracy on a human hum, which is what this gate is for.

## Corpus definition (US-0004)

Build `tests/fixtures/corpus/` with, at minimum:

| Class | Count | Notes |
|---|---|---|
| Clean humming | 4 | Two voices, one high one low |
| Off-pitch humming | 3 | The product's actual target user |
| Soft voice | 2 | Calibrates the "too quiet" gate against a real singer |
| Loud / clipped | 2 | Phone held too close |
| Sustained notes | 2 | Tests note merging |
| Fast transitions | 2 | Tests the minimum note length |
| Vibrato / glides | 2 | The hardest case for scale snapping |
| Beatbox kick/snare/hat | 4 | For the rhythm path |
| Noisy phone recording | 2 | Room tone, traffic |
| One 30 s take | 1 | Duration scaling |
| One 60 s take | 1 | The MVP maximum; memory ceiling |

Each fixture needs metadata: source, duration, intended mode, and annotated
expected behaviour where it can be established.

Recorded on at least: one mid-range Android (Chrome), one recent iPhone (Safari),
one Windows laptop (Chrome and Firefox), one macOS machine (Safari).

## Comparison to run

1. Browser Basic Pitch through the worker, on each device.
2. Python Basic Pitch on the same files, as the reference.
3. Identical retouch settings applied to both outputs.

## Metrics and targets

Targets are the playbook's engineering defaults and may move after the first
run — but only with a recorded reason.

| Metric | Target | Result |
|---|---|---|
| Note-event F1 vs reference | ≥ 0.95 | — |
| Median onset difference | ≤ 20 ms | — |
| Median pitch disagreement, pre-retouch, on stable sections | ≤ 0.25 semitone | — |
| Transcription time / clip duration, desktop | ≤ 0.5 | — |
| Transcription time / clip duration, mid-range mobile | ≤ 0.5 | — |
| Render time / clip duration | ≤ 0.25 | — |
| Main thread responsive during inference | required | — |
| 60 s clip without OOM on every target device | required | — |
| Blinded A/B listening, post-retouch | no material regression | — |

## Also worth measuring in the same run

Not in the playbook's list, but cheap to collect once the corpus exists and
directly useful:

- **Basic Pitch vs the built-in YIN tracker** on the monophonic humming subset.
  The fallback may be *better* on single-voice input, which would change how it
  is presented rather than leaving it as a downgrade.
- **TensorFlow.js 4.22 vs 3.21** on the same model, since ADR-001 pins a major
  outside the library's declared range.
- **Model load time**, cold and warm, against the PRD's 8 s first-load target.

## Recording the outcome

Fill the results table above, then update ADR-001's decision section and its
status line. If the browser path fails on low-end devices, US-0306 (the server
adapter) becomes active work; the `AudioTranscriber` interface already
accommodates it with no UI change.
