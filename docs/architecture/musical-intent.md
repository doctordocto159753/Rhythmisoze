# Musical intent architecture

How a recording becomes a musical idea, and where each decision is made.

This document covers the re-architecture that moved the product from *audio
transcription* to *musical intent extraction*. The voice pipeline itself is in
[`../melody-engine.md`](../melody-engine.md); this is the layer around it.

## Current internal-routing architecture

```text
Record / upload audio or MIDI
             |
       InputClassifier
 type + confidence + reasoning
             |
    +--------+-----------+---------+---------+
 melody  polyphonic    rhythm    mixed    unknown
    |        |            |       |  |       |
 existing  Basic Pitch  fidelity  |  +-- rhythm fidelity
 YIN path  transcription pipeline +----- pitched pipeline
    |        |                              no processing
    +--- Judge -> Teacher -> Musician
```

Classification is not a user-facing mode. The creation screen offers one sound
flow, and `InputClassifier` records `melody | polyphonic | rhythm | mixed |
unknown`, its
confidence, normalized scores, measured evidence, and human-readable reasoning
in processing diagnostics. Audio classification runs inside the transcription
worker. MIDI classification uses duration, density, overlap, and explicitly
declared percussion; absence of channel 10 is never treated as intent.

The voice extractor remains YIN pitch evidence -> `FrameEvidence` -> hysteretic
voicing -> continuity-aware segmentation -> `NoteEvent[]`. Rhythm keeps its
fidelity-first pipeline and has no Teacher. Mixed material preserves both
streams: Teacher and Musician see pitched notes, while drums use rhythm fidelity.
`unknown` means there was not enough musical evidence to choose a safe engine,
so processing stops with a recoverable error instead of manufacturing a melody
from noise.

The detected route is shown after processing, with its confidence and reasoning.
From Review the person can correct it to melody or rhythm without recording or
uploading again. The source bytes are retained, previous derived material is
invalidated, and diagnostics preserve both the automatic route and the explicit
correction. Classification is therefore a recommendation, not destructive
authority.

Polyphonic evidence has one honest execution path: Basic Pitch. If that engine
cannot load or finish, the request fails recoverably; it is never silently
downgraded to the monophonic YIN extractor. Progress from compound mixed jobs is
mapped into monotonic phase windows, so one sub-engine cannot report completion
and then move the UI backwards.

Saved projects and export manifests retain the existing `melody | rhythm`
field. Internal rhythm maps to `rhythm`; the other routes use the compatible
melody container while their richer classification remains in diagnostics. The
legacy `classifyIntent()` API and explicit MIDI-plan argument remain adapters
for older callers, but the current UI does not use them.

---

## The two mistakes this replaced

**1. Everything went into Melody Mode.** A guitar recording was handed to a
monophonic voice tracker; a beatbox take was asked for its fundamental
frequency. Both produce nonsense, and neither is the user's fault.

**2. The metronome was treated as the source of truth.** A user tapped 120, sang
at 83, and the result was forced onto a 120 grid. That inverts the product: the
metronome exists to help someone perform steadily, not to state what music they
made. Forcing the grid does not tidy the idea — it destroys it.

## The shape now

```text
                       Audio input
                            │
                  ┌─────────┴─────────┐
                  │ InputClassifier   │
                  └─────────┬─────────┘
          ┌───────────┬─────┴─────┬───────────┐
       melody    polyphonic     rhythm       mixed
          │           │            │          │ │
   melody-extraction  │       onset + drum    │ └─ rhythm fidelity
   (monophonic,       │       classification  └── Basic Pitch
    glide-aware)      │            │
                      └─ Basic Pitch

                 unknown → recoverable refusal

Every successful route → Review → optional route correction from original source
```

Two things are deliberately unchanged: the retouch layer (verified against the
Python reference by 181 parity assertions) and the instrument engine. The new
work sits around them rather than through them.

---

## Intent classification

`src/packages/intent/classifier.ts`

Rule-based over measured features, not learned. There is no licensed corpus for
this task, and a rule set can be read, argued with and corrected by whoever
receives a bad classification — a small trained model can only be retrained.

### What separates the three

| | voiced ratio | continuity | attack | onsets/sec |
|---|---|---|---|---|
| **voice** | high | long unbroken runs | soft | low |
| **instrument** | high | short runs, re-attacked | sharp | mid |
| **beat** | ~none | n/a | sharp | high |

Voice and instrument are the hard pair — a hummed line and a plucked line share
most statistics. The discriminator that works is **continuity**: a voice glides
between notes and its pitch track survives the transition, while a plucked
instrument restarts its envelope on every note.

### Two gates that matter

Both were added after the first version misclassified real signals:

- **Pitchedness gate.** Voice and instrument scores are multiplied by how
  voiced the recording is. Without it a beatbox take scores as an instrument,
  because sharp attacks and short voiced runs describe a plucked string too.
  Percussion is not a quiet guitar; the difference is that it has no pitch.
- **Percussive gate.** The beat score is multiplied by how many attacks there
  are. Without it, anything unpitched scores as a beat — tape hiss, a fan, a
  held breath — purely for lacking a fundamental.

### The mouth-melody override

