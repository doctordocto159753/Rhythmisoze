"""Deciding which spans MIDI-RWKV is allowed to touch.

RWKV must not rewrite the whole tune. If it could, there would be no reason to
run MelodyT5 first, and no way to say afterwards what changed or why. So the
choice of span is made here, deterministically, before any model is consulted --
and it is made from structural evidence, not from a model's opinion about its
own weakest work.

## The heuristics, and what each is actually looking for

Each returns a score in 0..1, where higher means "this span is a worse fit with
its surroundings". They are all *relative to the melody itself*: a wide leap in a
line full of wide leaps is the style, not a defect, and an absolute threshold
would flag the whole piece.

Every nomination carries a human-readable reason, because "the model changed
bars 3-4" is not something anyone can review, whereas "bars 3-4: interval
outlier, a 14th against a median of a 2nd" is.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from statistics import median

from .contract import InfillSpan, Note

#: A span shorter than this is not worth a model round-trip -- and infilling one
#: or two notes gives RWKV so little to work with that it mostly reproduces its
#: context.
MIN_SPAN_NOTES = 3

#: Beyond this, it stops being local repair.
MAX_SPAN_NOTES = 8


@dataclass(frozen=True)
class SpanCandidate:
    start_index: int
    end_index: int
    score: float
    reason: str

    def to_span(self) -> InfillSpan:
        return InfillSpan(
            start_index=self.start_index,
            end_index=self.end_index,
            reason=self.reason,
        )


def _intervals(notes: Sequence[Note]) -> list[int]:
    return [abs(b.pitch - a.pitch) for a, b in zip(notes, notes[1:])]


def _interval_outliers(notes: Sequence[Note]) -> list[SpanCandidate]:
    """A leap far wider than this melody's habit."""
    intervals = _intervals(notes)
    if len(intervals) < 4:
        return []
    typical = median(intervals) or 1.0
    out: list[SpanCandidate] = []
    for index, interval in enumerate(intervals):
        if interval >= max(7.0, typical * 3.0):
            start = max(0, index - 1)
            end = min(len(notes), index + 3)
            if end - start >= MIN_SPAN_NOTES:
                out.append(
                    SpanCandidate(
                        start_index=start,
                        end_index=end,
                        score=min(1.0, interval / 24.0),
                        reason=(
                            f"interval outlier: {interval} semitones against a "
                            f"median of {typical:.0f}"
                        ),
                    )
                )
    return out


def _density_anomalies(notes: Sequence[Note]) -> list[SpanCandidate]:
    """A run of notes much shorter or longer than the melody's habit."""
    durations = [n.duration_sec for n in notes]
    if len(durations) < 6:
        return []
    typical = median(durations) or 1.0
    out: list[SpanCandidate] = []
    window = 4
    for start in range(0, len(notes) - window + 1):
        chunk = durations[start : start + window]
        local = median(chunk) or 1.0
        ratio = local / typical if typical else 1.0
        if ratio >= 2.2 or ratio <= 0.45:
            out.append(
                SpanCandidate(
                    start_index=start,
                    end_index=start + window,
                    score=min(1.0, abs(1.0 - ratio) / 2.0),
                    reason=(
                        f"density anomaly: local note length {ratio:.2f}x the "
                        f"melody's own median"
                    ),
                )
            )
    return out


def _awkward_transitions(notes: Sequence[Note]) -> list[SpanCandidate]:
    """A gap too long to be phrasing and too short to be a rest."""
    if len(notes) < 5:
        return []
    gaps = [b.start_sec - a.end_sec for a, b in zip(notes, notes[1:])]
    positive = [g for g in gaps if g > 0]
    if len(positive) < 3:
        return []
    typical = median(positive)
    out: list[SpanCandidate] = []
    for index, gap in enumerate(gaps):
        # Long enough to be heard as a hesitation, short enough that it is not a
        # deliberate breath.
        if typical * 1.6 <= gap <= typical * 3.2:
            start = max(0, index - 1)
            end = min(len(notes), index + 3)
            if end - start >= MIN_SPAN_NOTES:
                out.append(
                    SpanCandidate(
                        start_index=start,
                        end_index=end,
                        score=min(1.0, gap / (typical * 4.0)) if typical else 0.5,
                        reason=f"awkward transition: a {gap * 1000:.0f} ms hesitation",
                    )
                )
    return out


def _weak_closure(notes: Sequence[Note]) -> list[SpanCandidate]:
    """A phrase ending that stops rather than closes.

    A final note markedly shorter than the notes around it reads as clipped, and
    it is the single most common thing a listener hears as unfinished.
    """
    if len(notes) < MIN_SPAN_NOTES + 1:
        return []
    durations = [n.duration_sec for n in notes]
    typical = median(durations) or 1.0
    last = durations[-1]
    if last < typical * 0.6:
        start = max(0, len(notes) - 4)
        return [
            SpanCandidate(
                start_index=start,
                end_index=len(notes),
                score=min(1.0, 1.0 - last / typical),
                reason=(
                    f"weak closure: final note {last * 1000:.0f} ms against a "
                    f"median of {typical * 1000:.0f} ms"
                ),
            )
        ]
    return []


def _merge_overlapping(candidates: list[SpanCandidate]) -> list[SpanCandidate]:
    """Collapse overlapping nominations, keeping the strongest reason.

    Two heuristics firing on the same bars is one weak span, not two, and
    infilling it twice would mean the second pass rewrote the first pass's work.
    """
    if not candidates:
        return []
    ordered = sorted(candidates, key=lambda c: (c.start_index, c.end_index))
    merged: list[SpanCandidate] = [ordered[0]]
    for candidate in ordered[1:]:
        last = merged[-1]
        if candidate.start_index < last.end_index:
            if candidate.score > last.score:
                merged[-1] = SpanCandidate(
                    start_index=min(last.start_index, candidate.start_index),
                    end_index=max(last.end_index, candidate.end_index),
                    score=candidate.score,
                    reason=candidate.reason,
                )
            else:
                merged[-1] = SpanCandidate(
                    start_index=min(last.start_index, candidate.start_index),
                    end_index=max(last.end_index, candidate.end_index),
                    score=last.score,
                    reason=last.reason,
                )
        else:
            merged.append(candidate)
    return merged


def nominate_weak_spans(notes: Sequence[Note], *, limit: int) -> list[SpanCandidate]:
    """The spans worth asking RWKV about, strongest first.

    Deterministic: the same melody always nominates the same spans, which is
    what makes a generation reproducible from seed and parameters alone (AC-08).
    """
    if limit <= 0 or len(notes) < MIN_SPAN_NOTES:
        return []

    found = (
        _interval_outliers(notes)
        + _density_anomalies(notes)
        + _awkward_transitions(notes)
        + _weak_closure(notes)
    )
    merged = _merge_overlapping(found)

    clamped: list[SpanCandidate] = []
    for candidate in merged:
        end = min(candidate.end_index, candidate.start_index + MAX_SPAN_NOTES, len(notes))
        if end - candidate.start_index >= MIN_SPAN_NOTES:
            clamped.append(
                SpanCandidate(
                    start_index=candidate.start_index,
                    end_index=end,
                    score=candidate.score,
                    reason=candidate.reason,
                )
            )

    # Sort by strength, then by position so ties are stable rather than
    # dependent on which heuristic happened to run first.
    clamped.sort(key=lambda c: (-c.score, c.start_index))
    return clamped[:limit]
