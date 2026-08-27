"""Small server-side router for melody versus deliberately non-melodic rhythm.

This does not transcribe melody. It answers only whether GAME is the right
route. Rhythm material is then converted to drum onsets here so the retired
browser worker is not an automatic fallback.
"""

from __future__ import annotations

import io
import math
import wave
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class AudioEvidence:
    samples: np.ndarray
    sample_rate: int
    duration_sec: float
    voiced_ratio: float
    onset_rate: float
    confidence: float
    route: str


def _read_wav(payload: bytes) -> tuple[np.ndarray, int]:
    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            frames = source.readframes(source.getnframes())
    except (wave.Error, EOFError) as error:
        raise ValueError("audio must be PCM WAV") from error
    if sample_width != 2 or channels < 1 or sample_rate <= 0:
        raise ValueError("audio must be 16-bit PCM WAV")
    values = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        values = values.reshape(-1, channels).mean(axis=1)
    return values, sample_rate


def classify(payload: bytes) -> AudioEvidence:
    samples, sample_rate = _read_wav(payload)
    duration = len(samples) / sample_rate
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    if peak <= 1e-6 or duration <= 0:
        return AudioEvidence(samples, sample_rate, duration, 0, 0, 1, "unknown")
    samples = samples / peak

    frame_size = 1024
    hop = 512
    energies: list[float] = []
    periodicities: list[float] = []
    for start in range(0, max(0, len(samples) - frame_size + 1), hop):
        frame = samples[start : start + frame_size]
        energy = float(np.sqrt(np.mean(frame * frame)))
        energies.append(energy)
        if energy < 0.01:
            periodicities.append(0.0)
            continue
        centered = frame - float(np.mean(frame))
        corr = np.correlate(centered, centered, mode="full")[frame_size - 1 :]
        zero = float(corr[0]) if len(corr) else 0.0
        low_lag = max(2, int(sample_rate / 1000))
        high_lag = min(len(corr), int(sample_rate / 55))
        periodicities.append(
            float(np.max(corr[low_lag:high_lag]) / zero)
            if zero > 1e-9 and high_lag > low_lag
            else 0.0
        )

    if len(energies) < 4:
        return AudioEvidence(samples, sample_rate, duration, 0, 0, 0, "unknown")
    energy_array = np.asarray(energies)
    floor = max(0.008, float(np.median(energy_array)) * 0.35)
    voiced = [p >= 0.55 and e > floor for p, e in zip(periodicities, energies)]
    voiced_ratio = sum(voiced) / len(voiced)

    rises = np.maximum(0, np.diff(energy_array, prepend=energy_array[0]))
    threshold = float(np.median(rises) + 2.5 * np.median(np.abs(rises - np.median(rises))))
    minimum_frames = max(1, int(0.07 * sample_rate / hop))
    attacks = 0
    last = -minimum_frames
    for index, rise in enumerate(rises):
        if rise > max(0.012, threshold) and index - last >= minimum_frames:
            attacks += 1
            last = index
    onset_rate = attacks / max(duration, 1e-6)

    rhythm_strength = min(1.0, onset_rate / 2.5) * min(1.0, (0.38 - voiced_ratio) / 0.28)
    melody_strength = min(1.0, voiced_ratio / 0.45)
    if rhythm_strength >= 0.45 and rhythm_strength > melody_strength:
        route = "rhythm"
        confidence = min(1.0, 0.55 + (rhythm_strength - melody_strength) * 0.7)
    elif melody_strength >= 0.2:
        route = "melody"
        confidence = min(1.0, 0.55 + (melody_strength - rhythm_strength) * 0.6)
    else:
        route = "unknown"
        confidence = max(rhythm_strength, melody_strength)
    return AudioEvidence(samples, sample_rate, duration, voiced_ratio, onset_rate, confidence, route)


def rhythm_events(evidence: AudioEvidence) -> list[dict[str, float | int | str]]:
    samples = evidence.samples
    sample_rate = evidence.sample_rate
    frame_size = 1024
    hop = 256
    if len(samples) < frame_size:
        return []
    frames = np.stack(
        [samples[start : start + frame_size] for start in range(0, len(samples) - frame_size + 1, hop)]
    )
    windowed = frames * np.hanning(frame_size)
    magnitudes = np.abs(np.fft.rfft(windowed, axis=1))
    flux = np.maximum(0, np.diff(magnitudes, axis=0, prepend=magnitudes[:1])).sum(axis=1)
    threshold = float(np.median(flux) + 3 * np.median(np.abs(flux - np.median(flux))))
    minimum = max(1, int(0.065 * sample_rate / hop))
    candidates: list[int] = []
    last = -minimum
    for index in range(1, len(flux) - 1):
        if flux[index] > max(threshold, 1e-6) and flux[index] >= flux[index - 1] and flux[index] >= flux[index + 1]:
            if index - last >= minimum:
                candidates.append(index)
                last = index

    maximum = float(np.max(flux)) if len(flux) else 1.0
    frequencies = np.fft.rfftfreq(frame_size, 1 / sample_rate)
    events: list[dict[str, float | int | str]] = []
    for index in candidates:
        spectrum = magnitudes[index]
        total = float(np.sum(spectrum)) or 1.0
        centroid = float(np.sum(spectrum * frequencies) / total)
        drum = "kick" if centroid < 1100 else "hat" if centroid > 3500 else "snare"
        events.append(
            {
                "timeSec": round(index * hop / sample_rate, 6),
                "drum": drum,
                "velocity": max(1, min(127, round(35 + 92 * float(flux[index]) / maximum))),
                "confidence": round(min(1.0, float(flux[index]) / max(threshold * 2, 1e-6)), 4),
            }
        )
    return events
