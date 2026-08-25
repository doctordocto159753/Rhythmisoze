# Changelog

All notable changes to Rhythmisoze are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions correspond
to release tags on `deploy/selfhosted-ai-musician-v1` until the branches merge.

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
