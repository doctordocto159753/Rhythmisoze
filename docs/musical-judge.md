# The Musical Judge

**Phase 1 of the musical judgement layer.** Package:
[`src/packages/musical-judge/`](../src/packages/musical-judge/).

---

## One question

> Did we understand the human correctly?

That is the whole scope. The Judge does not compose, harmonise, improve style,
or move anything toward a key or a grid. Those are the Music Teacher's job
(Phase 2), and the separation is not tidiness — it is what makes this half
*measurable*.

The Judge's question has a right answer that can be checked against onsets,
pitches and offsets, so it can be benchmarked like any transcription system.
The Teacher's question — *what would a music teacher fix?* — does not. If the
two were merged we could no longer tell whether the system understood the
recording or merely made it prettier.

A wandering, out-of-tune hum transcribed perfectly scores **1.0**, and it
should.

---

## Where it runs

Inside the transcription worker, immediately after the melody engine, reusing
the contour that engine already computed.

```text
audio ─► melody engine ─► candidate notes ─┐
              │                            ├─► Judge ─► repaired notes + verdict
              └── pitch contour ───────────┘
```

Re-tracking the fundamental purely to check it would roughly double the wait for
no extra information, so `judgeFeaturesFromFrames()` takes the frames straight
through. Only onset detection is done again, because the timing score has to
compare note starts against *audio* attacks rather than against themselves.

The candidate is returned untouched alongside the repair. Neither overwrites the
other — that is what lets the product still offer an unprocessed version.

---

## Scoring

Five components, each aimed at a failure that was actually observed.

| Component | Weight | The failure it catches |
|---|---|---|
| `pitch` | 0.32 | octave errors, wrong notes |
| `parsimony` | 0.28 | **harmonic artifacts** |
| `coverage` | 0.16 | sung material with no note at all |
| `timing` | 0.14 | onsets drifted off the attacks |
| `fragmentation` | 0.10 | one held note reported as three |

`parsimony` carries the most weight after pitch because it catches the hardest
case. A harmonic reported as a note has a *perfectly good pitch* and a
*perfectly good onset* — the only thing wrong with it is that nothing in the
audio was ever at that pitch. Only a per-note support test against the reference
contour finds it.

`pitch` outranks `timing` deliberately: a note in the right place with the wrong
pitch is a worse failure than the reverse.

### Why the pitch score is frame-aligned, not DTW

DTW is the right tool for comparing two performances that share a shape but not
a timeline. Here the candidate was *derived from this very audio*, so the
timelines already align — and warping them would actively hide the rhythm
distortion the Judge exists to catch.

DTW is therefore used only for `melodicShape`, a timing-independent read that is
reported for diagnostics and **never mixed into `overall`**. It answers a
different question — *is this the right tune, played wrong?* — which is what the
Teacher will need.

### Abstention

A take with no voiced frames returns 0.5 across the board rather than 0 or 1.
Scoring it 0 would make the optimizer delete every note chasing an unreachable
improvement; scoring it 1 would claim a perfect understanding of silence.

---

## Repair operators

Four deterministic, pure transformations. **None may invent musical content.**
They delete, transpose by an octave, merge and trim — every one justifiable
frame by frame against the reference contour.

### `remove-unsupported`

Drops notes whose pitch disagrees with the contour under their own span, or that
cover no voiced audio at all.

A note an octave away is **left alone** for the octave corrector, so the user's
material is repaired rather than deleted.

### `correct-octaves`

Tries ±12 and ±24 semitones per note. Two gates decide whether a shift may be
applied at all, and together they encode where the Judge's authority ends.

**The evidence gate.** A shift is applied only when the measured frames under
the note explain the shifted register decisively — at least 60% of the span,
within a 1.2-semitone window, and by at least 25 points over the support the
note's current pitch has. This refuses both the fold driven by a noisy minority
reading and the mirror mistake of moving notes away from what the audio says.

