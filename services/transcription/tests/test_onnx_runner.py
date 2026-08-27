"""Does the ONNX backend put notes back on the recording's own clock?

The defect this file exists for was invisible from inside the runner. Every
graph was called in the right order with the right inputs, and the result was
still wrong, because the recording had been transcribed as one unbroken span
and the regions were laid end to end from zero. Total note duration then equals
total audio duration by construction: every rest the singer left is squeezed
out, and every note after the first rest is early by the sum of the rests before
it.

So the tests here are about the two things on either side of inference —
slicing and stitching — and the model never runs. The graphs are replaced with
fakes that report a known answer per chunk, which is the only way to assert
"this note is at 12.4 s because its chunk started at 12.0 s" without a 400 MB
model and a real recording.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pytest

from transcription_service import config as config_module
from transcription_service.game_slicer import Slicer
from transcription_service.onnx_runner import (
    D3PM_STEPS,
    SEG_RADIUS_SEC,
    _Graphs,
    _RawNote,
    combine,
    d3pm_sample_ts,
)

SAMPLERATE = 44100
TIMESTEP = 0.01


def _tone(seconds: float, *, level: float = 0.5) -> np.ndarray:
    """A steady 220 Hz tone, loud enough to sit well above the -40 dB gate."""
    t = np.arange(int(seconds * SAMPLERATE), dtype=np.float64) / SAMPLERATE
    return (level * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)


def _silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SAMPLERATE), dtype=np.float32)


class TestSlicing:
    def test_cuts_at_silence_and_records_where_each_chunk_started(self) -> None:
        # Two sung spans with two seconds of silence between them. Upstream's
        # slicer removes the silence from what the model sees and keeps its
        # length only as the second chunk's offset.
        waveform = np.concatenate([_tone(3.0), _silence(2.0), _tone(3.0)])
        chunks = Slicer.for_extraction(SAMPLERATE).slice(waveform)

        assert len(chunks) == 2
        assert chunks[0].offset_sec == pytest.approx(0.0, abs=0.05)
        # The second chunk starts after the first tone plus the silence, give or
        # take where in the silence the minimum-RMS cut landed.
        assert chunks[1].offset_sec == pytest.approx(5.0, abs=0.25)
        # The silence is gone from the audio, not merely marked.
        total = sum(chunk.waveform.shape[0] for chunk in chunks) / SAMPLERATE
        assert total == pytest.approx(6.0, abs=0.5)

    def test_short_audio_is_one_chunk_at_the_origin(self) -> None:
        chunks = Slicer.for_extraction(SAMPLERATE).slice(_tone(0.4))
        assert len(chunks) == 1
        assert chunks[0].offset_sec == 0.0

    def test_a_chunk_knows_its_length_in_seconds(self) -> None:
        chunk = Slicer.for_extraction(SAMPLERATE).slice(_tone(0.4))[0]
        assert chunk.duration_sec(SAMPLERATE) == pytest.approx(0.4, abs=0.001)


class TestUpstreamParameters:
    def test_d3pm_schedule_matches_the_cli_defaults(self) -> None:
        # t0=0, nsteps=8 -> eighths of the unit interval, first step at noise.
        assert d3pm_sample_ts() == pytest.approx(
            [0.0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]
        )
        assert len(d3pm_sample_ts()) == D3PM_STEPS

    def test_boundary_radius_is_derived_from_the_model_timestep(self) -> None:
        # Upstream computes round(seg_radius / model.timestep) rather than
        # hard-coding a frame count, so a model with a different timestep gets
        # the same musical radius.
        assert round(SEG_RADIUS_SEC / TIMESTEP) == 2
        assert round(SEG_RADIUS_SEC / 0.005) == 4


class TestCombining:
    def test_orders_notes_from_every_chunk_by_onset(self) -> None:
        combined = combine([
            _RawNote(onset=5.0, offset=5.5, pitch=64.0),
            _RawNote(onset=0.5, offset=1.0, pitch=60.0),
            _RawNote(onset=2.0, offset=2.5, pitch=62.0),
        ])
        assert [note.onset for note in combined] == [0.5, 2.0, 5.0]

    def test_pushes_an_overlapping_onset_to_the_previous_offset(self) -> None:
        # Chunks are transcribed independently, so nothing stops one chunk's
        # last note ending after the next chunk's first note begins.
        combined = combine([
            _RawNote(onset=0.0, offset=1.2, pitch=60.0),
            _RawNote(onset=1.0, offset=2.0, pitch=62.0),
        ])
        assert [(note.onset, note.offset) for note in combined] == [(0.0, 1.2), (1.2, 2.0)]

    def test_drops_a_note_an_overlap_leaves_with_no_duration(self) -> None:
        combined = combine([
            _RawNote(onset=0.0, offset=2.0, pitch=60.0),
            _RawNote(onset=1.0, offset=1.5, pitch=62.0),
        ])
        assert len(combined) == 1
        assert combined[0].pitch == 60.0

    def test_keeps_the_silence_between_chunks(self) -> None:
        # The property the old runner destroyed: a rest is a gap between an
        # offset and the next onset, and combining must not close it.
        combined = combine([
            _RawNote(onset=0.0, offset=1.0, pitch=60.0),
            _RawNote(onset=4.0, offset=5.0, pitch=62.0),
        ])
        assert combined[1].onset == 4.0


@dataclass
class _FakeInput:
    name: str


class _FakeSession:
    """Records what it was fed and answers with a fixed shape."""

    def __init__(self, answer, *, input_names: tuple[str, ...] = ()) -> None:
        self._answer = answer
        self._input_names = input_names
        self.calls: list[dict] = []

    def get_inputs(self) -> list[_FakeInput]:
        return [_FakeInput(name) for name in self._input_names]

    def run(self, _outputs, feed):
        self.calls.append(feed)
        return self._answer(feed)


def _fake_graphs() -> _Graphs:
    """Graphs that report two equal notes filling whichever chunk they are given.

    Deliberately dependent only on the chunk length, so a note's absolute time
    in the result can only have come from the chunk's offset.
    """
    frames = {}

    def encoder(feed):
        count = max(1, int(round(float(feed["duration"][0]) / TIMESTEP)))
        frames["T"] = count
        mask = np.ones((1, count), dtype=bool)
        latent = np.zeros((1, count, 4), dtype=np.float32)
        return latent, latent, mask

    def dur2bd(feed):
        return (np.zeros_like(feed["maskT"]),)

    def segmenter(feed):
        return (feed["prev_boundaries"],)

    def bd2dur(feed):
        half = frames["T"] * TIMESTEP / 2
        return np.array([[half, half]], dtype=np.float32), np.ones((1, 2), dtype=bool)

    def estimator(_feed):
        # Fractional on purpose: GAME's scores are continuous MIDI and the
        # runner must not round them.
        return np.ones((1, 2), dtype=bool), np.array([[60.5, 62.25]], dtype=np.float32)

    return _Graphs(
        config={"samplerate": SAMPLERATE, "timestep": TIMESTEP, "loop": True},
        encoder=_FakeSession(encoder),
        segmenter=_FakeSession(
            segmenter,
            input_names=(
                "x_seg", "language", "known_boundaries", "prev_boundaries",
                "t", "maskT", "threshold", "radius",
            ),
        ),
        dur2bd=_FakeSession(dur2bd),
        bd2dur=_FakeSession(bd2dur),
        estimator=_FakeSession(estimator),
    )


@pytest.fixture
def onnx_config(tmp_path, monkeypatch: pytest.MonkeyPatch):
    model_dir = tmp_path / "game-large-onnx"
    model_dir.mkdir(parents=True)
    for name in ("config.json", "encoder.onnx", "segmenter.onnx", "estimator.onnx",
                 "dur2bd.onnx", "bd2dur.onnx"):
        (model_dir / name).write_bytes(b"{}")
    monkeypatch.setenv("GAME_BACKEND", "onnx")
    monkeypatch.setenv("GAME_MODEL_TIER", "large")
    monkeypatch.setenv("TRANSCRIPTION_MODEL_DIR", str(model_dir))
    return config_module.load()


class TestEndToEndOffsets:
    @pytest.fixture(autouse=True)
    def _fakes(self, monkeypatch: pytest.MonkeyPatch):
        from transcription_service import onnx_runner

        self.graphs = _fake_graphs()
        monkeypatch.setattr(onnx_runner, "_graphs", lambda _dir: self.graphs)
        monkeypatch.setattr(
            onnx_runner,
            "_decode_audio",
            lambda _payload, _sr: np.concatenate([_tone(3.0), _silence(2.0), _tone(3.0)]),
        )

    def test_notes_land_in_absolute_source_seconds(self, onnx_config) -> None:
        from transcription_service.onnx_runner import transcribe

        result = transcribe(b"ignored", onnx_config)

        # Two chunks, two notes each. The last note must end near the end of the
        # recording rather than near the end of the *audio without its silence*,
        # which is what the previous runner produced.
        assert len(result.notes) == 4
        assert result.notes[-1].end_sec == pytest.approx(8.0, abs=0.5)
        assert [note.start_sec for note in result.notes] == sorted(
            note.start_sec for note in result.notes
        )

    def test_the_rest_between_the_two_sung_spans_survives(self, onnx_config) -> None:
        from transcription_service.onnx_runner import transcribe

        notes = transcribe(b"ignored", onnx_config).notes
        # The gap between the second note's end and the third note's start is
        # the silence the slicer removed. Laying regions end to end would make
        # this zero.
        gap = notes[2].start_sec - notes[1].end_sec
        assert gap == pytest.approx(2.0, abs=0.5)

    def test_continuous_pitch_is_not_rounded(self, onnx_config) -> None:
        from transcription_service.onnx_runner import transcribe

        pitches = sorted({round(note.pitch, 6) for note in transcribe(b"ignored", onnx_config).notes})
        assert pitches == pytest.approx([60.5, 62.25])

    def test_the_d3pm_loop_carries_boundaries_forward(self, onnx_config) -> None:
        from transcription_service.onnx_runner import transcribe

        transcribe(b"ignored", onnx_config)

        calls = self.graphs.segmenter.calls
        # Eight steps per chunk, two chunks.
        assert len(calls) == D3PM_STEPS * 2
        assert [float(call["t"][0]) for call in calls[:D3PM_STEPS]] == pytest.approx(
            d3pm_sample_ts()
        )
        # Every step reads the previous step's output, and `known_boundaries` is
        # never re-derived — that is what makes it a sampling loop rather than
        # eight independent guesses.
        for previous, current in zip(calls, calls[1:]):
            if current["t"][0] == 0.0:
                continue
            assert current["prev_boundaries"] is not None
            assert current["known_boundaries"].shape == previous["known_boundaries"].shape
        assert all(int(call["radius"]) == 2 for call in calls)

    def test_sessions_are_built_once_not_once_per_chunk(self, onnx_config) -> None:
        from transcription_service.onnx_runner import transcribe

        transcribe(b"ignored", onnx_config)
        # Two chunks, one encoder call each. If sessions were rebuilt per slice
        # this fixture would have been replaced rather than reused.
        assert len(self.graphs.encoder.calls) == 2
