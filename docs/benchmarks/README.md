# Benchmarks

What has been measured, what has not, and where the numbers that are currently
engineering defaults came from.

The rule for this directory: **a threshold that was chosen rather than measured
says so.** An unmeasured number presented as a measurement is worse than no
number, because it stops anyone from measuring it.

| Document | Covers | State |
|---|---|---|
| [architecture-quality-gate.md](architecture-quality-gate.md) | US-0005, the browser-vs-server comparison | **Not run.** Method and corpus definition only. |
| [audio-validation-thresholds.md](audio-validation-thresholds.md) | Silence, clipping and "too short" gates | Derived, with the reasoning; not calibrated on human recordings |
| [metronome-drift.md](metronome-drift.md) | US-0203 drift tolerance | Design and unit-test bound; not measured on device |
| [rhythm-classifier.md](rhythm-classifier.md) | US-0503 kick/snare/hat evaluation | Method defined; scored only on synthetic fixtures |
| [capture-constraints.md](capture-constraints.md) | US-0205 microphone constraints | Reasoned; requires device testing |
| [performance-budgets.md](performance-budgets.md) | PRD §8 targets and how each is instrumented | Sample-pack desktop gate measured; wider matrix remains open |

## How to run what exists

```bash
npm run test                 # 389 unit tests, including the humtool parity suite
npm run fixtures:golden      # regenerate golden fixtures from the Python reference
npm run test:e2e             # browser matrix (needs `npx playwright install`)
npm run build                # production build, reports route sizes
```

The parity suite is the one benchmark that is fully in place: every expected
value in `tests/fixtures/golden/` came out of the real `humtool.py`, and CI
regenerates them and fails on any diff.
