"""Running upstream GAME and reading its answer.

## What this module is allowed to know

Where the audio is, how to start GAME, and how to read the CSV it writes.
Nothing else. In particular it does not know that GAME slices audio at
silences, that its segmenter runs a D3PM sampling loop, that boundaries become
durations, or that chunk results are stitched back with their offsets. Those
are GAME's, and every previous attempt to reproduce them here made the
transcription worse:

- the first large ONNX runner pushed whole recordings through the graphs and
  laid the regions end to end, deleting every rest;
- the second reimplemented upstream's slicer and stitching faithfully enough to
  pass a parity check, and still did not match the standalone CLI.

The measured best result came from running upstream's own command. So that is
what this does, and the surface between Rhythmisoze and GAME is now one
subprocess call and one CSV parse.

## Why CSV

`--output-formats mid` is upstream's default and would round every pitch to an
integer on the way out. CSV keeps GAME's continuous estimate, which the Raw
contract requires. `--pitch-format number` keeps it as a decimal MIDI value
rather than a note name with cents, which is the same number with three
decimals instead of two and no spelling to parse back.

Neither flag changes what GAME extracts. They select a writer.
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
    """A decimal MIDI value, or a note name with cents.

    The service asks for the first. The second is still understood because
    upstream's default is note names, and a CSV produced by a hand-run
    `infer.py` should be readable by the same parser that reads ours.
    """
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
    """GAME's `onset,offset,pitch` rows, in absolute source seconds.

    The times are already absolute: upstream's combining callback added each
    chunk's offset before writing. Nothing here shifts, scales, quantises or
    reorders them beyond sorting by onset.
    """
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

    started = time.monotonic()
    run_dir = config.work_dir / uuid.uuid4().hex
    out_dir = run_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Upstream's CLI takes a file or a directory. A file is what a standalone
    # run passes, and it removes the need for a `--glob` to pick one entry out
    # of a directory this service just created.
    source = run_dir / "take.wav"
    source.write_bytes(wav_bytes)

    try:
        return _run(source=source, out_dir=out_dir, config=config, started=started)
    finally:
        # The take is the user's audio and has no reason to outlive the request.
        shutil.rmtree(run_dir, ignore_errors=True)


def _run(*, source: Path, out_dir: Path, config: Config, started: float) -> Transcription:
    """`infer.py extract`, with upstream's defaults for everything that decides notes.

    Nothing is passed for batch size, workers, precision, language, the
    segmentation thresholds, the decoding radius or the D3PM schedule. Those are
    what the standalone runs used, and the way to keep using them is to not
    mention them.
    """
    try:
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "transcription_service.game_runner",
                "extract",
                str(source),
                "-m",
                str(config.model_file),
                "--output-formats",
                "csv",
                "--pitch-format",
                "number",
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
