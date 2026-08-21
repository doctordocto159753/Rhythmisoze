# The AI Musician pipeline

**Phase 3.** Service: [`services/musician/`](../../services/musician/).

> What would a skilled musician, with a large musical vocabulary, do with *this*
> idea?

Input is the **Teacher Version** — symbolic, never raw audio. Output is two
variants, Refined and Developed. The Musician is optional: Unprocessed, Judge and
Teacher appear immediately and are unaffected by it being slow, down, or absent.

---

## One sequence, run twice

```text
Teacher Version
      │
  normalise → canonical contract → music21 validation → ABC
      │
  MelodyT5 variation ──► 4 candidates
      │
  Identity Guard ──► reject anything that left the idea behind
      │
  rank survivors on musical structure
      │
  nominate weak span(s) ──► MIDI-RWKV infill ──► accept only on evidence
      │
  Identity Guard again
      │
  Refined  |  Developed
```

Both models run for both variants. **This supersedes the earlier
one-model-per-output mapping**, which described what each model is good at and
then mistakenly turned that into product structure. MelodyT5 does global
variation; MIDI-RWKV does local infill. Those are different *jobs*, not different
products.

---

## What actually separates the two

Policy — and it lives in one inspectable object per variant
([`policies.py`](../../services/musician/shared/src/musician_shared/policies.py)),
not scattered `if kind == REFINED` branches.

| | Refined | Developed |
|---|---|---|
| Sampling temperature | 0.70 | 0.95 |
| Motif floor | 0.60 | 0.45 |
| Identity floor | 0.78 | 0.62 |
| Duration tolerance | 0.88–1.15× | 0.80–1.45× |
| Infill spans | ≤ 1 | ≤ 3 |
| Meter | preserved | preserved |

Meter is fixed in **both**. V1 has no classified meter transformation, so a
meter change is a rejection rather than a silent switch.

The numbers are reasoned, not fitted. There is no corpus of "correct"
refinements to fit them to, and tuning them against our own identity score would
be optimising the proxy instead of the music.

`test_pipeline.py` asserts the difference two ways: structurally (the policy
objects differ in five dimensions) and behaviourally (over twelve seeds,
Developed changes more notes than Refined). If those two columns ever converge,
the feature has stopped offering a choice, and the test says so.

---

## The Identity Guard

Mandatory, deterministic, and **not a quality score**.

A generative model returning valid notation is not evidence it kept the user's
idea — only evidence that it returned valid notation. Eight dimensions:
interval-contour similarity, motif survival, phrase similarity, tonal
compatibility, meter compatibility, duration ratio, pitch-range change, note
density change.

### Why DTW here and not in the Judge

The Judge forbids time warping because its candidate was derived from the audio,
so warping would hide the rhythm distortion it exists to catch. The Musician is
*deliberately allowed* to alter timing while keeping the tune, so a
timing-independent comparison is exactly the right instrument. Same technique,
opposite reason.

### Why the aggregate is not a mean

A mean lets a catastrophic failure in one dimension hide behind good scores in
the others — a candidate that abandons the motif but keeps meter, duration and
range would average out respectably. The aggregate is `0.65 × weighted mean +
0.35 × worst dimension`.

### When nothing survives

The Teacher material is returned unchanged. Handing back the least-bad reject
would make the guard decorative, which is the exact failure it exists to prevent.

---

## Weak-span selection

RWKV must not rewrite the whole tune — if it could, there would be no reason to
run MelodyT5 first and no way to say afterwards what changed. Spans are chosen
**before any model is consulted**, from structural evidence:

| Heuristic | Looking for |
|---|---|
| interval outlier | a leap far wider than this melody's habit |
| density anomaly | a run much shorter or longer than the melody's habit |
| awkward transition | a gap too long to be phrasing, too short to be a rest |
| weak closure | a final note markedly shorter than its neighbours |

All relative to the melody itself: a wide leap in a line full of wide leaps is
the style, and an absolute threshold would flag the whole piece. Overlapping
nominations are merged — two heuristics firing on the same bars is one weak span,
and infilling it twice means the second pass rewrites the first's work.

Every nomination carries a readable reason. "The model changed bars 3–4" is not
reviewable; "bars 3–4: interval outlier, 20 semitones against a median of 2" is.

### Acceptance

An infill is kept only when local coherence improves by at least the policy's
margin **and** the guard still passes **and** no global dimension degrades
materially. Otherwise the MelodyT5 candidate stands.

If the RWKV worker is unavailable, the candidate stands too. Infill is an
improvement pass, not a requirement, and failing the whole variant over an
optional stage would take the feature away for no reason.

---

## Invariants

| | Enforced by |
|---|---|
| Teacher input is never mutated | `MusicianInput` is frozen; asserted by value |
| Infill changes only its span | splice is by index; re-checked in the HTTP adapter |
| Generation is reproducible from seed + parameters | seeds derived, not drawn; asserted |
| No raw audio anywhere | the contract has no audio field; asserted |
| Nothing accepted because a model returned it | guard gates every stage |

---

## The API

`POST /v1/jobs` returns a job id immediately; generation is asynchronous.
`GET /v1/jobs/{id}`, `DELETE /v1/jobs/{id}` to cancel. Also `/health`, `/ready`,
`/v1/models`, `/metrics`.

Cancellation is cooperative: the pipeline checks between candidates and between
infill spans, so a cancel waits at most one model call. Killing mid-inference
would leave a warm worker in an unknown state, which costs more than the wait.

Results carry symbolic notes, provenance and diagnostics — never raw model
output, tokens, ABC the model produced, or stack traces. Those belong in a log,
not a response body.

---

## Testing without weights

Both models sit behind adapters. The fakes are deterministic and **transform**:
a fake that returned its input unchanged would satisfy every "nothing was
corrupted" test and prove nothing, and one that returned noise would fail
everything and never exercise the accepting path. They respond to sampling
parameters, so the Refined/Developed difference can be asserted rather than
assumed.

104 tests run with no weights present. The real-model suite is opt-in via
`MUSICIAN_REAL_MODELS=1`.

---

## Not done

- **No frontend integration.** Deliberately out of scope for this phase.
- **The real models have not been run.** Weights were not downloaded here, so
  AC-02, AC-03 and every benchmark number are unverified. See
  [`musician-runtime-adr.md`](musician-runtime-adr.md) for the full list of what
  is and is not verified.
- **No listening panel.** Whether these variants are ones a musician would
  endorse is unverified by anyone musical, and no amount of test coverage closes
  that gap.
- **The rwkv.cpp sampling path is incomplete.** It needs the tokeniser wired to
  the vendored MIDI-RWKV vocabulary; the pip runtime is the working fallback.
