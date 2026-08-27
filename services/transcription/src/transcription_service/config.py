"""Configuration for the authoritative GAME transcription service."""

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
    model_dir: Path
    game_dir: Path
    max_duration_sec: float
    max_upload_bytes: int
    work_dir: Path
    backend: str = "pytorch"
    model_tier: str = "small"
    model_version: str = "1.0.0"

    @property
    def model_file(self) -> Path:
        return self.model_dir / "model.pt"

    @property
    def onnx_required_files(self) -> tuple[str, ...]:
        return (
            "config.json",
            "encoder.onnx",
            "segmenter.onnx",
            "estimator.onnx",
            "dur2bd.onnx",
            "bd2dur.onnx",
        )

    def readiness_detail(self) -> str | None:
        if self.backend == "pytorch":
            if self.model_tier != "small":
                return f"PyTorch backend supports only the small tier, got {self.model_tier}"
            if not self.model_file.is_file():
                return f"no model.pt under {self.model_dir}"
            return None

        if self.backend == "onnx":
            if self.model_tier != "large":
                return f"ONNX backend expects the large tier, got {self.model_tier}"
            missing = [name for name in self.onnx_required_files if not (self.model_dir / name).is_file()]
            if missing:
                return f"missing GAME ONNX files under {self.model_dir}: {', '.join(missing)}"
            return None

        return f"unsupported GAME backend: {self.backend}"


def load() -> Config:
    backend = os.environ.get("GAME_BACKEND", "pytorch").strip().lower()
    model_tier = os.environ.get("GAME_MODEL_TIER", "small").strip().lower()
    if backend not in {"pytorch", "onnx"}:
        backend = "invalid"
    return Config(
        model_dir=Path(os.environ.get("TRANSCRIPTION_MODEL_DIR", "/models/game")),
        game_dir=Path(os.environ.get("TRANSCRIPTION_GAME_DIR", "/opt/game")),
        max_duration_sec=float(os.environ.get("TRANSCRIPTION_MAX_DURATION_SEC", "60")),
        max_upload_bytes=_int("TRANSCRIPTION_MAX_UPLOAD_BYTES", 32 * 1024 * 1024),
        work_dir=Path(os.environ.get("TRANSCRIPTION_WORK_DIR", "/tmp/transcription")),
        backend=backend,
        model_tier=model_tier,
        model_version=os.environ.get(
            "GAME_MODEL_VERSION", "1.0.0" if model_tier == "small" else "1.0.3"
        ).strip(),
    )
