"""GAME's audio slicer, ported to numpy.

## Why this file exists

Upstream GAME never transcribes a whole recording. `infer.py extract` builds a
`Slicer`, cuts the take at silences, and runs the model on each chunk
separately; `SlicedAudioFileIterableDataset` carries each chunk's `offset`
alongside its waveform so the results can be put back on the source clock
afterwards.

That is not a performance trick. The model sees, and was trained to see, spans
of singing rather than a recording with long gaps in it, and the silence between
chunks never reaches the encoder at all — it is reconstructed from the offsets.
A runner that feeds the whole file through in one pass is asking the segmenter
to model something it is never shown, which is what the large ONNX backend was
doing.

## Why a port rather than an import

`inference/slicer2.py` upstream depends on nothing but numpy, so importing it
from the pinned checkout inside the image would have worked. It is copied
instead for two reasons: the ONNX backend is meant to stand on its own without
the PyTorch inference tree beside it, and a slicer that can be constructed in a
unit test without a 700 MB runtime is a slicer whose offsets can actually be
asserted.

The deviation is recorded in `third_party/MANIFEST.md` under rule 7. Upstream is
MIT (Copyright (c) 2026 Team OpenVPI), pinned at
`4ad815c90dfe2442730f3fdc866fd23e737cbc97`.

## What was kept

Everything that decides where a cut lands. The frame arithmetic, the RMS
window, the three silence-width branches and the leading/trailing special cases
are upstream's, deliberately unmodified — a "cleaner" rewrite that moves a
boundary by one frame moves every note onset after it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def get_rms(
    y: np.ndarray,
    *,
    frame_length: int = 2048,
    hop_length: int = 512,
    pad_mode: str = "constant",
) -> np.ndarray:
    """Framewise RMS. Upstream's copy of librosa's, kept so librosa is not a dependency."""
    padding = (int(frame_length // 2), int(frame_length // 2))
    y = np.pad(y, padding, mode=pad_mode)

    axis = -1
    # put our new within-frame axis at the end for now
    out_strides = y.strides + tuple([y.strides[axis]])
    # Reduce the shape on the framing axis
    x_shape_trimmed = list(y.shape)
    x_shape_trimmed[axis] -= frame_length - 1
    out_shape = tuple(x_shape_trimmed) + tuple([frame_length])
    xw = np.lib.stride_tricks.as_strided(y, shape=out_shape, strides=out_strides)
    if axis < 0:
        target_axis = axis - 1
    else:
        target_axis = axis + 1
    xw = np.moveaxis(xw, -1, target_axis)
    # Downsample along the target axis
    slices = [slice(None)] * xw.ndim
    slices[axis] = slice(0, None, hop_length)
    x = xw[tuple(slices)]

    power = np.mean(np.abs(x) ** 2, axis=-2, keepdims=True)

    return np.sqrt(power)


@dataclass(frozen=True)
class Chunk:
    """One sliced span, and where it sits in the source.

    `offset_sec` is the whole reason this type exists. It is the only thing that
    can put a chunk-relative note time back on the recording's own clock, and
    losing it is indistinguishable from the singer having performed without any
    of the pauses.
    """

    offset_sec: float
    waveform: np.ndarray

    def duration_sec(self, samplerate: int) -> float:
        """Chunk length in seconds, upstream's way of computing it.

        The dataset derives this from the sliced sample count rather than from
        the slice boundaries, and the difference is real at the tail: the last
        chunk is truncated to the end of the waveform, so its frame-derived
        length would overrun the audio that actually exists.
        """
        return float(self.waveform.shape[0]) / samplerate


class Slicer:
    """Cuts a waveform at silences, upstream's way.

    Defaults are upstream's class defaults, not `infer.py extract`'s. The
    extraction command overrides four of them, and `for_extraction` below is the
    combination this service actually uses.
    """

    def __init__(
        self,
        sr: int,
        threshold: float = -40.0,
        min_length: int = 5000,
        min_interval: int = 300,
        hop_size: int = 20,
        max_sil_kept: int = 5000,
    ) -> None:
        if not min_length >= min_interval >= hop_size:
            raise ValueError(
                "The following condition must be satisfied: min_length >= min_interval >= hop_size"
            )
        if not max_sil_kept >= hop_size:
            raise ValueError(
                "The following condition must be satisfied: max_sil_kept >= hop_size"
            )
        min_interval = sr * min_interval / 1000
        self.sr = sr
        self.threshold = 10 ** (threshold / 20.0)
        self.hop_size = round(sr * hop_size / 1000)
        self.win_size = min(round(min_interval), 4 * self.hop_size)
        self.min_length = round(sr * min_length / 1000 / self.hop_size)
        self.min_interval = round(min_interval / self.hop_size)
        self.max_sil_kept = round(sr * max_sil_kept / 1000 / self.hop_size)

    @classmethod
    def for_extraction(cls, sr: int) -> "Slicer":
        """The slicer `infer.py extract` builds, with its four overrides.

        Kept as a named constructor so that the settings the transcription
        quality actually depends on live next to the code that implements them,
        rather than being four positional numbers at a call site.
        """
        return cls(
            sr=sr,
            threshold=-40.0,
            min_length=1000,
            min_interval=200,
            max_sil_kept=100,
        )

    def _apply_slice(self, waveform: np.ndarray, begin: int, end: int) -> Chunk:
        return Chunk(
            offset_sec=begin * self.hop_size / self.sr,
            waveform=waveform[begin * self.hop_size : min(waveform.shape[0], end * self.hop_size)],
        )

    def slice(self, waveform: np.ndarray) -> list[Chunk]:
        samples = waveform
        if (samples.shape[0] + self.hop_size - 1) // self.hop_size <= self.min_length:
            return [Chunk(offset_sec=0.0, waveform=waveform)]
        rms_list = get_rms(
            y=samples, frame_length=self.win_size, hop_length=self.hop_size
        ).squeeze(0)
        sil_tags: list[tuple[int, int]] = []
        silence_start: int | None = None
        clip_start = 0
        for i, rms in enumerate(rms_list):
            # Keep looping while frame is silent.
            if rms < self.threshold:
                # Record start of silent frames.
                if silence_start is None:
                    silence_start = i
                continue
            # Keep looping while frame is not silent and silence start has not been recorded.
            if silence_start is None:
                continue
            # Clear recorded silence start if interval is not enough or clip is too short
            is_leading_silence = silence_start == 0 and i > self.max_sil_kept
            need_slice_middle = (
                i - silence_start >= self.min_interval and i - clip_start >= self.min_length
            )
            if not is_leading_silence and not need_slice_middle:
                silence_start = None
                continue
            # Need slicing. Record the range of silent frames to be removed.
            if i - silence_start <= self.max_sil_kept:
                pos = rms_list[silence_start : i + 1].argmin() + silence_start
                if silence_start == 0:
                    sil_tags.append((0, pos))
                else:
                    sil_tags.append((pos, pos))
                clip_start = pos
            elif i - silence_start <= self.max_sil_kept * 2:
                pos = rms_list[i - self.max_sil_kept : silence_start + self.max_sil_kept + 1].argmin()
                pos += i - self.max_sil_kept
                pos_l = (
                    rms_list[silence_start : silence_start + self.max_sil_kept + 1].argmin()
                    + silence_start
                )
                pos_r = rms_list[i - self.max_sil_kept : i + 1].argmin() + i - self.max_sil_kept
                if silence_start == 0:
                    sil_tags.append((0, pos_r))
                    clip_start = pos_r
                else:
                    sil_tags.append((min(pos_l, pos), max(pos_r, pos)))
                    clip_start = max(pos_r, pos)
            else:
                pos_l = (
                    rms_list[silence_start : silence_start + self.max_sil_kept + 1].argmin()
                    + silence_start
                )
                pos_r = rms_list[i - self.max_sil_kept : i + 1].argmin() + i - self.max_sil_kept
                if silence_start == 0:
                    sil_tags.append((0, pos_r))
                else:
                    sil_tags.append((pos_l, pos_r))
                clip_start = pos_r
            silence_start = None
        # Deal with trailing silence.
        total_frames = rms_list.shape[0]
        if silence_start is not None and total_frames - silence_start >= self.min_interval:
            silence_end = min(total_frames, silence_start + self.max_sil_kept)
            pos = rms_list[silence_start : silence_end + 1].argmin() + silence_start
            sil_tags.append((pos, total_frames + 1))
        # Apply and return slices.
        if len(sil_tags) == 0:
            return [Chunk(offset_sec=0.0, waveform=waveform)]
        chunks: list[Chunk] = []
        if sil_tags[0][0] > 0:
            chunks.append(self._apply_slice(waveform, 0, sil_tags[0][0]))
        for i in range(len(sil_tags) - 1):
            chunks.append(self._apply_slice(waveform, sil_tags[i][1], sil_tags[i + 1][0]))
        if sil_tags[-1][1] < total_frames:
            chunks.append(self._apply_slice(waveform, sil_tags[-1][1], total_frames))
        return chunks
