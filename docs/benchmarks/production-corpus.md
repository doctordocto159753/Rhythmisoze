# Production evaluation gate

The measurement foundation lives in [`evaluation/`](../../evaluation/README.md)
at the repository root; this page records how it fits the benchmark suite and
what its first baseline told us.

## Relationship to the other benchmarks

The benchmarks in this directory measure *components* against hand-built
fixtures (architecture quality gate, audio validation thresholds, rhythm
classifier). The production evaluation measures the **whole voice pipeline
end-to-end** — classification, extraction, judge, phrase interpretation —
against synthesised ground truth with exact pitch paths, plus behavioural
baselines on pinned real recordings.

Both run in CI (`npm test`); neither replaces the other. Component fixtures
localise a failure; the corpus quantifies user-visible quality.

## First baseline (2026-08-26)

| area | result | reading |
|---|---|---|
| steady tones, scales, vibrato, whisper level, room noise | 97–99.5% raw pitch accuracy | the YIN core is strong on conventional material |
| octave leap (C4→C5→C4) | 65% RPA, 33% octave errors | the known subharmonic failure, now reproducible with exact truth |
| continuous glissando | 99.3% frame accuracy, note F1 0.00 | tracker fine; segmentation cannot express non-stepped pitch |
| beatbox loop onset F1 ≈ 0.61 | taps 1.00 | drum-loop over-segmentation is the rhythm-side gap |
| judge-stage octave changes | 0 on every case | single-octave-authority rule holds as data |
| pinned real takes (4) | melody route, stable note counts | routing guard effective |

These four gaps — octave ambiguity, glissando segmentation, drum-loop onset
density, and whisper capture — are exactly the queue for the next phases.
Any pipeline change must keep `evaluation/expected/baseline.json` floors green
or raise them deliberately.
