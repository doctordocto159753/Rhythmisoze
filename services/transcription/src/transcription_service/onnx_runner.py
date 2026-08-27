"""GAME v1.0.3 large ONNX inference backend.

The graph order mirrors the upstream ONNX contract:
encoder -> dur2bd -> iterative D3PM segmenter -> bd2dur -> estimator.
Audio is decoded to mono 44.1 kHz float32 with ffmpeg, which is already present
in the transcription image.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from functools import lru_cache
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .config import Config


@lru_cache(maxsize=2)
def _sessions(model_dir_raw: str):
    model_dir = Path(model_dir_raw)
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, int(os.environ.get("GAME_ONNX_THREADS", "4")))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

    def load(name: str):
        return ort.InferenceSession(
            str(model_dir / f"{name}.onnx"),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    config = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    return config, load("encoder"), load("segmenter"), load("dur2bd"), load("bd2dur"), load("estimator")


def _decode_audio(payload: bytes, samplerate: int) -> np.ndarray:
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


def transcribe(payload: bytes, config: Config):
    # Imported lazily to avoid a module cycle while keeping the public adapter
    # contract identical across PyTorch and ONNX backends.
    from .game_adapter import AdapterError, Note, Transcription

    started = time.monotonic()
    try:
        graph_config, encoder, segmenter, dur2bd, bd2dur, estimator = _sessions(str(config.model_dir))
        samplerate = int(graph_config.get("samplerate", 44100))
        timestep = float(graph_config.get("timestep", 0.01))
        waveform_1d = _decode_audio(payload, samplerate)
        if waveform_1d.size == 0:
            raise RuntimeError("decoded audio is empty")

        duration_sec = waveform_1d.size / samplerate
        waveform = waveform_1d[None, :].astype(np.float32, copy=False)
        duration = np.array([duration_sec], dtype=np.float32)

        x_seg, x_est, mask_t = encoder.run(
            None,
            {"waveform": waveform, "duration": duration},
        )

        # Extraction starts with one known region covering the complete clip,
        # matching GAME's PyTorch path where known_durations=[[duration]].
        known_durations = np.array([[duration_sec]], dtype=np.float32)
        known_boundaries, = dur2bd.run(
            None,
            {"durations": known_durations, "maskT": mask_t},
        )
        boundaries = known_boundaries.copy()

        language = np.array([0], dtype=np.int64)
        boundary_threshold = np.array(0.2, dtype=np.float32)
        boundary_radius = np.array(2, dtype=np.int64)

        if bool(graph_config.get("loop", True)):
            sample_ts = [i / 8.0 for i in range(8)]
        else:
            sample_ts = [0.0]

        for value in sample_ts:
            boundaries, = segmenter.run(
                None,
                {
                    "x_seg": x_seg,
                    "language": language,
                    "known_boundaries": known_boundaries,
                    "prev_boundaries": boundaries,
                    "t": np.array([value], dtype=np.float32),
                    "maskT": mask_t,
                    "threshold": boundary_threshold,
                    "radius": boundary_radius,
                },
            )

        durations, mask_n = bd2dur.run(
            None,
            {"boundaries": boundaries, "maskT": mask_t},
        )
        presence, scores = estimator.run(
            None,
            {
                "x_est": x_est,
                "boundaries": boundaries,
                "maskT": mask_t,
                "maskN": mask_n,
                "threshold": np.array(0.2, dtype=np.float32),
            },
        )

        notes: list[Note] = []
        cursor = 0.0
        for region_duration, valid, voiced, pitch in zip(
            durations[0], mask_n[0], presence[0], scores[0]
        ):
            if not bool(valid):
                continue
            start = cursor
            cursor += max(0.0, float(region_duration))
            if not bool(voiced):
                continue
            pitch_value = float(pitch)
            if not np.isfinite(pitch_value) or cursor <= start:
                continue
            notes.append(Note(start_sec=start, end_sec=cursor, pitch=pitch_value))

        return Transcription(
            notes=notes,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
    except AdapterError:
        raise
    except Exception as error:
        raise AdapterError(f"GAME ONNX inference failed: {error}") from error
