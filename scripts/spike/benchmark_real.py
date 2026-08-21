"""Measure the real models on this machine.

    python scripts/spike/benchmark_real.py melodyt5 <upstream> <weights.pth>
    python scripts/spike/benchmark_real.py rwkv <tokenizer.json> <weight-stem>

Reports cold load, warm generation and peak RSS. Deliberately one model per
invocation: their dependency stacks cannot coexist in one interpreter (MelodyT5
needs tokenizers<0.20 via transformers 4.40, MIDI-RWKV needs >=0.21), which is
the same reason they are separate containers in production.

`SPIKE_DEVICE=cuda` runs the same measurement on a GPU. Nothing about the code
path changes -- only where the tensors live.
"""

from __future__ import annotations

import contextlib
import io as _io
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("RWKV_V7_ON", "1")
os.environ.setdefault("RWKV_JIT_ON", "1")

DEVICE = os.environ.get("SPIKE_DEVICE", "cpu")
ROOT = Path(__file__).resolve().parents[2]


def rss_mb() -> float:
    import psutil

    return psutil.Process().memory_info().rss / 1048576


def vram_mb() -> float | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        return torch.cuda.max_memory_allocated() / 1048576
    except Exception:
        return None


def bench_melodyt5(upstream: Path, weights: Path) -> None:
    sys.path.insert(0, str(ROOT / "services/musician/shared/src"))
    sys.path.insert(0, str(ROOT / "services/musician/melodyt5-worker/src"))
    os.environ["MUSICIAN_MODELS_DIR"] = str(weights.parent.parent)
    os.environ["MUSICIAN_VENDOR_DIR"] = str(upstream.parent)

    from melodyt5_worker.inference import MelodyT5Runtime
    from musician_shared.contract import Key, Meter, Mode, Note

    baseline = rss_mb()
    runtime = MelodyT5Runtime(device_preference=DEVICE)

    started = time.time()
    with contextlib.redirect_stdout(_io.StringIO()):
        runtime.load()
    cold = time.time() - started
    loaded = rss_mb()

    notes = tuple(
        Note(pitch=p, start_sec=i * 0.5, end_sec=i * 0.5 + 0.45, velocity=90)
        for i, p in enumerate([60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 60])
    )
    meter = Meter(numerator=4, denominator=4, confidence=0.8)
    key = Key(tonic="C", mode=Mode.MAJOR, confidence=0.8)

    print(f"MELODYT5   device={runtime.info().device}  torch={runtime.info().torch_version}")
    print(f"  cold load        : {cold:.2f} s")
    print(f"  RSS after load   : {loaded:.0f} MB  (+{loaded - baseline:.0f} MB)")

    for label, bars, temperature in (("refined-like", 4, 0.70), ("expanded-like", 19, 1.15)):
        started = time.time()
        generated, _ = runtime.generate(
            notes=notes, meter=meter, tempo_bpm=120.0, key=key,
            temperature=temperature, top_k=24, top_p=0.9, seed=20260821, max_patch=bars,
        )
        elapsed = time.time() - started
        print(f"  warm {label:14}: {elapsed:.2f} s -> {len(generated)} notes  ({bars} bar budget)")

    print(f"  peak RSS         : {rss_mb():.0f} MB")
    v = vram_mb()
    if v is not None:
        print(f"  peak VRAM        : {v:.0f} MB")


def bench_rwkv(tokenizer: Path, weight_stem: Path) -> None:
    sys.path.insert(0, str(ROOT / "services/musician/shared/src"))
    sys.path.insert(0, str(ROOT / "services/musician/rwkv-worker/src"))
    os.environ["MIDI_RWKV_TOKENIZER"] = str(tokenizer)
    os.environ["MUSICIAN_MODELS_DIR"] = str(weight_stem.parent)
    os.environ["MIDI_RWKV_WEIGHT"] = weight_stem.name + ".pth"

    from musician_shared.contract import Meter, Note
    from rwkv_worker.inference import RwkvRuntime

    baseline = rss_mb()
    runtime = RwkvRuntime(device_preference=DEVICE)

    started = time.time()
    with contextlib.redirect_stdout(_io.StringIO()):
        runtime.load()
    cold = time.time() - started
    loaded = rss_mb()

    info = runtime.info()
    print(f"MIDI-RWKV  device={info.device}  backend={info.backend}  vocab={info.vocab_size}")
    print(f"  cold load        : {cold:.2f} s")
    print(f"  RSS after load   : {loaded:.0f} MB  (+{loaded - baseline:.0f} MB)")

    pitches = [60, 62, 64, 65, 84, 64, 62, 60, 62, 64, 65, 67, 65, 64, 62, 60]
    notes = [
        Note(pitch=p, start_sec=i * 0.5, end_sec=i * 0.5 + 0.45, velocity=90)
        for i, p in enumerate(pitches)
    ]
    meter = Meter(numerator=4, denominator=4, confidence=0.8)

    timings = []
    for attempt in range(3):
        started = time.time()
        result = runtime.infill(
            left_context=tuple(notes[:2]),
            right_context=tuple(notes[7:13]),
            span=tuple(notes[2:7]),
            meter=meter, tempo_bpm=120.0,
            temperature=0.95, top_k=48, top_p=0.94, seed=20260821 + attempt,
        )
        timings.append(time.time() - started)
        if attempt == 0:
            print(f"  first infill     : {timings[0]:.2f} s -> {[n.pitch for n in result]}")
    print(f"  warm infill (x3) : {sum(timings) / len(timings):.2f} s mean")
    print(f"  peak RSS         : {rss_mb():.0f} MB")
    v = vram_mb()
    if v is not None:
        print(f"  peak VRAM        : {v:.0f} MB")


if __name__ == "__main__":
    which = sys.argv[1]
    print("=" * 66)
    print(f"REAL MODEL BENCHMARK  ({which}, device={DEVICE})")
    print("=" * 66)
    if which == "melodyt5":
        bench_melodyt5(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        bench_rwkv(Path(sys.argv[2]), Path(sys.argv[3]))
