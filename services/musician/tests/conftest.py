"""Shared fixtures.

Every melody here is written by hand rather than generated, so each test's
expected outcome is something a person decided, not something a helper happened
to produce.
"""

from __future__ import annotations

import pytest
from musician_shared.contract import Key, Meter, Mode, Motif, MusicianInput, Note, Tempo


def build_notes(
    pitches: list[int],
    *,
    duration: float = 0.45,
    gap: float = 0.05,
    start: float = 0.0,
) -> tuple[Note, ...]:
    notes: list[Note] = []
    cursor = start
    for pitch in pitches:
        notes.append(
            Note(
                pitch=pitch,
                start_sec=round(cursor, 6),
                end_sec=round(cursor + duration, 6),
                velocity=90,
            )
        )
        cursor += duration + gap
    return tuple(notes)


#: Distinguishes "caller did not say" from "caller explicitly wants no key".
_UNSET = object()


def build_input(
    pitches: list[int],
    *,
    motifs: tuple[Motif, ...] = (),
    key=_UNSET,
    meter: Meter | None = None,
    **kwargs,
) -> MusicianInput:
    notes = build_notes(pitches, **kwargs)
    return MusicianInput(
        source_id="test",
        notes=notes,
        tempo=Tempo(bpm=120.0, confidence=0.82),
        meter=meter or Meter(numerator=4, denominator=4, confidence=0.74),
        key=Key(tonic="C", mode=Mode.MAJOR, confidence=0.71) if key is _UNSET else key,
        motifs=motifs,
        duration_sec=notes[-1].end_sec + 0.5,
    )


@pytest.fixture
def simple_melody() -> MusicianInput:
    """A plain diatonic phrase in C, with a stated motif."""
    return build_input(
        [60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 60],
        motifs=(Motif(intervals=(2, 2, 1), occurrences=(0,)),),
    )


@pytest.fixture
def defective_melody() -> MusicianInput:
    """A phrase with a deliberate leap outlier and a clipped ending.

    Both defects are the kind the weak-span heuristics exist to nominate, so a
    test can assert that they are found *and* that a clean melody is left alone.
    """
    notes = list(build_notes([60, 62, 64, 65, 84, 64, 62, 60, 62, 64, 65]))
    last = notes[-1]
    notes.append(
        Note(
            pitch=67,
            start_sec=round(last.end_sec + 0.05, 6),
            end_sec=round(last.end_sec + 0.17, 6),
            velocity=90,
        )
    )
    return MusicianInput(
        source_id="defective",
        notes=tuple(notes),
        tempo=Tempo(bpm=120.0, confidence=0.8),
        meter=Meter(numerator=4, denominator=4, confidence=0.7),
        key=Key(tonic="C", mode=Mode.MAJOR, confidence=0.7),
        duration_sec=notes[-1].end_sec + 0.5,
    )
