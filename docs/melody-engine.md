# Human Melody Extraction Engine

## Product boundary

Rhythmisoze has two internal acoustic paths for pitched material:

- The **melody route** handles humming, singing and whistling. It assumes one human
  melodic intention and uses the dedicated local engine in
  `src/packages/melody-extraction/`.
- The **polyphonic route** handles guitar, piano and other potentially
  polyphonic audio. It keeps Spotify Basic Pitch and its multipitch output.

These are classifier decisions, not controls the user must choose before making
sound. Rhythm remains the independent fidelity-first onset/drum path, and mixed
material executes pitched and rhythmic branches. MIDI import does not pass
through either acoustic transcriber. Nothing in these paths sends unpublished
audio off the device.

The polyphonic route never falls back to this monophonic engine. If Basic Pitch
is unavailable, the app reports a recoverable model error; returning a plausible
but structurally wrong single-note line would be silent data loss.

## Voice pipeline

```text
MonoAudio
  -> resample to 16 kHz, remove DC, bounded gain
  -> YIN fundamental-frequency frames
  -> adaptive energy/voicing gate
  -> octave-aware, confidence-weighted contour smoothing
  -> percentile vocal-range window
  -> stable-region note segmentation
  -> monophonic NoteEvent generation
  -> Retouch
  -> instrument rendering
```

The package has no UI dependency. Its public `extractHumanMelody()` function
returns pitch frames, the estimated vocal range, intermediate segments, strict
monophonic notes and a melody-confidence assessment.

### Pitch frames

Every 10 ms frame reports time, frequency, fractional MIDI pitch, confidence and
energy. Unvoiced or unreliable frames contain `null` frequency/pitch rather than
a fabricated note. The YIN window is 64 ms at 16 kHz, covering low vocal
fundamentals while retaining useful onset resolution.

### Contour and range

A five-frame weighted median removes tracking grit without quantizing vibrato.
Short gaps are bridged only when the surrounding pitch agrees. Octave repair is
limited to octave-family errors that move an outlier toward its local contour;
ordinary melodic leaps are not automatically flattened. The valid range uses
the 6th/94th percentiles with a three-semitone shoulder, so phrase-edge errors
cannot make a false bass or harmonic become the range authority.

### Segmentation and MIDI notes

A pitch change must remain stable for five frames before it opens a new note.
That hysteresis keeps vibrato as one note and prevents a glissando from becoming
dozens of chromatic fragments. Regions shorter than 100 ms are absorbed into
the musically closest neighbour or discarded. Velocity combines frame
confidence and peak intensity. The generator closes the previous note before
opening the next, making maximum polyphony structurally equal to one.

## Quality score

`melodyConfidence` is a weighted score of:

- voiced-frame percentage;
- pitch continuity;
- octave stability; and
- mean note-segmentation confidence.

Scores below `0.55` are shown as a clarity notice: “Your recording does not
contain a clear melody. Try humming one note after another.” The result is still
available; the notice does not invent notes or silently switch to Basic Pitch.
Retouch remains responsible for timing, scale correction and musical cleanup,
not primary pitch recovery.

## Regression corpus

`tests/melody/` is part of the normal Vitest run and contains:

1. a labelled C4-D4-E4-F4-G4 scale with at least 80% frame agreement;
2. a vibrato tone that must remain one note;
3. the owner-supplied Recording (8) regression, which must contain no A1/A2
   false dominance and must remain monophonic; and
4. the owner-supplied test22 regression, which must not collapse to a repeated
   pitch and must preserve its F#4 transition.

The two human fixtures are normalized mono 16 kHz PCM WAV copies so browser
codec support cannot make a deterministic DSP regression pass or fail.

## Validation commands

```powershell
npm.cmd run verify
npm.cmd test -- tests/melody --reporter=verbose
npm.cmd run build
npx.cmd playwright test --project=capture tests/e2e/source-import.spec.ts
```
