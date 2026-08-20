# ADR-001 — Processing backend

**Status:** Accepted, with a stated gap
**Date:** 2026-08-19
**Deciders:** implementation agent, pending product-owner confirmation
**Supersedes:** —
**Related:** US-0005, Playbook §7, PRD §3

---

## Context

The Architecture Quality Gate (Playbook §7) requires that the choice between
browser-only, browser-plus-fallback and server-assisted transcription be made
from measurement rather than intuition, on a versioned corpus, across a stated
device matrix.

The PRD's own argument for client-first is strong and independent of that
benchmark. Vercel's 250 MB unzipped function limit makes the Python stack
(`librosa` + `tensorflow` + `fluidsynth` + a SoundFont) impossible — a mid-sized
SoundFont alone is 150 MB — and the 4.5 MB request body limit rules out sending
raw audio through a Function. Those are hard platform facts, not estimates.

Three facts discovered during implementation change the shape of the decision:

1. **The model is 0.9 MB, not 20 MB.** `@spotify/basic-pitch@1.0.1` ships
   `model.json` (174 KB) plus one weight shard (742 KB). The PRD's 20 MB figure
   appears to describe the TensorFlow.js runtime rather than the model. The
   model is now self-hosted at `public/models/basic-pitch/` and versioned with
   the package (`scripts/sync-model.mjs`), so there is no CDN dependency and no
   cross-origin request.
2. **TensorFlow.js must be exactly one copy, and it must be basic-pitch's.**
   An earlier attempt added a top-level `@tensorflow/tfjs@4.22.0` to work around
   an install failure. npm kept basic-pitch's nested `3.21.0` alongside it, so
   the worker bundled two runtimes competing over one kernel registry. Melody
   transcription hung indefinitely; rhythm, which loads no model, was unaffected.
   The top-level dependency has been removed and the library's own 3.21.0 is the
   only copy.

3. **TensorFlow.js 3.21 reads `window` while its modules evaluate**, which a
   Web Worker does not have. The `ReferenceError` is raised from inside the
   library's own module graph, where none of this project's code is on the stack
   to catch it, so the request promise never settled and nothing was posted
   back. The worker now aliases `window` to its global scope immediately before
   the import (`prepareWorkerGlobalsForTensorflow`), traps escaped errors and
   unhandled rejections, and applies a watchdog so an unsettled model attempt
   falls back to the pitch tracker instead of stranding the user.

## Decision

**Option B — browser primary, with a documented in-browser fallback — is
implemented. The gate itself is NOT yet satisfied.**

Concretely:

- `AudioTranscriber` (`src/packages/contracts/audio.ts`) is the only interface
  the UI and the retouch engine know about. Nothing above it can name Basic
  Pitch, TensorFlow.js or any future server endpoint.
- Three implementations exist behind it:
  - `basic-pitch` — the PRD's primary path, in a Web Worker, dynamically
    imported so TensorFlow.js is absent from the initial bundle and is never
    fetched by a visitor who does not record;
  - `pitch-tracker` — a YIN implementation (`src/packages/audio-core/pitch.ts`),
    pure TypeScript, no model. It is the automatic fallback when the model
    cannot load, and it is what lets the pipeline be tested end to end in CI;
  - `RhythmTranscriber` — the separate onset/classification path for beatbox
    input, which is not melody transcription with the pitch discarded.
- The fallback is never silent. `TranscriptionResult.diagnostics.transcriberId`
  travels with the result, the review screen shows which engine produced it, and
  a `model_unavailable` warning is attached.
- No server processing exists. There is no code path that uploads unpublished
  audio.

### 2026-08-20 human-input correction

The first owner-supplied human take exposed a failure hidden by the synthetic
corpus. Basic Pitch emitted the correct D3–F4 contour alongside a near-continuous
A2 subharmonic. Because the decoder was configured as unconstrained polyphonic
output, the global-median octave filter then treated the false lower register as
truth; stronger Clean removed short correct notes and preserved A2.

The melody path is therefore now **Basic Pitch candidates guided by an
independent monophonic YIN contour**:

- YIN runs at 16 kHz before decoding and supplies robust 8th/92nd percentile
  register bounds with a three-semitone margin.
- `outputToNotesPoly` receives those bounds instead of `null`/`null`.
- The model uses its conservative defaults (`0.30` frame, `0.50` onset) and a
  120 ms minimum note length.
- Candidate notes more than 2.5 semitones from the contour are rejected; the
  output is structurally monophonic.
- Retouch centres octave cleanup on the trusted contour, and a quality guard
  rolls back pitch-destructive stages if agreement falls by more than five
  percentage points, register moves over six semitones, or one pitch dominates
  over 60% of the take.

The source recording is represented in the permanent regression corpus by its
SHA-256 and derived note/contour facts in
`tests/fixtures/transcription/recording-8-regression.json`; the personal voice
bytes are not checked into Git. A local run against the supplied 20.288 s M4A
produced 28 monophonic YIN notes, median MIDI 56 (G♯3), adaptive range
48.17–67.74, and no A1/A2 event.

## What has NOT been measured

Stated explicitly rather than implied, because Playbook §7 makes this gate
mandatory and an unmeasured claim would be worse than an absent one:

| Gate metric | Target | Status |
|---|---|---|
| Note-event F1 vs Python reference | ≥ 0.95 | **not measured** |
| Median onset difference | ≤ 20 ms | **not measured** |
| Pitch disagreement before retouch | ≤ 0.25 semitone | **not measured** |
| Transcription time | ≤ 0.5 × clip | **not measured on device** |
| Render time | ≤ 0.25 × clip | measured in code, not on the matrix |
| 60 s clip without OOM | required | **not measured on device** |
| Blinded A/B listening | required | **not performed** |

The corpus now contains one owner-supplied human regression represented by
derived facts plus the synthetic fixtures. That proves this octave/subharmonic
failure stays fixed; it is still too small to satisfy the architecture gate or
support general accuracy claims.

## Consequences

**Positive**

- Unpublished audio never leaves the device. The privacy claim on the landing
  page is structural, not a policy.
- Zero server CPU. The cost target (<$20/month to 10k visits) is met by
  construction, since the only server work is metadata.
- A device that cannot run the model still completes the flow.
- The retouch engine, the MIDI export and the whole rhythm path are testable in
  Node, which is why 372 unit tests can run without a browser.

**Negative**

- The primary path is unverified on real hardware, though it is now verified in
  Chromium end to end: `tests/e2e/capture.spec.ts` drives a synthesised hum
  through `getUserMedia` and asserts the review screen is reached.
- The fallback is monophonic and less accurate. A user who hits it gets a
  materially different result, labelled but different.
- The 0.5 × clip duration target is unproven on a mid-range Android.

## Follow-up required before production release

1. Build the corpus (US-0004) — owner examples plus the device matrix in Q-A3.
2. Run browser Basic Pitch against Python Basic Pitch on it, record every metric
   in the table above into `docs/benchmarks/architecture-quality-gate.md`.
3. Perform the blinded listening comparison.
4. Re-open this ADR. If the browser path fails on low-end devices, the adapter
   already accommodates a server transcriber (US-0306) with no UI change; if
   TensorFlow.js proves unable to start on a device, the watchdog and the
   fallback carry the product while it is resolved.

Until step 4, this ADR is **Accepted for development, not for release**.
