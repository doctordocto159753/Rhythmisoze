"""Production boundary tests: authoritative Raw, explicit failure, rhythm isolation."""

from __future__ import annotations

import io
import wave
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from transcription_service import main
from transcription_service.config import Config
from transcription_service.game_adapter import Note, Transcription


def wav_bytes() -> bytes:
    samples = (np.sin(np.linspace(0, 40 * np.pi, 16000)) * 12000).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(16000)
        sink.writeframes(samples.tobytes())
    return output.getvalue()


def unavailable_config(tmp_path: Path) -> Config:
    return Config(
        model_dir=tmp_path / "missing",
        game_dir=tmp_path / "game",
        max_duration_sec=60,
        max_upload_bytes=32 * 1024 * 1024,
        work_dir=tmp_path / "work",
    )


def test_melody_is_explicitly_unavailable_without_game(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "CONFIG", unavailable_config(tmp_path))
    response = TestClient(main.app).post(
        "/transcribe",
        files={"audio": ("take.wav", wav_bytes(), "audio/wav")},
        data={"mode": "voice"},
    )
    assert response.status_code == 503
    assert "model.pt" in response.json()["detail"]


def test_rhythm_route_never_invokes_game(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main, "CONFIG", unavailable_config(tmp_path))

    def forbidden(*_args, **_kwargs):
        raise AssertionError("GAME must not receive deliberate rhythm")

    monkeypatch.setattr(main, "game_transcribe", forbidden)
    response = TestClient(main.app).post(
        "/transcribe",
        files={"audio": ("take.wav", wav_bytes(), "audio/wav")},
        data={"mode": "rhythm"},
    )
    assert response.status_code == 200
    raw = response.json()["rawTranscription"]
    assert raw["sourceKind"] == "audio"
    assert raw["provenance"]["backend"] == "server-dsp"


def test_game_output_becomes_authoritative_raw(tmp_path, monkeypatch) -> None:
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "model.pt").write_bytes(b"fixture")
    config = unavailable_config(tmp_path)
    monkeypatch.setattr(main, "CONFIG", Config(**{**config.__dict__, "model_dir": model_dir}))
    monkeypatch.setattr(
        main,
        "game_transcribe",
        lambda *_args: Transcription([Note(0.125, 0.875, 60.37)], 42),
    )
    response = TestClient(main.app).post(
        "/transcribe",
        files={"audio": ("take.wav", wav_bytes(), "audio/wav")},
        data={"mode": "voice"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["elapsedMs"] == 42
    assert payload["rawTranscription"]["notes"] == [{
        "startSec": 0.125,
        "endSec": 0.875,
        "pitchMidi": 60,
        "continuousPitch": 60.37,
        "velocity": 96,
    }]
    assert payload["rawTranscription"]["provenance"]["transcriber"] == "game"
