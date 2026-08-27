"""How the adapter starts inference, and what it leaves behind.

Two properties, both of which were fixed once and would be silent if they broke.

**It must go through the launcher.** Reverting to `infer.py` restores the SIGFPE
on the deployment host, and the symptom is a 502 with an empty stderr — nothing
in the code would look wrong.

**It must delete the recording.** The take is written to disk so upstream's CLI
can read a file, and it is the user's audio. A leftover would accumulate
silently in a container nobody inspects.

The model never runs here: `subprocess.run` is replaced, which is exactly the
boundary the adapter's contract is written at.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from transcription_service import config as config_module
from transcription_service.game_adapter import AdapterError, transcribe

CSV = "onset,offset,pitch\n0.220,0.910,A3+3\n0.910,1.610,C4-1\n"


@pytest.fixture
def config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    model_dir = tmp_path / "models" / "game"
    model_dir.mkdir(parents=True)
    (model_dir / "model.pt").write_bytes(b"not a real checkpoint")
    game_dir = tmp_path / "game"
    game_dir.mkdir()

    monkeypatch.setenv("TRANSCRIPTION_MODEL_DIR", str(model_dir))
    monkeypatch.setenv("TRANSCRIPTION_GAME_DIR", str(game_dir))
    monkeypatch.setenv("TRANSCRIPTION_WORK_DIR", str(tmp_path / "work"))
    return config_module.load()


def _spy(monkeypatch: pytest.MonkeyPatch, *, returncode: int = 0, stderr: bytes = b"", write_csv: bool = True):
    """Replaces `subprocess.run`, recording the call and faking upstream output."""
    seen: dict[str, object] = {}

    def fake_run(argv, **kwargs):
        seen["argv"] = list(argv)
        seen["cwd"] = kwargs.get("cwd")
        # The audio must still be on disk while inference is notionally running.
        source_dir = Path(argv[argv.index("extract") + 1])
        seen["audio_present_during_run"] = (source_dir / "take.wav").is_file()
        if write_csv:
            out_dir = Path(argv[argv.index("--output-dir") + 1])
            (out_dir / "take.csv").write_text(CSV, encoding="utf-8")
        return subprocess.CompletedProcess(argv, returncode, b"", stderr)

    monkeypatch.setattr(subprocess, "run", fake_run)
    return seen


def test_starts_the_launcher_rather_than_upstream_directly(config, monkeypatch) -> None:
    seen = _spy(monkeypatch)
    transcribe(b"RIFFfake", config)

    argv = seen["argv"]
    assert argv[1] == "-m"
    assert argv[2] == "transcription_service.game_runner"
    # The regression this guards: `infer.py` as python's own argument is the
    # pre-fix invocation and reintroduces the crash.
    assert "infer.py" not in argv[:3]


def test_runs_from_the_pinned_checkout(config, monkeypatch) -> None:
    seen = _spy(monkeypatch)
    transcribe(b"RIFFfake", config)

    # The launcher resolves `infer.py` relatively, so the working directory is
    # what decides which GAME is executed.
    assert seen["cwd"] == str(config.game_dir)


def test_passes_upstreams_arguments_through_unchanged(config, monkeypatch) -> None:
    seen = _spy(monkeypatch)
    transcribe(b"RIFFfake", config)

    argv = seen["argv"]
    tail = argv[3:]
    assert tail[0] == "extract"
    assert "--output-formats" in tail and tail[tail.index("--output-formats") + 1] == "csv"
    # Upstream's own `-m`, which is the model path and must survive alongside
    # python's `-m` without either being confused for the other.
    assert tail[tail.index("-m") + 1] == str(config.model_file)


def test_parses_what_upstream_wrote(config, monkeypatch) -> None:
    _spy(monkeypatch)
    result = transcribe(b"RIFFfake", config)

    assert [round(note.pitch, 2) for note in result.notes] == [57.03, 59.99]
    assert result.notes[0].start_sec == 0.220


def test_deletes_the_recording_afterwards(config, monkeypatch) -> None:
    seen = _spy(monkeypatch)
    transcribe(b"RIFFfake", config)

    assert seen["audio_present_during_run"] is True
    leftovers = list(config.work_dir.rglob("*.wav")) if config.work_dir.exists() else []
    assert leftovers == []


def test_deletes_the_recording_even_when_inference_crashes(config, monkeypatch) -> None:
    # The path where a leftover would sit unnoticed. A SIGFPE arrives here as a
    # negative return code with nothing on stderr, which is precisely the shape
    # the deployment host was producing.
    _spy(monkeypatch, returncode=-8, write_csv=False)

    with pytest.raises(AdapterError):
        transcribe(b"RIFFfake", config)

    leftovers = list(config.work_dir.rglob("*.wav")) if config.work_dir.exists() else []
    assert leftovers == []


def test_reports_a_crash_rather_than_inventing_notes(config, monkeypatch) -> None:
    _spy(monkeypatch, returncode=-8, write_csv=False)

    with pytest.raises(AdapterError):
        transcribe(b"RIFFfake", config)
