# Rhythm classifier evaluation

**US-0503.** "Classification approach and training/reference source, if any, are
documented and licensed. Evaluation metrics are recorded on the corpus."

## Approach and why it is not a model

A transparent rule-based nearest-prototype classifier over five spectral
features. No training data, and therefore no training-data licence to get wrong.

Two reasons this beats a small neural net here:

1. **Provenance.** US-0503 requires a documented, licensed training source. No
   licensed beatbox corpus is available, and shipping a model trained on scraped
   audio would be a real legal problem rather than a theoretical one.
2. **Explainability.** When a user says "my snare came out as a kick", the
   per-class scores are inspectable and the prototype that caused it can be
   adjusted. A net gives a number and no recourse.

## Features

Extracted from a 40 ms attack window at each detected onset:

| Feature | Why it separates the classes |
|---|---|
| `lowRatio` (energy below 250 Hz) | The strongest single separator of kick from hat |
| `centroidHz` (spectral centroid) | Compared on a log scale, so 300→600 Hz counts the same as 3→6 kHz |
| `zeroCrossingRate` | Distinguishes a breathy snare from either neighbour |
| `decaySec` | A hat dies in ~30 ms, a kick takes ~120 ms |
| `peak` | Velocity, not classification |

## Prototypes

| Class | lowRatio | centroid | ZCR | decay |
|---|---|---|---|---|
| kick | 0.72 | 320 Hz | 0.06 | 0.12 s |
| snare | 0.22 | 2200 Hz | 0.24 | 0.09 s |
| hat | 0.05 | 7200 Hz | 0.46 | 0.035 s |

Weights: 0.38 low-band, 0.30 log-centroid, 0.22 ZCR, 0.10 decay. Distances are
inverted into scores summing to 1, and confidence is the winner's margin over
the runner-up, rescaled to 0–1. Below 0.55 the stroke is `unknown`.

**These are physically motivated defaults, not fitted values.** They describe how
a person makes each sound: lips and a closed throat put energy under 250 Hz, a
"tss" against the teeth puts it above 4 kHz, a breathy "puh" is broadband with a
high zero-crossing rate.

## The `unknown` class

A real outcome, not a failure. An ambiguous stroke is voiced as a closed hat —
the least intrusive member of the kit — and flagged in diagnostics, rather than
being guessed into a kick that lands wrong on the downbeat. The count appears in
`ProcessingDiagnostics.warnings` as `ambiguous_onsets:N`.

## Evaluation

**Scored on synthetic fixtures only.** `tests/unit/audio-core.test.ts` builds
each class from a decaying tone plus filtered noise and asserts the classifier
names it correctly, that a genuinely ambiguous feature vector produces low
confidence, and that the three scores always sum to 1.

That verifies the classifier does what it is designed to do. It does not
establish accuracy on human beatboxing.

| Metric | On synthetic fixtures | On the corpus |
|---|---|---|
| Kick recall | pass | — |
| Snare recall | pass | — |
| Hat recall | pass | — |
| Unknown rate | — | — |
| Onset recall | pass (4/4 at ±30 ms) | — |
| Double-trigger rate | pass (collapsed within 55 ms) | — |

## How to evaluate properly

1. Record 4+ beatbox fixtures with per-onset ground truth: time and class.
2. Score onset detection first — a missed onset is not a classification error
   and mixing them hides which stage is at fault.
3. Build the 3×4 confusion matrix (three true classes against three plus
   `unknown`).
4. If a class is systematically wrong, move its prototype, not the weights.
   Weights change every class at once.
5. Record the matrix here with the corpus version.

## Onset detection

Half-wave-rectified spectral flux, normalised, peak-picked against an adaptive
median threshold. Frame 1024, hop 256, so temporal resolution is ~5.8 ms at
44.1 kHz — comfortably inside the ±20 ms the playbook asks of onsets.

The 55 ms minimum gap is the double-trigger guard: faster than any beatbox
stroke a person articulates cleanly, so anything closer is the decay of the
previous hit. Within the guard window the *stronger* hit wins rather than the
first, so a soft pre-echo cannot mask the real attack.
