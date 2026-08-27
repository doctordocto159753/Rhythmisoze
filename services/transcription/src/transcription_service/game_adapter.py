"""Running GAME and returning Rhythmisoze transcription evidence.

The small development backend delegates to upstream GAME's PyTorch CLI. The
production large backend uses the official v1.0.3 ONNX graph set through the
local ONNX runner. Both return the same Transcription contract.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .config import Config

_PITCH_CLASS = {
    "C": 0, "C#": 1, "Cb": 11, "D": 2, "D#": 3, "Db": 1, "E": 4, "E#": 5, "Eb": 3,
    "F": 5, "F#": 6, "Fb": 4, "G": 7, "G#": 8, "Gb": 6, "A": 9, "A#": 10, "Ab": 8,
    "B": 11, "B#": 0, "Bb": 10,
}
_SPN = re.compile(r"^([A-Ga-g])([#b]?)(-?\d+)([+-]\d+(?:\.\d+)?)?$")


class AdapterError(RuntimeError):
    """Inference could not be completed. Never a reason to lose the take."""


@dataclass(frozen=True)
class Note:
    start_sec: float
    end_sec: float
    pitch: float


def parse_pitch(raw: str) -> float | None:
    raw = raw.strip()
    if raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        pass

    match = _SPN.match(raw)
    if match is None:
        return None
    key = match.group(1).upper() + (match.group(2) or "")
    pitch_class = _PITCH_CLASS.get(key)
    if pitch_class is None:
        return None
    octave = int(match.group(3))
    cents = float(match.group(4)) if match.group(4) else 0.0
    return (octave + 1) * 12 + pitch_class + cents / 100.0


def parse_csv(text: str) -> list[Note]:
    notes: list[Note] = []
    for line in text.splitlines():
        parts = line.strip().split(",")
        if len(parts) < 3:
            continue
        try:
            start = float(parts[0])
            end = float(parts[1])
        except ValueError:
            continue
        pitch = parse_pitch(parts[2])
        if pitch is None or end <= start:
            continue
        notes.append(Note(start_sec=start, end_sec=end, pitch=pitch))
    notes.sort(key=lambda note: note.start_sec)
    return notes


@dataclass(frozen=True)
class Transcription:
    notes: list[Note]
    elapsed_ms: int


def transcribe(wav_bytes: bytes, config: Config) -> Transcription:
    detail = config.readiness_detail()
    if detail is not None:
        raise AdapterError(detail)

    if config.backend == "onnx":
        from .onnx_runner import transcribe as transcribe_onnx
        return transcribe_onnx(wav_bytes, config)

    started = time.monotonic()
    run_dir = config.work_dir / uuid.uuid4().hex
    audio_dir = run_dir / "in"
    out_dir = run_dir / "out"
    audio_dir.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    source = audio_dir / "take.wav"
    source.write_bytes(wav_bytes)

    try:
        return _run_pytorch(source_dir=audio_dir, out_dir=out_dir, config=config, started=started)
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


def _run_pytorch(*, source_dir: Path, out_dir: Path, config: Config, started: float) -> Transcription:
    try:
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "transcription_service.game_runner",
                "extract",
                str(source_dir),
                "-m",
                str(config.model_file),
                "--glob",
                "*.wav",
                "--output-formats",
                "csv",
                "--output-dir",
                str(out_dir),
            ],
            cwd=str(config.game_dir),
            capture_output=True,
            check=False,
        )
    except OSError as error:
        raise AdapterError(f"could not start inference: {error}") from error

    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        raise AdapterError(detail[-1] if detail else f"exit {completed.returncode}")

    produced = sorted(out_dir.rglob("*.csv"))
    if not produced:
        raise AdapterError("inference produced no output")

    notes = parse_csv(produced[0].read_text(encoding="utf-8"))
    return Transcription(notes=notes, elapsed_ms=int((time.monotonic() - started) * 1000))
