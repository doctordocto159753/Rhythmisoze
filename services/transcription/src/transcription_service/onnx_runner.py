"""GAME v1.0.3 large ONNX inference backend.

## What this reproduces, and why that is the whole design

The behavioural oracle is upstream GAME's own `infer.py extract`, run
standalone. Not this service's PyTorch small backend, and not "the ONNX graphs,
called in a sensible order" — the graphs are only the middle third of what
upstream does, and the parts on either side of them turn out to matter more
than the inference does.

Upstream extraction is:

```
librosa.load(mono, 44100)                     inference/data.py
  -> Slicer(-40 dB, 1000, 200, sil 100)       inference/slicer2.py
     -> per chunk: {waveform, offset, duration}
        -> encoder -> D3PM segmenter -> bd2dur -> estimator
        -> durations -> cumsum -> clamp(chunk length) -> + chunk offset
  -> combine every chunk, sort, resolve overlaps   inference/callbacks.py
```

The previous runner implemented the middle line and nothing else: it pushed the
entire recording through the encoder in one pass and laid the returned regions
end to end from zero. Two defects follow from that, and both are audible.

**The model was shown material it is never shown.** Upstream never gives the
encoder a recording with long silences in it. It gives it spans of singing, and
the silence between them never reaches the model at all — it is reconstructed
afterwards from each chunk's offset. Asking the segmenter to place boundaries
across thirty seconds including the gaps is asking it to do a job it was not
trained for.

**Silence was deleted rather than preserved.** Laying regions end to end from
zero makes total note duration equal total audio duration by construction.
Every rest the singer left is squeezed out, and every note after the first rest
is early by the length of every rest before it. On a 34 s take that is not a
subtle drift.

## What is deliberately *not* here

No pitch correction, no note merging, no minimum-duration filter, no musical
heuristics of any kind. The Raw boundary is authoritative precisely because
nothing between the model and the caller has an opinion. `scores` are GAME's
continuous MIDI pitches and are passed through untouched; `main` exposes a
rounded `pitchMidi` beside `continuousPitch` for consumers that want one, and
that rounding is the caller's business rather than this module's.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .config import Config
from .game_slicer import Slicer

#: `infer.py extract`'s defaults, which is what the standalone runs used.
#:
#: Written out rather than left implicit because they are the settings the
#: musical result depends on, and because a future upstream change to a CLI
#: default should be a visible disagreement with this file rather than a silent
#: divergence from it.
SEG_THRESHOLD = 0.2
#: Boundary decoding radius, in *seconds*. Upstream converts it to frames with
#: the model's own timestep — `round(seg_radius / model.timestep)` — so a model
#: shipped with a different timestep gets a different frame count from the same
#: musical radius. The previous runner hard-coded the frame count instead.
SEG_RADIUS_SEC = 0.02
EST_THRESHOLD = 0.2
D3PM_T0 = 0.0
D3PM_STEPS = 8


def d3pm_sample_ts(t0: float = D3PM_T0, steps: int = D3PM_STEPS) -> list[float]:
    """Upstream's `ValidationConfig.d3pm_sample_ts_resolved`."""
    step = (1 - t0) / steps
    return [t0 + i * step for i in range(steps)]


@dataclass(frozen=True)
class _Graphs:
    config: dict
    encoder: ort.InferenceSession
    segmenter: ort.InferenceSession
    dur2bd: ort.InferenceSession
    bd2dur: ort.InferenceSession
    estimator: ort.InferenceSession

    @property
    def samplerate(self) -> int:
        return int(self.config.get("samplerate", 44100))

    @property
    def timestep(self) -> float:
        return float(self.config.get("timestep", 0.01))

    @property
    def loops(self) -> bool:
        return bool(self.config.get("loop", True))


