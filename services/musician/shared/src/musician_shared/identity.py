"""The Musician Identity Guard.

A generative model returning valid notation is not evidence that it kept the
user's idea. It is only evidence that it returned valid notation. This module is
the thing that decides whether a candidate is still recognisably what the person
hummed, and it is deterministic on purpose: the model does not get to grade its
own work.

## What this is not

It is **not a quality score.** It cannot tell you whether music is good, and
nothing in the product may present it as though it can. It answers one question
-- *is this still the user's idea?* -- and a candidate that passes may still be
musically dull.

## Why the aggregate is a weighted minimum, not a mean

A mean lets a catastrophic failure in one dimension hide behind good scores in
the others: a candidate that abandons the motif entirely but keeps the meter,
duration and range would average out respectably. The aggregate therefore blends
the weighted mean with the worst single dimension, so one collapsed dimension
drags the whole result down. The Teacher's identity scoring uses the same
reasoning, for the same reason.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .contract import IdentityReport, Key, Meter, Note
from .dtw import dtw_similarity

_PITCH_CLASSES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)
_MINOR_SCALE = (0, 2, 3, 5, 7, 8, 10)


@dataclass(frozen=True)
class IdentityThresholds:
    """The guardrail, per policy.

    Refined and Developed differ here, and that difference is a large part of
    what makes them two products rather than two seeds.
    """

    aggregate_floor: float
    contour_floor: float
    motif_floor: float
    max_duration_ratio: float
    min_duration_ratio: float
    max_pitch_range_change: float
    max_density_change: float
    require_meter_match: bool


def intervals_of(notes: Sequence[Note]) -> list[int]:
    return [b.pitch - a.pitch for a, b in zip(notes, notes[1:])]


def _safe_ratio(candidate: float, reference: float) -> float:
    if reference <= 0.0:
        return 1.0 if candidate <= 0.0 else float("inf")
    return candidate / reference


def _contour_similarity(reference: Sequence[Note], candidate: Sequence[Note]) -> float:
    """Timing-independent comparison of the melodic shape."""
    return dtw_similarity(intervals_of(reference), intervals_of(candidate))


def _motif_survival(
    reference_motifs: Sequence[tuple[int, ...]],
    candidate: Sequence[Note],
) -> float:
    """Fraction of the reference motifs still findable in the candidate.

    Matching is on intervals, and tolerant: a motif restated with one interval
    altered is a development of that motif, not its loss. That tolerance is the
    point -- a guard that demanded exact repetition would reject precisely the
    musical gesture the Developed variant exists to produce.
    """
    if not reference_motifs:
        # Nothing claimed to be a motif, so nothing can have been lost. Neutral
        # rather than perfect: this must not become a free pass that lifts a
        # weak candidate over the floor.
        return 0.75

    candidate_intervals = intervals_of(candidate)
    if not candidate_intervals:
        return 0.0

    survived = 0
    for motif in reference_motifs:
        if not motif:
            continue
        window = len(motif)
        best = 0.0
        for start in range(0, max(1, len(candidate_intervals) - window + 1)):
            slice_ = candidate_intervals[start : start + window]
            if len(slice_) < window:
                continue
            matches = sum(1 for a, b in zip(motif, slice_) if abs(a - b) <= 1)
            best = max(best, matches / window)
        if best >= 0.6:
            survived += 1

    return survived / len(reference_motifs)


def _phrase_similarity(reference: Sequence[Note], candidate: Sequence[Note]) -> float:
    """Do the phrase boundaries still fall in roughly the same places?

    Phrases are re-derived from rests rather than trusted from the input,
    because the candidate has no phrase annotation of its own. A candidate that
    keeps the tune but reorganises every breath has changed the form.
    """
    reference_breaks = _phrase_break_positions(reference)
    candidate_breaks = _phrase_break_positions(candidate)

    if not reference_breaks and not candidate_breaks:
        return 1.0
    if not reference_breaks or not candidate_breaks:
        return 0.5

    matched = 0
    for position in reference_breaks:
        if any(abs(position - other) <= 0.12 for other in candidate_breaks):
            matched += 1
    recall = matched / len(reference_breaks)
    precision = matched / len(candidate_breaks)
    if recall + precision == 0.0:
        return 0.0
    return 2 * recall * precision / (recall + precision)


def _phrase_break_positions(notes: Sequence[Note]) -> list[float]:
    """Normalised positions (0..1) of gaps long enough to read as a breath."""
    if len(notes) < 2:
        return []
    gaps = [b.start_sec - a.end_sec for a, b in zip(notes, notes[1:])]
    positive = [g for g in gaps if g > 0]
    if not positive:
        return []
    # Relative to this melody's own gaps, not an absolute millisecond figure: a
    # slow ballad and a fast phrase breathe at very different lengths.
    threshold = max(sorted(positive)[len(positive) // 2] * 2.0, 0.12)
    span = notes[-1].end_sec - notes[0].start_sec
    if span <= 0:
        return []
    return [
        (notes[i].end_sec - notes[0].start_sec) / span
        for i, gap in enumerate(gaps)
        if gap >= threshold
    ]


def _tonal_compatibility(candidate: Sequence[Note], key: Key | None) -> float:
    """Fraction of candidate notes inside the reference key.

    When no key was detected this returns a neutral 0.8 rather than 1.0. An
    unknown key is not evidence of tonal agreement, and scoring it as perfect
    would let the guard wave through exactly the takes it understands least.
    """
    if key is None or not candidate:
        return 0.8

    try:
        tonic_index = _PITCH_CLASSES.index(_normalise_tonic(key.tonic))
    except ValueError:
        return 0.8

    scale = _MAJOR_SCALE if key.mode.value == "major" else _MINOR_SCALE
    allowed = {(tonic_index + degree) % 12 for degree in scale}
    inside = sum(1 for note in candidate if note.pitch % 12 in allowed)
    return inside / len(candidate)


def _normalise_tonic(tonic: str) -> str:
    flats = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}
    cleaned = tonic.strip().capitalize() if len(tonic) == 1 else tonic.strip()
    cleaned = cleaned[0].upper() + cleaned[1:]
    return flats.get(cleaned, cleaned)


def _pitch_range(notes: Sequence[Note]) -> int:
    if not notes:
        return 0
    pitches = [n.pitch for n in notes]
    return max(pitches) - min(pitches)


def _note_density(notes: Sequence[Note], duration_sec: float) -> float:
    if duration_sec <= 0:
        return 0.0
    return len(notes) / duration_sec


def evaluate_identity(
    *,
    reference: Sequence[Note],
    reference_key: Key | None,
    reference_meter: Meter,
    reference_duration_sec: float,
    reference_motifs: Sequence[tuple[int, ...]],
    candidate: Sequence[Note],
    candidate_meter: Meter,
    candidate_duration_sec: float,
    thresholds: IdentityThresholds,
) -> IdentityReport:
    """Compare a candidate against the Teacher material it came from."""
    contour = _contour_similarity(reference, candidate)
    motif = _motif_survival(reference_motifs, candidate)
    phrase = _phrase_similarity(reference, candidate)
    tonal = _tonal_compatibility(candidate, reference_key)

    meter_matches = (
        candidate_meter.numerator == reference_meter.numerator
        and candidate_meter.denominator == reference_meter.denominator
    )
    meter_score = 1.0 if meter_matches else 0.0

    duration_ratio = _safe_ratio(candidate_duration_sec, reference_duration_sec)
    range_change = _safe_ratio(float(_pitch_range(candidate)), float(_pitch_range(reference)))
    density_change = _safe_ratio(
        _note_density(candidate, candidate_duration_sec),
        _note_density(reference, reference_duration_sec),
    )

    weights = {
        "contour": 0.34,
        "motif": 0.26,
        "phrase": 0.16,
        "tonal": 0.14,
        "meter": 0.10,
    }
    scores = {
        "contour": contour,
        "motif": motif,
        "phrase": phrase,
        "tonal": tonal,
        "meter": meter_score,
    }
    weighted_mean = sum(weights[k] * scores[k] for k in weights)
    worst = min(scores.values())
    # 0.65/0.35 keeps the mean in charge while making one collapsed dimension
    # impossible to hide. See the module docstring.
    aggregate = 0.65 * weighted_mean + 0.35 * worst

    failures: list[str] = []
    if aggregate < thresholds.aggregate_floor:
        failures.append(f"aggregate {aggregate:.3f} below floor {thresholds.aggregate_floor:.3f}")
    if contour < thresholds.contour_floor:
        failures.append(f"contour {contour:.3f} below floor {thresholds.contour_floor:.3f}")
    if motif < thresholds.motif_floor:
        failures.append(f"motif survival {motif:.3f} below floor {thresholds.motif_floor:.3f}")
    if not thresholds.min_duration_ratio <= duration_ratio <= thresholds.max_duration_ratio:
        failures.append(
            f"duration ratio {duration_ratio:.3f} outside "
            f"{thresholds.min_duration_ratio:.2f}..{thresholds.max_duration_ratio:.2f}"
        )
    if range_change > thresholds.max_pitch_range_change:
        failures.append(
            f"pitch range grew {range_change:.2f}x, over {thresholds.max_pitch_range_change:.2f}x"
        )
    if density_change > thresholds.max_density_change or (
        density_change > 0 and density_change < 1.0 / thresholds.max_density_change
    ):
        failures.append(f"note density changed {density_change:.2f}x")
    if thresholds.require_meter_match and not meter_matches:
        failures.append(
            f"meter changed {reference_meter.numerator}/{reference_meter.denominator} -> "
            f"{candidate_meter.numerator}/{candidate_meter.denominator}"
        )

    return IdentityReport(
        contour_similarity=round(contour, 6),
        motif_survival=round(motif, 6),
        phrase_similarity=round(phrase, 6),
        tonal_compatibility=round(tonal, 6),
        meter_compatibility=meter_score,
        duration_ratio=round(duration_ratio, 6),
        pitch_range_change=round(range_change, 6),
        note_density_change=round(density_change, 6),
        aggregate=round(aggregate, 6),
        passed=not failures,
        failures=tuple(failures),
    )
