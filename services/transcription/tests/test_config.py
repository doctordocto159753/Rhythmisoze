"""Readiness, and the one thing it refuses to take on trust.

`GAME_MODEL_TIER` selects nothing. It is a label that travels into Raw
provenance, and `TRANSCRIPTION_MODEL_DIR` is what actually decides which
weights run. Those two can disagree, and the disagreement is silent: a small
checkpoint mounted at the large path transcribes perfectly well and stamps
every note it produces with the wrong model identity.

Raw provenance exists so that a model change can never look like the same
evidence. A label nobody checks does not do that, so the service reads the
`config.yaml` upstream ships beside the weights and refuses to report ready
when it contradicts what the deployment claims.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from transcription_service import config as config_module

# The shape of upstream's own config.yaml, trimmed to the two keys that
# identify a checkpoint. Real values: small is dim 128 with 4 encoder layers,
# large is dim 256 with 8 — the v1.0.0 release table's 4+8+4 against 8+16+8.
CONFIG_YAML = """\
model:
  mode: d3pm
  embedding_dim: {dim}
  encoder:
    cls: modules.backbones.EBF.EBFBackbone
    kwargs:
      dim: {dim}
      num_layers: {layers}
inference:
  features:
    audio_sample_rate: 44100
"""


def _deployment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    tier: str,
    checkpoint: tuple[int, int] | None,
) -> config_module.Config:
    model_dir = tmp_path / "weights"
    model_dir.mkdir(parents=True, exist_ok=True)
    (model_dir / "model.pt").write_bytes(b"not a real checkpoint")
    if checkpoint is not None:
        dim, layers = checkpoint
        (model_dir / "config.yaml").write_text(
            CONFIG_YAML.format(dim=dim, layers=layers), encoding="utf-8"
        )
    monkeypatch.setenv("TRANSCRIPTION_MODEL_DIR", str(model_dir))
    monkeypatch.setenv("GAME_MODEL_TIER", tier)
    return config_module.load()


class TestDefaults:
    def test_production_identity_is_upstream_cli_on_the_large_checkpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        for name in ("GAME_BACKEND", "GAME_MODEL_TIER", "GAME_MODEL_VERSION",
                     "TRANSCRIPTION_MODEL_DIR"):
            monkeypatch.delenv(name, raising=False)
        config = config_module.load()

        assert config.backend == "upstream-cli"
        assert config.model_tier == "large"
        assert config.model_version == "1.0.0"
        assert config.model_dir == Path("/models/game-large")


class TestReadiness:
    def test_ready_when_the_checkpoint_is_the_tier_it_claims(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config = _deployment(tmp_path, monkeypatch, tier="large", checkpoint=(256, 8))
        assert config.readiness_detail() is None

    def test_small_weights_are_a_valid_deployment_when_labelled_as_such(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config = _deployment(tmp_path, monkeypatch, tier="small", checkpoint=(128, 4))
        assert config.readiness_detail() is None

    def test_refuses_when_the_label_contradicts_the_checkpoint(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The mistake this exists for: the small weights left mounted while the
        # tier was moved to large. It transcribes fine and lies about what did.
        config = _deployment(tmp_path, monkeypatch, tier="large", checkpoint=(128, 4))
        detail = config.readiness_detail()

        assert detail is not None
        assert "small" in detail

    def test_tells_medium_and_large_apart(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Both are embedding dim 256. Depth is the only thing separating them,
        # which is why the signature is a pair rather than a dim.
        config = _deployment(tmp_path, monkeypatch, tier="large", checkpoint=(256, 4))
        detail = config.readiness_detail()

        assert detail is not None
        assert "medium" in detail

    def test_an_unverifiable_claim_is_left_alone(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # No config.yaml beside the weights. Unverifiable is not the same as
        # contradicted, and turning it into an outage would strand a deployment
        # whose weights are fine.
        config = _deployment(tmp_path, monkeypatch, tier="large", checkpoint=None)
        assert config.readiness_detail() is None

    def test_missing_weights_say_where_they_were_expected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("TRANSCRIPTION_MODEL_DIR", str(tmp_path / "absent"))
        detail = config_module.load().readiness_detail()

        assert detail is not None
        assert str(tmp_path / "absent") in detail

    def test_rejects_a_backend_that_no_longer_exists(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # `onnx` was a reimplementation of GAME's extraction over the exported
        # graphs. It is gone, and selecting it must fail loudly rather than
        # quietly running something else under the same Raw label.
        config = _deployment(tmp_path, monkeypatch, tier="large", checkpoint=(256, 8))
        monkeypatch.setenv("GAME_BACKEND", "onnx")
        detail = config_module.load().readiness_detail()

        assert detail is not None
        assert "onnx" in detail

    def test_rejects_an_unknown_tier(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        config = _deployment(tmp_path, monkeypatch, tier="enormous", checkpoint=(256, 8))
        detail = config.readiness_detail()

        assert detail is not None
        assert "enormous" in detail