A third correction, added after real recordings failed the other way: sung
syllables with hard consonants ("da-ba-li-da") raise attack statistics into
plucked-instrument territory, and the take was routed to multipitch
transcription, which scattered it across registers nobody sang.

The override is deliberately narrow. It fires only when **all** of these hold:

- `polyphonic` is currently the winning route — `rhythm` and `mixed` wins stand,
  so layered material still reaches both engines;
- at least 45% of frames are voiced, with pitch periodicity staying consistent;
- attack sharpness never reaches struck-string levels;
- percussion is not itself a competing lead (beat share under 30%).

When it fires, melody's raw score overtakes polyphonic proportionally to the
mouth evidence, and the reasoning records `mouth_melody_guard` so the decision
is auditable in Review diagnostics. Real plucks fail the attack factor outright,
and faint takes fail the voicing factor — neither gets redirected.

### Confidence and abstention

Confidence combines the **margin** over the runner-up with the **absolute** score
of the winner. Both halves are needed: three scores near zero produce a large
relative margin between them, which without the second term reads as certainty
about noise.

`INTENT_ASK_THRESHOLD` (0.62) remains the legacy three-way ambiguity threshold.
The product-facing classifier does not expose an up-front question. It uses the
threshold together with absolute pitch evidence: ambiguity between voice and a
plucked instrument still routes to a compatible engine, while a signal with no
usable musical evidence becomes `unknown` and is not processed. A successful
classification can be corrected after Review from the original source.

---

## Rhythm extraction

`src/packages/rhythm-extraction/`

### Why not the humtool estimator

The retouch port contains `estimateTempo`, which scores candidate tempos by how
close onsets fall to a 16th grid anchored at t=0. The PRD measured it
oscillating between 68, 84 and 174 BPM on one take. Two reasons:

1. **It assumes phase zero.** A real take starts when the singer starts, not on
   a beat. A perfect performance offset by an eighth scores terribly.
2. **It has no octave preference.** Every grid that fits also fits at double and
   half speed, and a finer grid always fits at least as well.

The port keeps that function untouched — it is verified against Python and must
not drift (US-0401). The new estimator is a separate module.

### What the new one does

- **Searches phase.** Sixteen positions per beat, finer than the tolerance
  window, so the winning phase cannot change which onsets count.
- **Weights onsets musically.** Longer and louder notes carry more rhythmic
  authority; a held note on a downbeat says more about the pulse than a passing
  sixteenth. Both compressed by a square root so one long note cannot dominate.
- **Applies a perceptual resonance curve.** Log-normal, peaked at 110 BPM,
  symmetric in *ratio* because that is how tempo is heard. This is the classic
  moderate-tempo preference (Parncutt; Moelants).
- **Requires beat coverage.** A tempo whose beats are half empty is a worse
  explanation than one where every beat is played. This is what actually settles
  half-versus-double: steady events once a second fit both 60 and 120 BPM, and
  the difference is that at 120 every second beat is silent.

Onsets come from the melody engine's note starts, not from raw audio. They have
already survived voicing, contour smoothing and segmentation, so a vibrato
wobble or a breath is not mistaken for an attack.

### Groove

`analyzeGroove` reports mean offset, deviation, swing ratio and steadiness. The
product needs this to be able to *keep* it: Natural and Tight are only
meaningfully different if the system knows what the human did and can choose how
much to preserve. Steadiness also scales how much correction Tight applies — a
steady performer barely needs pulling in, and applying a fixed strength to both
is how a good take gets flattened.

---

## Versions

`src/packages/rhythm-extraction/versions.ts`

**The original performance is never destroyed.** Every version is a separate
interpretation computed from the same untouched source, and the source itself is
always one of the options.

| Version | Tempo | Timing | Pitch snap |
|---|---|---|---|
| **Performed** | detected | untouched | none |
| **Natural** | detected | lightly settled (0.2) | half of the slider |
| **Tight** | detected | scaled by looseness | most of the slider |
| **Grid** | **tapped** | full | full |

Natural and Tight use the *detected* tempo. Only Grid uses the tapped one — the
old behaviour, now one option among four rather than the law.

When detection is unreliable, every version falls back to the tapped tempo with
`tempoSource: 'tapped'` recorded, so the UI never claims a tempo was heard when
it was not, and `defaultVersion()` returns Grid rather than Natural.

`compareTempos()` reports a half-or-double disagreement separately, because that
usually means the user tapped eighths while singing quarters — and telling them
that is more useful than silently picking one.

### How versions reach the engine

Through the existing `refine()`, using a new internal `paramOverrides` field so
timing and pitch correction can move independently. The single Raw→Clean slider
remains the only control a *user* sees; every value a preset can set is one the
macro curve could itself produce.

---

## What is still open

- **Server-side processing** (Python, CREPE/pYIN, librosa/madmom) is not built.
  Everything above runs locally in the browser. The `AudioTranscriber` contract
  already models a `server` backend, so adding one is an adapter, not a rewrite.
  Note that moving processing off-device changes the product's headline privacy
  claim and needs the explicit consent path the playbook requires.
- **Accuracy on human recordings is unmeasured.** Every test here uses
  synthesised signals with known right answers, which verifies correctness, not
  accuracy. The corpus remains the blocking item in ADR-001.
