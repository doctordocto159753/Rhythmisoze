"""Configuration for the register-witness service.

Everything here is read once at import and never mutated. The service has no
state beyond a lazily-loaded model, so configuration is the only thing that can
make two deployments behave differently, and it is worth being able to read it
in one place.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    """Where the model is, and what the service will accept."""

    #: Directory holding the unpacked GAME release — ``model.pt`` and
    #: ``config.yaml`` beside each other, exactly as the upstream zip lays them
    #: out. Never baked into the image: the weights are CC BY-NC-SA 4.0 and this
    #: project is MIT, so they are the operator's to fetch and to accept.
    model_dir: Path

    #: Where the GAME source tree was cloned. The adapter runs upstream's own
    #: inference code rather than reimplementing the paper.
    game_dir: Path

    #: Longest clip accepted, in seconds. Matches the app's recording cap; a
    #: longer request is a bug or an abuse rather than a use case.
    max_duration_sec: float

    #: Largest upload accepted, in bytes. A 60 s 16-bit mono WAV at 44.1 kHz is
    #: about 5.3 MB; the ceiling leaves room for a higher sample rate.
    max_upload_bytes: int

    #: Where the adapter writes the temporary WAV it hands to upstream's CLI.
    work_dir: Path

    @property
    def model_file(self) -> Path:
        return self.model_dir / "model.pt"

    def model_present(self) -> bool:
        return self.model_file.is_file()


def load() -> Config:
    return Config(
        model_dir=Path(os.environ.get("TRANSCRIPTION_MODEL_DIR", "/models/game")),
        game_dir=Path(os.environ.get("TRANSCRIPTION_GAME_DIR", "/opt/game")),
        max_duration_sec=float(os.environ.get("TRANSCRIPTION_MAX_DURATION_SEC", "60")),
        max_upload_bytes=_int("TRANSCRIPTION_MAX_UPLOAD_BYTES", 32 * 1024 * 1024),
        work_dir=Path(os.environ.get("TRANSCRIPTION_WORK_DIR", "/tmp/transcription")),
    )
