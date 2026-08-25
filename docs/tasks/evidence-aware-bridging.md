# Follow-up task: evidence-aware gap bridging

**Status:** designed, not yet implemented
**Origin:** TARGET TEST forensic pass (commit `de01f9d` context)
**Branch:** `deploy/selfhosted-ai-musician-v1`

## Problem

`bridgeUncertainGaps` fills tracking holes in the accepted contour so one
performed note is not reported as two. Two attempts to extend it were built,
measured on real recordings, and withdrawn:

- octave-aware *interior agreement* in the bridge, and
- an octave-fold continuation grace in voicing.

Both failed the same way on a quiet articulated take (TARGET TEST 3): weak
frames read a subharmonic of the true pitch, the extended bridging let those
readings join and then constitute segments, and downstream register repair
flipped the entire opening phrase from C4-material to C3 — every offset
exactly −12 semitones against both the previous build and the external
reference. The mechanism had three pathways, all of which amount to the same
violation: **inferred frames acquired authority that only measurement may
hold.**

1. Segment-glue authority — filled frames made segmentation merge across
   articulation boundaries, so a segment could contain two registers and its
   settled pitch became whichever cluster outvoted the other.
2. Confidence authority — bridge-written frames entered segment confidence
   averages, re-weighting `stabilizeSegmentOctaves` anchor selection.
3. Repair-anchor authority — written values entered
   `repairSequentialOctaves`' running median, letting inference fold
   measurement.

The holes the withdrawn feature tried to fix are real (a 90–170 ms dropout
mid-sustain splits one hummed note into fragments). The task is to close them
while making it *structurally impossible* for an inferred frame to influence
pitch decisions.

## Requirements

1. No inferred frame may become equivalent to measured evidence.
2. Explicit provenance on every frame: `measured` / `corrected` /
   `interpolated` / `predicted`.
3. Bridged frames:
   - MAY preserve temporal continuity,
   - MAY help duration estimation,
   - MUST NOT influence: `settledPitch` voting, confidence scoring, octave
     repair anchors, or musical correctness decisions.
4. Regression tests must hold:
   - Test 3 opening phrase stays in the correct register;
   - existing bridge motivation cases still improve (realtake ~17.0 s and
     ~23.4 s holes; test3 ~9.8 s and ~14.1 s dropouts);
   - true octave jumps remain separate notes;
   - true rests remain rests.

## Design note

### Provenance model

`PitchFrame.origin?: 'measured' | 'corrected' | 'interpolated' | 'predicted'`
(absent = `measured`, for backward compatibility with fixtures).

- **measured** — value taken directly from an accepted YIN candidate.
- **corrected** — a measured frame whose *value* was transformed by a contour
  stage (octave repair, median smoothing, glitch removal). It keeps the
  authority of measurement: it votes, it scores, it anchors. What changed is
  recorded.
- **interpolated** — a frame whose value is derived from endpoint
  measurements across a filled gap (linear interpolation or held constant).
  Never votes, never scores, never anchors.
- **predicted** — reserved for any future synthesis that is neither a
  measurement nor an endpoint interpolation; treated identically to
  `interpolated`.

### Data flow

```
YIN evidence
  -> decideVoicing            frames stamped 'measured'
  -> smoothPitchContour:
       octaveRepaired         value changes stamp 'corrected'
       range folding          value changes stamp 'corrected'
       +-2 median smoothing   value changes stamp 'corrected'
       bridgeUncertainGaps    fills stamp 'interpolated' (see rules below)
       removeShortGlitches    stamps 'corrected' when it rewrites
       repairSequentialOctaves skips non-measured anchors; own folds stamp
                              'corrected' on measured frames only
  -> segmentPitchContour      voting/confidence measured-only; spans include
                              interpolated frames (duration); stabilizeSegment-
                              Octaves therefore inherits clean anchors
  -> judge features           reference pitches from measured/corrected only
```

### Bridge acceptance rules

A gap is fillable when every current condition still holds (max length,
endpoint agreement within 1.5 st, no silence by the existing ratio) plus one
strengthening that uses the **same existing constant**: instead of "the
loudest interior frame clears the silence ratio", *every* interior frame
must clear it. A sustained tone dips but does not vanish; an articulation
between repeated notes contains near-silent frames even when candidates look
agreeable. This single change is what separates the test3 opening gaps
(digital-silence articulations — refused) from its mid-note dropouts
(continuous energy — filled), with no new thresholds.

When filled, frames are written at the **endpoint register only**
(`before + (after-before) * t`), stamped `'interpolated'`, with confidence
`min(endpoint confidences) * 0.5`. Interior candidates are consulted solely
for the acceptance decision; they are never written.

### Where provenance is consumed

| consumer | rule |
|---|---|
| `buildSegment` | voting (`settledPitch`) and confidence average count measured/corrected frames only; segment start/end span interpolated frames |
| segmentation loop | interpolated frames continue the current region (gap backstop, duration) but never enter `pending`, never trigger split/confirm logic |
| `consolidateSegments` | unchanged — operates on measured-derived segment pitches |
| `stabilizeSegmentOctaves` | unchanged — anchors derive from already-filtered segments |
| `repairSequentialOctaves` | running median accumulates measured/corrected frames only; non-measured frames are neither folded nor anchoring |
| `detectAdaptiveVocalRange` | measured/corrected frames only |
| `judgeFeaturesFromFrames` | reference-pitch series from measured/corrected frames only (musical correctness) |

## Acceptance checks before merge

1. Full unit suite green; new tests cover each consumer rule above.
2. Synthetic end-to-end guard: staccato repeated-tone material with weak
   subharmonic dips transcribes at the sung register (Test 3 opening analog).
3. Fresh TARGET TEST evaluation: Test 2 metrics unchanged; Test 3 opening
   phrase unchanged (60-register); test3/realtake dropout holes closed at the
   endpoint register; KPI comparisons do not regress.
4. Forensic classification of every changed gap: no C-class (silence
   absorbed) results permitted.
