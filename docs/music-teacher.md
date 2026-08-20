# The Music Teacher

**Phase 2.** Package: [`src/packages/music-teacher/`](../src/packages/music-teacher/).

> What a music teacher would suggest after hearing the student's idea.

Input is the **Judge's** melody, never raw audio and never the raw candidate.
Tidying a transcription that still contains a harmonic artifact or an octave
slip produces a tidy version of the wrong notes.

---

## The honest problem with this layer

The Judge can be benchmarked. Its question — *did we understand the human?* —
has a right answer, checkable against onsets, pitches and offsets.

The Teacher has no ground truth. *Would a music teacher suggest this?* is a
judgement, and any number claiming to settle it would be dressing an opinion as
a measurement.

Three things follow, and they shape the whole design:

1. **The coherence score is a proxy, used only to compare two versions of the
   same melody.** It is never presented as a quality score.
2. **The rule order is fixed, not searched.** Searching would optimise the proxy
   directly, which is how a layer like this starts serving its own metric
   instead of the music.
3. **Every change carries a reason.** The honest substitute for a benchmark is
   an explanation a musician can disagree with.

---

## The invariant that makes it safe

**V1 never adds a note and never removes one.**

Only pitch, timing, duration and velocity of existing notes change. The moment a
layer can add notes it is composing, and *did it preserve the melody?* stops
having a checkable answer. With the note count fixed, identity is measurable.

Three further limits, all enforced in the pipeline rather than trusted to the
rules:

| Limit | Value | Why |
|---|---|---|
| Notes edited | ≤ 34% | A teacher who rewrites half a phrase has stopped teaching |
| Single pitch move | ≤ 2 semitones | Further is a different note, not a correction |
| Identity floor | 0.82 | Below this the revision is discarded entirely |

Identity is re-checked **after every accepted edit**, not once at the end: a
series of individually harmless changes can add up to a different tune.

---

## Analysis

One pass, producing what every rule needs.

| Thing | Source |
|---|---|
| Key | the existing Krumhansl-Schmuckler port (181 parity assertions) |
| Scale spelling | Tonal |
| Phrases | silences long relative to the melody's own note lengths |
| Motifs | repeated *interval* patterns |
| Grid | `rhythm-extraction`, recovered from the performance |

Key detection reuses the tested port rather than adding a second detector: two
answers to one question means the tested one is not the one acted on.

**`trusted` requires both confidence and conformance.** A melody 95% diatonic
with one stray note has a mistake in it; a melody 60% diatonic is probably not
in that key at all, and correcting its "wrong" notes would impose a key the
singer never intended.

**The tapped BPM is never consulted.** The brief is explicit, and `teach()` does
not even receive it — it takes notes and a duration, nothing else.

---

## The five rules

In the order a teacher would raise them: notes, then beat, then lengths, then
shape.

### 1. Key coherence
Moves a brief out-of-key note to the nearest note of the key. The brief's own
example: `C D F# E` in C major → `C D F E`.

Requires **all** of: a trusted key, a note short relative to this melody, and a
move of at most a whole tone. A held accidental is the character of the melody,
not a slip — blues and modal lines depend on exactly that.

### 2. Rhythm refinement
Pulls notes that *nearly* landed on the beat onto it. A note 20 ms off was meant
to be on the beat; a note 200 ms off is somewhere else on purpose. Correction
applies only inside a third of a grid step, so syncopation survives.

Proposes nothing when no pulse was confidently heard.

### 3. Duration regularity
Evens a note held slightly longer than its neighbours. Only fires when the
melody's durations are already near-uniform — a melody with genuinely varied
note values has nothing to regularise, and forcing one would flatten it into a
drum machine.

### 4. Motif consistency
*You played that figure twice — make it the same both times.* Aligns durations
between occurrences, **never pitch**: the occurrences were identified by their
intervals, so their pitches already agree. Near-misses only; a substantially
different repeat is a deliberate variation.

### 5. Phrase shaping
Lengthens a clipped final note. Only when the ending is genuinely short relative
to its own phrase, and only into real silence.

---

## Scoring

**Coherence** (the proxy): scale conformance 0.34, rhythmic regularity 0.28,
interval smoothness 0.22, phrase clarity 0.16.

Interval smoothness deliberately does *not* mean "small intervals are better" —
that would score a monotone as perfect. It measures whether leaps are
**resolved**: a leap followed by a step in the opposite direction is the shape
that makes a wide interval sound intended.

**Identity**: notes unchanged, contour preserved, maximum pitch shift,
pitch-class overlap. The aggregate is a **minimum-weighted** combination, not a
mean — an average would let a catastrophic failure in one measure hide behind
three good ones.

---

## On music21

The brief suggested it. **Not adopted**, for three reasons:

1. It is Python, so adopting it means building the server service — which
   changes the product's privacy architecture, since audio would leave the
   device. That is a real product decision, not an implementation detail.
2. Everything V1 needs from it we already have: key detection is the tested
   port, and scale/interval spelling is Tonal, which is TypeScript, MIT and
   ~30 KB.
3. music21's genuine strength — score manipulation and harmonic analysis — is
   beyond V1's capability list.

If harmony analysis or notation export is ever wanted, music21 behind the server
adapter is the right way to get it. The analysis layer is a clean seam for that:
nothing outside `analysis/` knows where the key came from.

**MelodyT5** remains explicitly out of scope, per the brief.

---

## Tests

[`tests/music-teacher/teacher.test.ts`](../tests/music-teacher/teacher.test.ts) — 33 cases.

They assert the two things that *are* checkable: that the constraints hold, and
that the specific suggestions are the intended ones.

The negative cases matter more than the positive ones. A layer that "improves" a
good melody has damaged it, so there are explicit tests that a clean diatonic
line is returned untouched, a held accidental is left alone, a syncopation stays
displaced, and an untrustworthy key produces no pitch changes at all.

---

## Where it sits

| Version | Notes | Timing | Pitch |
|---|---|---|---|
| **Unprocessed** | the candidate, untouched | none | none |
| **Judge** | the faithful repair | barely settled | untouched |
| **Teacher** | the Judge's notes, revised | the Teacher's own decisions | in key |

Retouch is kept deliberately light on the Teacher version. Quantising on top of
the Teacher's own timing decisions would overwrite explained, deliberate choices
with an unexplained grid.

## Not done

- **No listening panel.** Whether these suggestions are ones a real teacher
  would make is unverified by anyone musical. That is the honest gap, and no
  amount of test coverage closes it.
- **Harmony is untouched.** No chords, no implied progression, no cadence
  awareness. Phrase endings are lengthened but not resolved to a stable degree.
- **The rules are not tuned on real recordings.** Thresholds are reasoned from
  musical practice, not fitted to a corpus.
