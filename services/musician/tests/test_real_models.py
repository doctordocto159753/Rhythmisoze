"""Opt-in smoke tests against the real weights.

    MUSICIAN_REAL_MODELS=1 python -m pytest tests/test_real_models.py

Skipped by default, and normal CI never runs them (AC-09). They need ~1.43 GB
fetched by `scripts/models/bootstrap.{sh,ps1}` and, for the worker paths, a
running stack.

## What these are for, and what they are not

They are a smoke test: *do the real models load, and does what comes back
survive the same validation as everything else?* They are not a quality
evaluation. Whether MelodyT5's variation is musically good is not a thing a test
can assert, and pretending otherwise would be the same mistake as presenting the
identity score as a quality score.

Fixtures are deliberately tiny. The point is to prove the path works end to end,
not to benchmark it -- benchmarking is `scripts/spike/benchmark.py`, which
reports numbers rather than asserting them.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from conftest import build_input

pytestmark = pytest.mark.real_models

REAL = os.environ.get("MUSICIAN_REAL_MODELS", "").strip() == "1"
MODELS_DIR = Path(os.environ.get("MUSICIAN_MODELS_DIR", "../../models"))

pytestmark = [
    pytest.mark.real_models,
    pytest.mark.skipif(
        not REAL,
        reason="opt-in: set MUSICIAN_REAL_MODELS=1 and fetch weights with scripts/models/bootstrap.sh",
    ),
]


def _require(path: Path) -> Path:
    resolved = (Path(__file__).parent / MODELS_DIR / path).resolve()
    if not resolved.exists():
        pytest.skip(f"{resolved} not present; run scripts/models/bootstrap.sh")
    return resolved


class TestManifestIntegrity:
    def test_every_downloaded_artifact_matches_its_recorded_checksum(self) -> None:
        """The manifest is a claim; this checks it.

        A manifest nobody verifies is a comment.
        """
        import hashlib
        import json

        manifest_path = (Path(__file__).parent / "../../../models/manifest.json").resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        for model in manifest["models"]:
            artifact = model["artifact"]
            path = _require(Path(artifact["destination"]))
            assert path.stat().st_size == artifact["expectedBytes"], (
                f"{model['name']} is {path.stat().st_size} bytes, "
                f"manifest says {artifact['expectedBytes']}"
            )
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            assert digest.hexdigest() == artifact["sha256"], f"{model['name']} checksum mismatch"


class TestMelodyT5:
    def test_the_published_weights_load_and_produce_parseable_output(self) -> None:
        """AC-02."""
        _require(Path("melodyt5/weights.pth"))
        from melodyt5_worker.inference import MelodyT5Runtime

        runtime = MelodyT5Runtime(device_preference="cpu")
        runtime.load()
        assert runtime.loaded

        source = build_input([60, 62, 64, 65, 67, 65, 64, 62])
        notes, raw_abc = runtime.generate(
            notes=source.notes,
            meter=source.meter,
            tempo_bpm=source.tempo.bpm,
            key=source.key,
            temperature=0.7,
            top_k=24,
            top_p=0.88,
            seed=1234,
        )
        assert notes, "MelodyT5 returned nothing parseable"
        assert raw_abc
        # Whatever it returned has to survive the same validation as everything
        # else. A model is not exempt from the contract.
        for note in notes:
            assert 0 <= note.pitch <= 127
            assert note.end_sec > note.start_sec

    def test_generation_is_reproducible_from_a_seed(self) -> None:
        """AC-08 against the real model, which is where it can actually fail.

        A worker that seeds once at startup passes every fake-adapter test and
        still makes the provenance record a lie.
        """
        _require(Path("melodyt5/weights.pth"))
        from melodyt5_worker.inference import MelodyT5Runtime

        runtime = MelodyT5Runtime(device_preference="cpu")
        runtime.load()
        source = build_input([60, 62, 64, 65, 67])

        def once() -> list[int]:
            notes, _ = runtime.generate(
                notes=source.notes,
                meter=source.meter,
                tempo_bpm=source.tempo.bpm,
                key=source.key,
                temperature=0.7,
                top_k=24,
                top_p=0.88,
                seed=99,
            )
            return [n.pitch for n in notes]

        assert once() == once()


class TestMidiRwkv:
    def test_the_published_model_loads_and_performs_an_infill(self) -> None:
        """AC-03."""
        _require(Path("midi_rwkv.pth"))
        from rwkv_worker.inference import RwkvRuntime

        runtime = RwkvRuntime(device_preference="cpu")
        runtime.load()
        assert runtime.loaded

        source = build_input([60, 62, 64, 84, 62, 60, 62, 64, 65])
        result = runtime.infill(
            left_context=source.notes[:3],
            right_context=source.notes[6:],
            span=source.notes[3:6],
            meter=source.meter,
            tempo_bpm=source.tempo.bpm,
            temperature=0.7,
            top_k=24,
            top_p=0.88,
            seed=4321,
        )
        assert result, "MIDI-RWKV returned no notes for the span"

    def test_infill_stays_inside_its_span(self) -> None:
        """AC-06 against the real model.

        The span boundary is imposed on our side rather than requested, because
        a model is not a contract. This proves the imposition holds.
        """
        _require(Path("midi_rwkv.pth"))
        from rwkv_worker.inference import RwkvRuntime

        runtime = RwkvRuntime(device_preference="cpu")
        runtime.load()

        source = build_input([60, 62, 64, 84, 62, 60, 62, 64, 65])
        span = source.notes[3:6]
        result = runtime.infill(
            left_context=source.notes[:3],
            right_context=source.notes[6:],
            span=span,
            meter=source.meter,
            tempo_bpm=source.tempo.bpm,
            temperature=0.7,
            top_k=24,
            top_p=0.88,
            seed=4321,
        )
        assert len(result) == len(span)
        assert result[0].start_sec == pytest.approx(span[0].start_sec)
        assert result[-1].end_sec == pytest.approx(span[-1].end_sec)


class TestCpuIsTheBaseline:
    def test_neither_worker_requires_a_gpu(self) -> None:
        """AC-13 and AC-14.

        `auto` on a machine without CUDA must resolve to CPU, not raise.
        """
        from melodyt5_worker.inference import MelodyT5Runtime
        from rwkv_worker.inference import RwkvRuntime

        assert MelodyT5Runtime(device_preference="auto").resolve_device() in ("cpu", "cuda")
        assert RwkvRuntime(device_preference="auto").resolve_device() in ("cpu", "cuda")
        assert MelodyT5Runtime(device_preference="cpu").resolve_device() == "cpu"
        assert RwkvRuntime(device_preference="cpu").resolve_device() == "cpu"