@lru_cache(maxsize=2)
def _graphs(model_dir_raw: str) -> _Graphs:
    """Sessions for one model directory, built once per process.

    Cached because a take is sliced into many chunks and each chunk runs the
    same five graphs. Loading them per chunk would dominate the request.
    """
    model_dir = Path(model_dir_raw)
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, int(os.environ.get("GAME_ONNX_THREADS", "4")))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

    def load(name: str) -> ort.InferenceSession:
        return ort.InferenceSession(
            str(model_dir / f"{name}.onnx"),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    return _Graphs(
        config=json.loads((model_dir / "config.json").read_text(encoding="utf-8")),
        encoder=load("encoder"),
        segmenter=load("segmenter"),
        dur2bd=load("dur2bd"),
        bd2dur=load("bd2dur"),
        estimator=load("estimator"),
    )


def _decode_audio(payload: bytes, samplerate: int) -> np.ndarray:
    """Mono float32 at the model's rate — upstream's `librosa.load` contract.

    ffmpeg rather than librosa because it is already in the image for the
    PyTorch path and because the ONNX backend exists to avoid dragging the
    scientific-Python stack in behind it. The contract is what matters: one
    channel, the model's sample rate, float32 in [-1, 1].
    """
    completed = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0",
            "-f", "f32le", "-acodec", "pcm_f32le",
            "-ac", "1", "-ar", str(samplerate),
            "pipe:1",
        ],
        input=payload,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0 or not completed.stdout:
        detail = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        message = detail[-1] if detail else "ffmpeg could not decode audio"
        raise RuntimeError(message)
    return np.frombuffer(completed.stdout, dtype="<f4").copy()


@dataclass
class _RawNote:
    """A note on the source clock, before overlaps between chunks are resolved.

    Mutable, and used as such below, because upstream's combining pass rewrites
    onsets and offsets in place.
    """

    onset: float
    offset: float
    pitch: float


def _infer_chunk(graphs: _Graphs, waveform: np.ndarray, duration_sec: float) -> list[_RawNote]:
    """One chunk, chunk-relative. Mirrors `SegmentationEstimationInferenceModel.forward`.

    Run one chunk at a time rather than in batches of four. Upstream batches and
    pads the short waveforms to the longest in the batch, masking the padding
    afterwards; a batch of one has no padding to mask and so cannot leak any
    into the frames near a chunk's end. On a CPU-only host batching buys little
    anyway, so this is the faithful option and the cheap one at once.
    """
    batched = waveform[None, :].astype(np.float32, copy=False)

    x_seg, x_est, mask_t = graphs.encoder.run(
        None,
        {"waveform": batched, "duration": np.array([duration_sec], dtype=np.float32)},
    )

    # Extraction has no known internal boundaries: upstream's dataset sets
    # `known_durations = [[chunk duration]]`, one region spanning the chunk, and
    # `format_boundaries` drops the final cumulative boundary — so this is an
    # all-false tensor of the right shape. It still goes through `dur2bd`
    # because the graph is what defines "the right shape".
    known_boundaries, = graphs.dur2bd.run(
        None,
        {
            "durations": np.array([[duration_sec]], dtype=np.float32),
            "maskT": mask_t,
        },
    )
    # `forward_segmenter` masks the converter's output before use. `dur2bd`
    # itself does not, because it is only given `maskT` for its length.
    known_boundaries = np.logical_and(known_boundaries, mask_t)

    radius = round(SEG_RADIUS_SEC / graphs.timestep)
    threshold = np.array(SEG_THRESHOLD, dtype=np.float32)
    available = {entry.name for entry in graphs.segmenter.get_inputs()}

    # D3PM: each step reads the previous step's boundaries. Upstream seeds the
    # loop with `known_boundaries` and never resets it, which is why the feed
    # below carries `boundaries` forward rather than rebuilding it.
    boundaries = known_boundaries
    for value in d3pm_sample_ts() if graphs.loops else [None]:
        feed = {
            "x_seg": x_seg,
            "known_boundaries": known_boundaries,
            "prev_boundaries": boundaries,
            "maskT": mask_t,
            "threshold": threshold,
            "radius": np.array(radius, dtype=np.int64),
            # 0 is "unset or universal", and is what upstream uses when
            # `--language` is not given. The standalone runs did not give it.
            "language": np.array([0], dtype=np.int64),
        }
        if value is not None:
            feed["t"] = np.array([value], dtype=np.float32)
        # The exporter only writes the inputs a given model actually has: no
        # `language` without language support, no `t`/`prev_boundaries` outside
        # d3pm mode. Feeding one it does not declare is an error, so ask.
        boundaries, = graphs.segmenter.run(None, {k: v for k, v in feed.items() if k in available})

    durations, mask_n = graphs.bd2dur.run(None, {"boundaries": boundaries, "maskT": mask_t})
    presence, scores = graphs.estimator.run(
        None,
        {
            "x_est": x_est,
            "boundaries": boundaries,
            "maskT": mask_t,
            "maskN": mask_n,
            "threshold": np.array(EST_THRESHOLD, dtype=np.float32),
        },
    )

    # `SaveCombinedFileCallback._process_item`, verbatim in intent: an exclusive
    # prefix sum for onsets, an inclusive one for offsets, both clamped to the
    # chunk's own length so a rounding excess cannot run past the audio.
    #
    # `presence` already has the note mask applied — upstream's
    # `forward_and_decode_scores` returns `presence & n_mask` — so it is the
    # only validity test needed, exactly as upstream treats it.
    row = np.asarray(durations[0], dtype=np.float64)
    cumulative = np.cumsum(row)
    onsets = np.minimum(np.concatenate(([0.0], cumulative[:-1])), duration_sec)
    offsets = np.minimum(cumulative, duration_sec)

    notes: list[_RawNote] = []
    for onset, offset, pitch, voiced in zip(onsets, offsets, scores[0], presence[0]):
        if offset - onset <= 0:
            continue
        if not bool(voiced):
            continue
        notes.append(_RawNote(onset=float(onset), offset=float(offset), pitch=float(pitch)))
    return notes


