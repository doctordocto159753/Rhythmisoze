"""Measure the Musician pipeline. Reports numbers; asserts nothing.

    python scripts/spike/benchmark.py                 # fake adapters
    MUSICIAN_REAL_MODELS=1 python scripts/spike/benchmark.py   # real weights

## Why this is not a test

A benchmark that asserts a threshold fails on a busy CI runner and tells you
nothing about the code. This prints, and a person reads it. The numbers belong
in the phase report and in `docs/architecture/musician-runtime-adr.md`, not in a
pass/fail gate.

The fake-adapter run measures the deterministic half only: orchestration, the
Identity Guard, ranking, span selection, splicing. That number is genuinely
useful -- it is the floor under any real measurement, and if it ever becomes
significant next to inference, something has gone wrong in the orchestrator.
"""

from __future__ import annotations

import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/musician/shared/src"))
sys.path.insert(0, str(ROOT / "services/musician/api/src"))

from musician_shared.adapters.fake import FakeMelodyAdapter, FakeRwkvAdapter  # noqa: E402
from musician_shared.contract import Key, Meter, Mode, Motif, MusicianInput, Note, Tempo  # noqa: E402
from musician_shared.pipeline import run_musician  # noqa: E402


def melody(length: int) -> MusicianInput:
    shape = [60, 62, 64, 65, 67, 65, 64, 62]
    pitches = [shape[i % len(shape)] + 12 * (i // 24) for i in range(length)]
    notes = []
    cursor = 0.0
    for pitch in pitches:
        notes.append(
            Note(pitch=pitch, start_sec=round(cursor, 6), end_sec=round(cursor + 0.45, 6))
        )
        cursor += 0.5
    return MusicianInput(
        source_id="bench",
        notes=tuple(notes),
        tempo=Tempo(bpm=120.0, confidence=0.8),
        meter=Meter(numerator=4, denominator=4, confidence=0.75),
        key=Key(tonic="C", mode=Mode.MAJOR, confidence=0.7),
        motifs=(Motif(intervals=(2, 2, 1), occurrences=(0,)),),
        duration_sec=cursor + 0.5,
    )


def timed(fn, runs: int = 20) -> tuple[float, float, float]:
    samples = []
    for index in range(runs):
        start = time.perf_counter()
        fn(index)
        samples.append((time.perf_counter() - start) * 1000)
    return (
        statistics.median(samples),
        min(samples),
        max(samples),
    )


def main() -> None:
    real = os.environ.get("MUSICIAN_REAL_MODELS", "").strip() == "1"
    print(f"Musician benchmark -- {'REAL MODELS' if real else 'fake adapters'}")
    print(f"python {sys.version.split()[0]}  platform {sys.platform}")
    print()

    if real:
        print("Real-model benchmarking needs the weights and a built rwkv.cpp.")
        print("Run scripts/models/bootstrap.sh and scripts/vendor/bootstrap.sh first,")
        print("then start the stack and point this at it. Not implemented until")
        print("the compatibility spike has been run -- see")
        print("docs/architecture/musician-runtime-adr.md.")
        return

    print(f"{'notes':>8}  {'median ms':>10}  {'min':>8}  {'max':>8}")
    print("-" * 40)
    for length in (8, 16, 32, 64, 128):
        source = melody(length)
        median, low, high = timed(
            lambda i, s=source: run_musician(
                source=s,
                melody=FakeMelodyAdapter(),
                rwkv=FakeRwkvAdapter(),
                base_seed=i * 31,
            )
        )
        print(f"{length:>8}  {median:>10.2f}  {low:>8.2f}  {high:>8.2f}")

    print()
    print("This is orchestration only: guard, ranking, span selection, splicing.")
    print("Real generation is dominated by inference and is not measured here.")


if __name__ == "__main__":
    main()
