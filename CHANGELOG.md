# Changelog

All notable changes to Rhythmisoze are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions correspond
to release tags on `deploy/selfhosted-ai-musician-v1` until the branches merge.

## [0.10.0] — 2026-08-26 — no tempo, and a second opinion

Two changes, and the first is a correction to a premise the product had held
since its first version.

### Removed

- **The tempo step, entirely.** No tap pad, no BPM slider, no meter selector, no
  metronome, no count-in, no `tempoChoice` override. `tempo_ready` and
  `countdown` are gone from the state machine along with `TEMPO_SET` and
  `COUNT_IN_STARTED`, and `bpm` / `tapHistory` / `tapCount` / `metronomeMuted`
  are gone from the creation state. The app opens on the record control.

  A user reported the reason: the app saying *"heard at 85, but you selected
  120"*, and the same melody at the same speed coming out worse than when they
  had happened to select 85 before singing. A number chosen before any music
  existed was reaching the interpretation of the music that followed. Removing
  the choice was the fix; arbitrating it better had already been tried.

  Removing the count-in also stops the click track contaminating the evidence:
  on a laptop without headphones the metronome was *in the recording*.

### Added

- **Tempo as an observation.** `PerformanceTempo.bpm` is `number | null`, and
  null — *free timing* — is a real answer rather than a cue to substitute one.
  MIDI files and bar rulers still need a number, so `encodingBpm` supplies a
  constant; every version built on a free-timed take carries zero quantization
  strength, so that constant never moves a note.
- **A stated tempo outranks a measured one, for imported files only.** A MIDI
  file's tempo map is the file asserting a fact about the music. Re-deriving a
  tempo from its own note starts produced 120 for a 126 BPM file and stamped the
  export with a tempo the source never had.
- **`@evidence`: several engines' readings, and a register arbitration.** The
  YIN-derived tracker cannot hear an octave leap — 32.6% octave error on a
  synthetic C4→C5→C4 case with 98.9% chroma accuracy. Basic Pitch, already a
  dependency, has 0% octave error there and splits one held tone into
  twenty-four notes. Each engine is now trusted only for what it measures well.
- **Corroboration before correction.** A register correction requires two
  agreeing engines. One witness moved seven notes on the pinned real recordings,
  and a second model showed that four were corroborated and two were the
  witnesses disagreeing with each other. No engine may act alone.
- **`services/transcription`**: an optional register witness wrapping GAME.
  **Off by default**, for two independent reasons — it sends the recording off
  the device (and the landing copy switches to a sentence that says so, before a
  take exists), and GAME's weights are CC BY-NC-SA 4.0 while this project is
  MIT.
- **Two accuracy columns in the evaluation report.** `tracker` grades the frames
  the contour engine produced and is never revised; `delivered` grades what the
  product hands the user. They used to be one number.

### Measured

`diff-octave-leap`, with the optional service:

| | before | after |
|---|---|---|
| delivered octave error | 32.6% | **0.0%** |
| delivered RPA | 65.2% | **98.3%** |
| note F1 | 0.67 | **1.00** |
| interval direction agreement | 0% | **100%** |

Without the service, unchanged — and the disagreement is now reported where it
used to be silent. Both configurations are gated.

### Fixed

- The creation reducer returned `undefined` for an action type it did not
  declare, which is every field lost rather than one stale action ignored.
  Found by the new tempo-independence test.

## [0.9.0] — 2026-08-26 — production-readiness candidate

This is the first release candidate of the self-hosted edition: the complete
product including the AI Musician, runnable on one machine, with a measured
quality baseline and CI-gated regressions.

### Added

- **Production evaluation framework** (`evaluation/`, runs in `npm test`):
  deterministic synthesised corpus with exact ground truth (voice melody,
  vibrato, glissando, octave leaps, low register, whisper level, room noise,
  harmonic-heavy timbres, beatbox/tap patterns, plucked lines), MIR-standard
  pitch metrics with separate octave-error accounting, onset and timing metrics,
  musical-preservation metrics, behavioural baselines on four pinned real
  recordings, and a committed regression baseline
  (`evaluation/expected/baseline.json`) that fails the build on quality
  regressions.
- **Per-note transformation history**: every voice transcription now records
  what the judge and interpretation stages changed (removed / added /
  pitch-shifted / moved) on `diagnostics.noteTransformations`.
- **Judge octave-conflict reporting** (`JudgeVerdict.octaveConflicts`): register
  disagreements between the transcription and measured frames are listed with
  support numbers instead of being silently resolved.
- **Forensic five-layer debug view** (local eval workspace): waveform, spectral
  centroid, pitch contour with per-frame provenance, confidence contour, note
  segmentation and transformation history per recording.
- Self-hosted AI Musician edition: Docker-based local model runtime for the
  developed/expanded/shaped versions, with bootstrap scripts for Windows and
  Linux.

### Improved

- **Measured-register authority (single octave authority).** The judge no
  longer re-decides the register the extraction stage chose from phrase-level
  evidence; it defers and reports. On real failing takes this removed nine
  catastrophic folds on one recording alone (six notes moved down exactly an
  octave) and a +12-semitone "correction" to a pitch nobody sang.
- **Evidence-gated octave repair** for non-pipeline candidates: folds now need
  decisive frame support (≥60% of the span within 1.2 semitones, by a clear
  margin), which also blocks moving notes away from what the audio says.
- **Mouth-melody routing guard**: consonant-articulated singing ("da-ba-li-da"
  syllables) no longer reads as a plucked instrument; two real takes that were
  routed to multipitch transcription — one scattering 207 notes across 44
  semitones — stay on the melody engine. Instrument, rhythm and mixed routing
  are unchanged.
- Tail-hold handling and capture gain/headroom in the voice path.
- Evidence-aware gap bridging with per-frame provenance: bridged frames cannot
  become false evidence; segmentation votes only on measured frames.

### Fixed

- Judge octave corrections overwriting correctly transcribed registers on
  articulated mouth recordings (the "unstable pitch regions" failure).
- False polyphonic routing of voice-like input at production decode rates.
- Local experiment artifacts leaking into version control
  (`artifacts/real-pipeline/`).

### Known limitations

Honest list; measured numbers in [`evaluation/`](evaluation/README.md).

- **Octave ambiguity at the tracker** is unresolved at the source: YIN can
  report a confident subharmonic on some voices/articulations (33% octave-error
  frames on the synthetic octave-leap case). The system contains it; Phase 2
  benchmarks alternative pitch engines behind a `PitchEngine` adapter.
- **Glissando**: continuous pitch sweeps track at 99% per frame but produce no
  usable single note — segmentation assumes stepped pitches.
- **Whisper-level recordings** (peaks ≲ −30 dBFS) degrade gracefully rather
  than well; use a normal singing level for best results.
- Supported inputs are voice/mouth melody, humming, beatbox/body rhythm, and
  monophonic-to-polyphonic instruments; polyphonic instrument output inherits
  Basic Pitch's characteristics rather than the voice pipeline's.
- The self-hosted Musician requires downloading ~1.4 GB of model weights at
  bootstrap; CPU inference works but is slower than GPU.