def combine(notes: list[_RawNote]) -> list[_RawNote]:
    """Upstream's `SaveCombinedFileCallback.save_file`, without the file.

    Chunks are transcribed independently, so nothing has stopped one chunk's
    last note from ending after the next chunk's first note begins. Upstream
    resolves that by sorting and walking forward, pushing each onset to at least
    the previous offset and dropping anything left with no duration.

    Separated from inference so the stitching can be tested without a model.
    """
    ordered = sorted(notes, key=lambda note: (note.onset, note.offset, note.pitch))
    last_time = 0.0
    index = 0
    while index < len(ordered):
        note = ordered[index]
        note.onset = max(note.onset, last_time)
        note.offset = max(note.offset, note.onset)
        if note.offset <= note.onset:
            ordered.pop(index)
        else:
            last_time = note.offset
            index += 1
    return ordered


def transcribe(payload: bytes, config: Config):
    # Imported lazily to avoid a module cycle while keeping the public adapter
    # contract identical across PyTorch and ONNX backends.
    from .game_adapter import AdapterError, Note, Transcription

    started = time.monotonic()
    try:
        graphs = _graphs(str(config.model_dir))
        samplerate = graphs.samplerate
        waveform = _decode_audio(payload, samplerate)
        if waveform.size == 0:
            raise RuntimeError("decoded audio is empty")

        collected: list[_RawNote] = []
        for chunk in Slicer.for_extraction(samplerate).slice(waveform):
            duration_sec = chunk.duration_sec(samplerate)
            # A chunk the encoder would see no frames of has nothing to
            # segment. Upstream's slicer does not produce these in practice;
            # the guard is here so a degenerate tail cannot fail a whole take.
            if round(duration_sec / graphs.timestep) < 1:
                continue
            for note in _infer_chunk(graphs, chunk.waveform, duration_sec):
                # Chunk-relative to absolute source seconds. Everything
                # downstream reads Raw as the recording's own clock.
                note.onset += chunk.offset_sec
                note.offset += chunk.offset_sec
                collected.append(note)

        return Transcription(
            notes=[
                Note(start_sec=note.onset, end_sec=note.offset, pitch=note.pitch)
                for note in combine(collected)
            ],
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
    except AdapterError:
        raise
    except Exception as error:
        raise AdapterError(f"GAME ONNX inference failed: {error}") from error
