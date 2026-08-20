# ADR-002 — Synthesis engine and instrument sound source

**Status:** Accepted, with a known gap
**Date:** 2026-08-19
**Related:** US-0601, US-0602, US-0603, PRD §6.4, questionnaire Q-D4

---

## Context

The PRD proposes `js-synthesizer` (FluidSynth on WebAssembly) or `smplr` with
FluidR3_GM / VSCO-2 CE SoundFonts. US-0601 requires the choice to be made on
quality, performance, mobile behaviour and licence compatibility, and US-0602
requires every sound asset to carry documented provenance.

Two constraints shape the answer:

1. **Asset weight.** FluidR3_GM is ~150 MB. Even split per instrument and lazily
   loaded, the first instrument a user picks would be a multi-megabyte download
   before they hear anything — on top of the model.
2. **Provenance.** US-0602 makes an undocumented asset a release blocker. A
   SoundFont assembled from mixed sources cannot be shipped until every voice in
   it has a traced licence, and that is curation work, not code.

Questionnaire Q-D4 asks for **realistic / acoustic** instruments, which points
at samples.

## Options considered

| Option | Buys | Costs |
|---|---|---|
| `js-synthesizer` + FluidR3_GM | Recognisable GM sounds immediately | ~150 MB of assets with mixed provenance; WASM on low-end mobile unmeasured |
| `smplr` + a hosted sample set | Small integration | Runtime dependency on a third-party host; CSP must be opened; provenance is someone else's |
| Procedural Web Audio synthesis | Zero assets, zero network, deterministic output, provenance trivially clean | Stylised rather than realistic; will not satisfy Q-D4 on its own |
| Procedural now, samples behind the same adapter | Ships a working product; the realistic path is a data change, not a rewrite | Two engines to maintain |

## Decision

**One adapter, two engines, procedural as the default.**

- `SynthEngine` / `PreparedInstrument` (`src/packages/synthesis/types.ts`) is the
  only thing playback, the offline render and the gallery know about. US-0601's
  "UI depends on a synth adapter, not engine-specific calls" is satisfied
  structurally.
- `ProceduralEngine` synthesises every registered instrument from the recipes in
  `voices.ts`: a harmonic series, an ADSR, an optional filter sweep, an optional
  breath/pluck noise component, an optional vibrato. Deterministic — the noise
  buffer is seeded — so a render is reproducible and regression-testable.
- `SampleEngine` is fully implemented: a documented manifest format, per-zone
  multisampling by playback rate, per-instrument caching, per-file progress. It
  activates automatically for any instrument that declares a `samplePack`.
- `ENGINES` in `render.ts` is ordered: the sample engine wins wherever a pack
  exists, the procedural engine is the floor that always answers.

## Evidence

- `tests/unit/synthesis.test.ts` asserts the registry audit, that every
  registered instrument has a voice the engine can actually produce, and that
  the two kits differ audibly rather than by name.
- Render performance against the PRD's ≤ 0.25 × clip target: **not measured on
  the device matrix.** `renderSketch` returns `realtimeRatio` on every call so
  the number is available, and telemetry records it (US-1103), but no device run
  has been performed.

## Consequences

**Positive**

- First render works with no network at all; nothing to fail, nothing to cache.
- The licence ledger is trivially complete: every voice is original work in this
  repository, MIT, listed in `docs/licenses/instruments.md`.
- Deterministic output makes render regression testing possible.
- Lazy loading is moot for the default engine (there is nothing to load), and
  real for the sample engine, which is where it matters.

**Negative — stated plainly**

- **The shipped sounds are synthesised approximations, not recordings.** They are
  recognisable; they are not realistic. Questionnaire Q-D4 asked for realistic
  acoustic instruments, and the default engine does not deliver that. This is a
  known, deliberate gap, not an oversight.
- No sample pack ships. `SampleEngine.supports()` returns false for every
  registered instrument today, which the test suite asserts so the state cannot
  drift silently.

## Follow-up

1. Curate CC0 / OFL-compatible sample packs for the eight PRD instruments.
   Candidates worth evaluating: VSCO-2 Community Edition (CC0), Philharmonia
   Orchestra samples (CC BY-NC — check the licence against commercial intent),
   Sonatina Symphonic Orchestra (CC Sampling Plus).
2. Record each pack in `docs/licenses/instruments.md` with source and licence.
3. Add `samplePack` and `samplePackBytes` to the registry entries. No other code
   changes.
4. A/B the two engines on the benchmark corpus and record the result here.