**The authority gate.** The voice pipeline sets `respectCandidateRegister`:
its candidate's register was itself chosen from measurement — segmentation
votes with measured frames, and register folding uses phrase context the Judge
does not see. Re-deciding that per-note from local frames alone makes the
less-informed opinion win, which is how one confidently-tracked subharmonic
became whole phrases flipped an octave between stages. Under this flag the
corrector moves nothing; every register disagreement is instead listed in
`JudgeResult.octaveConflicts` (and surfaced on `TranscriptionResult.judge`) with
the support numbers that describe it. One octave authority — the extraction
stage — and the uncertainty stays visible rather than being silently resolved.

### `merge-fragments`

Adjacent same-pitch notes separated by less than 90 ms become one. The merged
note keeps the earliest start, the latest end and the loudest velocity. A clear
gap is left alone — a deliberate re-articulation is not a fragment.

### `reconstruct-durations`

A note's end is decided by three pieces of evidence, in order of authority:

1. **The next note's onset** — a monophonic line cannot overlap itself.
2. **Where the voiced audio stopped** — a note may not outlast its sound.
3. **Its existing end**, if neither shortens it.

Notes are extended as well as trimmed: cutting a 900 ms held note at 200 ms is
just as wrong as running one past its sound.

---

## The optimizer

Beam search, width 4, at most 4 rounds.

**Why a search at all:** the operators interact. Removing unsupported notes
before correcting octaves deletes material transposition would have rescued;
doing it the other way keeps it. There is no single correct order, because the
right one depends on the take.

**Why not brute force:** four operators over four rounds is 256 sequences, each
needing a full scoring pass. A beam of four finds the same answer on every case
in the suite at roughly a sixteenth of the cost.

Three invariants:

- **Deterministic.** No randomness, so one recording always produces one repair.
  A Judge that returns different notes on two runs cannot be benchmarked.
- **Never worse than its input.** The original is seeded into the beam and wins
  ties, so repair can only improve the score or leave it alone.
- **Never destroys the source.** The input is returned untouched beside the
  repair.

Between two equally-scoring results, the one that touched less of the user's
material wins.

---

## Where the verdict goes

`TranscriptionResult.judge` carries the repaired notes, both scores, and a
readable account of what was done. The review screen shows the correction count
against the reading the Judge produced.

The three versions the user sees:

| Version | Notes it is built from | Timing | Pitch |
|---|---|---|---|
| **Unprocessed** | the candidate, untouched | none | none |
| **Judge** | the repair | barely settled | untouched |
| **Teacher** | the repair | put in time | put in key |

The Teacher builds on the Judge's output, never on the raw candidate — tidying
a transcription that still contains a harmonic artifact produces a tidy version
of the wrong notes.

The Judge version deliberately leaves pitch alone. Snapping to a scale there
would be the Teacher's job done in the wrong place, and it would make the
faithfulness score meaningless.

---

## Tests

[`tests/musical-judge/judge.test.ts`](../tests/musical-judge/judge.test.ts) — 28
cases over a synthesised A3-B3-C4-D4-E4 hum with two harmonics.

Each case hands the Judge a *deliberately corrupted* transcription of a phrase
whose correct answer is known, and asserts the corruption is undone. The
assertion is never "the score went up" — any scoring function can be made to
satisfy that. It is "the ghost note is gone", "the note is back in the octave
that was sung", "the three fragments are one note".

Covered: clean melody, octave error, harmonic duplicate, fragmented notes,
duration overrun, empty input, silence, determinism, and the exact failure shape
from the report (`A2` where `A3` was sung, plus a harmonic ghost).

---

## What is not done

- **No real human recordings.** Every fixture is synthesised, which verifies
  correctness rather than accuracy on human input. The regression corpus is
  still the blocking item in ADR-001.
- **No Python/CREPE/Essentia path.** The brief listed those as possible tools;
  the existing YIN tracker and spectral-flux detector already produce the two
  representations the Judge needs, and reusing them keeps this entirely local
  and adds no infrastructure. If a corpus later shows the reference contour is
  the accuracy ceiling, a stronger tracker slots in behind
  `extractJudgeFeatures()` without touching scoring, repair or the optimizer.
- **The Teacher is now built.** See [`music-teacher.md`](music-teacher.md). It
  takes the Judge's output and never the raw candidate.
