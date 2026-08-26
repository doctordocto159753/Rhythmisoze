# Evidence, and who decides what

How Rhythmisoze gets from a recording to a set of notes, after the change that
removed the tempo step and added a second opinion about register.

## The shape

```
RAW USER AUDIO                      immutable; never overwritten, never enhanced in place
      │
      ├─ melody-contour   YIN → contour → segmentation, in the browser
      ├─ basic-pitch      the same audio, second model, in the browser
      └─ game             the same audio, optional service, off by default
      │
   REGISTER ARBITRATION              the only fusion that exists (see below)
      │
   CANDIDATE NOTES                   absolute source seconds, throughout
      │
   JUDGE                             faithfulness; defers to the settled register
      │
   PHRASE MODEL                      continuity, without moving an onset
      │
   Faithful → Shaped → Developed → Expanded
```

Everything downstream of the audio speaks in **absolute seconds from the start
of the recording**. No stage converts to beats, and no stage has a grid to
convert to unless the performance had a measurable pulse.

## What each engine is trusted for

Not an opinion. Measured on `evaluation/`'s synthesised corpus, which has exact
ground truth because it is generated rather than recorded.

| | boundaries | register | pitch class | voicing |
|---|---|---|---|---|
| `melody-contour` | **0.90** | 0.20 | 0.85 | **0.90** |
| `basic-pitch` | 0.15 | **0.85** | 0.70 | 0.40 |
| `game` | **0.95** | **0.90** | 0.90 | 0.75 |

The two browser engines are near-perfect inverses, and that is the whole reason
this architecture exists:

- `melody-contour` reports one held note as **one note** (note F1 1.00 on every
  steady case) and cannot hear an octave leap (32.6% octave error on
  `diff-octave-leap`, with 98.9% chroma accuracy — it has the note right and the
  register wrong).
- `basic-pitch` has **0% octave error** across the corpus, including that case,
  and splits one held tone into **twenty-four notes**.

Neither is the better transcriber. They are good at different questions.

## Only one fusion is implemented, on purpose

`arbitrateRegister` reconsiders the octave and nothing else. Boundaries, voicing
and pitch class stay exactly as the contour engine measured them.

The other dimensions are *named* in `EngineStrengths` and left unimplemented.
Writing weighting rules whose effect nobody has observed is the failure mode
this whole architecture exists to leave behind; naming them means adding one
later is filling in a declared blank rather than inventing a vocabulary.

### Three gates, each from a case that broke without it

**Coverage ≥ 0.6.** A real correction is a witness that hears the other octave
for the *whole* note. On `diff-octave-leap` the C5 covers 95% of the span. On
`diff-harmonic-heavy`, where the contour engine is entirely correct and Basic
Pitch is emitting harmonics as notes, the octave-up candidate covers 26%.

**Dominance ≥ 0.2.** A witness reporting clutter is not testifying about the
octave. Over that same harmonic span the loudest thing it reports is a different
pitch class altogether, which disqualifies the reading rather than merely
outranking it.

**Two agreeing engines.** The first two gates were derived from synthesised
audio and are sufficient there. On the pinned real recordings they are not — one
witness moved seven notes, and checking them against a second model rather than
against an assumption about what a singer would plausibly do gave:

| take | span | contour | basic-pitch | GAME |
|---|---|---|---|---|
| `real-mouth-test3` | 1.07 s | 60 | 48 | 48 |
| `real-mouth-test3` | 5.37 s | 60 | 48 | 48 |
| `real-recording-8` | 6.70 s | 53 | 65 | 65 |
| `real-test22` | 1.56 s | 57 | 45 | **53** |
| `real-test22` | 2.30 s | 57 | 45 | **64** |

The first three are two models trained on real singing agreeing against a YIN
tracker. The last two are the witnesses disagreeing with each other. A single
witness states both in the same words with the same confidence; corroboration
tells them apart, and needs no theory about which intervals people sing.

No engine may act alone. `soloRegisterStrength` is set above every engine in the
roster, because the best of them has *no measured register accuracy on real
takes* — there is no ground truth for those recordings. It is a threshold a
future engine could earn, not a door standing open.

### Nothing is thrown away

Every note gets a `RegisterDecision`, including the ones where nothing moved:
`agreed`, `corrected`, `declined_partial`, `declined_contested`,
`declined_uncorroborated`, `no_evidence`. The declines are the useful half — a
correction that fired is visible in the notes, and one that was considered and
refused is invisible unless it is written down. Those are exactly the takes that
come out wrong with nobody able to say why.

They reach the diagnostics warnings and the debug view, never the creative one.

## Two configurations, both measured

| | delivered octave error on `diff-octave-leap` | note F1 | interval agreement |
|---|---|---|---|
| default (browser only) | 32.6% | 0.67 | 0% |
| with the GAME service | **0.0%** | **1.00** | **100%** |

Both are graded by the gate. The default configuration must move **no** note —
asserted, because "a deployment without the optional service transcribes exactly
as it did before" is a promise, and an untested promise about the configuration
most people are on is not one. The full configuration must never worsen a case
and must fix the leap.

Without the service the product is complete. Disagreements are reported where
they used to be silent, which is strictly more than the pipeline had before.

## Tracker accuracy and delivered accuracy are different numbers

The evaluation report has two columns per case.

`tracker` grades the frames the contour engine produced. They are **never
revised**: frames are what was physically measured, and rewriting them to agree
with a later decision would destroy the only record of what was heard. On
`diff-octave-leap` the tracker's octave error stays 32.6% forever.

`delivered` grades what the product hands the user, sampled from the notes it
actually produces. That is the number that moves to 0.0%.

They used to be one number, because nothing sat between the tracker and the
result. Collapsing them now would either hide the improvement or restate the
tracker's accuracy as the product's.

## The Judge still owns faithfulness, and still defers

`respectCandidateRegister` is unchanged: the Judge reports octave conflicts
rather than resolving them. That was correct when the candidate's register was
one engine's unchecked reading, and it is still correct — what changed is *who*
settled the register before the Judge saw it. It is now an arbitration over
independent measurements, which is why it can be trusted with more.

The Judge is not an arranger. It does not correct an unusual note because theory
dislikes it, and it does not repair one model using guesses from that same model.

## Not implemented, and why

**Evidence preparation views.** `AudioViewId` allows `normalized`, `denoised`
and `voice-isolated`; everything currently reads `original`. A denoiser that
makes a recording cleaner to a human can remove harmonics a pitch model needed,
so an enhanced view has to be measured as an *addition* to the evidence before
it can be offered — and nothing here has measured one. The identity of the view
travels with every reading so that measurement is possible without a migration.

**Chunking.** Nothing chunks. Both browser engines take the whole clip and the
service accepts sixty seconds, which is the recording cap. Should longer
material arrive, the rule is in the guide and not yet in code: chunk at
low-activity boundaries with overlap, stitch against absolute source time, and
never let a boundary the computer needed become a musical one.
