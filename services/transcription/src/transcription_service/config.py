"""Configuration for the authoritative GAME transcription service.

One backend, named after what it actually is: upstream GAME's own `infer.py`
CLI. There is deliberately no second inference route. A previous iteration
reimplemented GAME's extraction over the exported ONNX graphs — slicing,
D3PM sequencing, boundary reconstruction and stitching, all rewritten here —
and the result was measurably less musical than simply running upstream's
command. The reimplementation is gone; what is left provides an input, invokes
GAME, and reads its output.

`model_tier` selects nothing in code. It is a label that travels into Raw
provenance, and the checkpoint at `model_dir` is what actually runs. Because a
label that can silently disagree with the thing it labels is worse than no
label, `readiness_detail` checks it against the checkpoint's own `config.yaml`
before the service reports ready.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

#: The only backend. Upstream's CLI, driven through `game_runner`.
BACKEND = "upstream-cli"

#: The published pretrained sizes, and how each identifies itself in the
#: `config.yaml` shipped beside its weights: (embedding dim, encoder layers).
#:
#: From the GAME v1.0.0 release table — small ~12M params at dim 128, medium
#: ~50M and large ~100M both at dim 256, separated by depth (4+8+4 against
#: 8+16+8). Embedding dim alone does not distinguish medium from large, which
#: is exactly the confusion this table exists to prevent.
TIER_SIGNATURES: dict[str, tuple[int, int]] = {
    "small": (128, 4),
    "medium": (256, 4),
    "large": (256, 8),
}


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
    backend: str = BACKEND
    model_tier: str = "large"
    model_version: str = "1.0.0"

    @property
    def model_file(self) -> Path:
        return self.model_dir / "model.pt"

    @property
    def model_config_file(self) -> Path:
        """Upstream ships this beside the weights; `infer.py` reads it to build the net."""
        return self.model_dir / "config.yaml"

    def declared_tier_mismatch(self) -> str | None:
        """Whether the checkpoint on disk is the size this deployment claims it is.

        Reads the model's own `config.yaml` rather than trusting the environment.
        Returns None when it agrees, when the file is unreadable, or when no YAML
        parser is available — an unverifiable claim is left alone rather than
        turned into an outage, but a *contradicted* one is not.
        """
        expected = TIER_SIGNATURES.get(self.model_tier)
        if expected is None or not self.model_config_file.is_file():
            return None
        try:
            import yaml  # noqa: PLC0415 — optional, and only on the readiness path
        except ImportError:
            return None
        try:
            parsed = yaml.safe_load(self.model_config_file.read_text(encoding="utf-8"))
            model = parsed["model"]
            actual = (
                int(model["embedding_dim"]),
                int(model["encoder"]["kwargs"]["num_layers"]),
            )
        except Exception:
            return None
        if actual == expected:
            return None
        named = [tier for tier, signature in TIER_SIGNATURES.items() if signature == actual]
        looks_like = named[0] if named else f"embedding dim {actual[0]}, {actual[1]} encoder layers"
        return (
            f"GAME_MODEL_TIER says {self.model_tier}, but the checkpoint under "
            f"{self.model_dir} is {looks_like}. Raw provenance records the tier, so "
            f"this would attribute one model's transcription to another."
        )

    def readiness_detail(self) -> str | None:
        if self.backend != BACKEND:
            return f"unsupported GAME backend: {self.backend}"
        if self.model_tier not in TIER_SIGNATURES:
            return (
                f"unknown GAME model tier: {self.model_tier} "
                f"(expected one of {', '.join(TIER_SIGNATURES)})"
            )
        if not self.model_file.is_file():
            return f"no model.pt under {self.model_dir}"
        return self.declared_tier_mismatch()


def load() -> Config:
    backend = os.environ.get("GAME_BACKEND", BACKEND).strip().lower()
    model_tier = os.environ.get("GAME_MODEL_TIER", "large").strip().lower()
    return Config(
        # Tier-suffixed by default so two checkpoints can sit side by side
        # without either being mistaken for the other. A deployment that
        # already mounts the small weights at /models/game keeps working by
        # setting this explicitly, which is a visible decision rather than a
        # silent one.
        model_dir=Path(os.environ.get("TRANSCRIPTION_MODEL_DIR", "/models/game-large")),
        game_dir=Path(os.environ.get("TRANSCRIPTION_GAME_DIR", "/opt/game")),
        max_duration_sec=float(os.environ.get("TRANSCRIPTION_MAX_DURATION_SEC", "60")),
        max_upload_bytes=_int("TRANSCRIPTION_MAX_UPLOAD_BYTES", 32 * 1024 * 1024),
        work_dir=Path(os.environ.get("TRANSCRIPTION_WORK_DIR", "/tmp/transcription")),
        backend=backend,
        model_tier=model_tier,
        model_version=os.environ.get("GAME_MODEL_VERSION", "1.0.0").strip(),
    )
