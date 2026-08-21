"""Canonical notes <-> ABC, the notation MelodyT5 reads and writes.

## Why this is written out rather than delegated to music21

music21 can emit ABC, and it is the right tool for measures, meter hierarchy and
key context -- which is what it is used for here. But it is not used for the
conversion itself, for one reason: **several music21 operations normalise or
re-spell content as a side effect of parsing or export.** That is documented as
a rule in `third_party/MANIFEST.md`, and a conversion helper is precisely where
such a change would be invisible.

If music21 re-spells an accidental on the way out and again on the way back, the
Identity Guard sees a pitch change the model never made, and either rejects a
good candidate or -- worse -- accepts a bad one because the reference moved too.
So conversion is explicit, lossless within its documented rounding, and tested
by round-trip.

music21 is still used, through :func:`validate_with_music21`, to check that what
we produced is coherent notation. Validation cannot silently rewrite anything,
because its result is a verdict rather than a score.

## The rounding, stated plainly

ABC is symbolic: durations are multiples of a unit note length. Seconds are not.
Converting seconds to symbolic durations therefore quantises, and quantisation
is lossy. The unit is a 16th at the detected tempo, and the residual is recorded
on the result rather than discarded, so a caller can see how much was lost
instead of assuming none was.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .contract import Key, Meter, Note

_PITCH_LETTERS = ("C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B")
_IS_SHARP = (False, True, False, True, False, False, True, False, True, False, True, False)

#: Sixteenth-note resolution. Finer buys nothing -- neither model works below
#: it -- and coarser loses genuine performed detail.
UNITS_PER_QUARTER = 4


@dataclass(frozen=True)
class AbcDocument:
    text: str
    #: Seconds of timing discarded by quantisation, summed over all notes. A
    #: caller that cares can compare this against the melody's duration.
    quantisation_residual_sec: float
    #: Notation assumptions that were not measured. Recorded in provenance so a
    #: guess never looks like a measurement (brief section 8).
    assumptions: tuple[str, ...]


def _abc_pitch(midi: int) -> str:
    """MIDI number to ABC pitch, with octave marks.

    ABC's middle octave is C..B written uppercase, which is MIDI 60..71.
    """
    octave = midi // 12 - 1
    index = midi % 12
    letter = _PITCH_LETTERS[index]
    accidental = "^" if _IS_SHARP[index] else ""

    if octave >= 5:
        letter = letter.lower()
        marks = "'" * (octave - 5)
    else:
        marks = "," * (4 - octave)
    return f"{accidental}{letter}{marks}"


def _parse_abc_pitch(token: str) -> int:
    accidental = 0
    index = 0
    while index < len(token) and token[index] in "^_=":
        if token[index] == "^":
            accidental += 1
        elif token[index] == "_":
            accidental -= 1
        index += 1

    letter = token[index]
    index += 1
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[letter.upper()]
    octave = 5 if letter.islower() else 4

    while index < len(token):
        if token[index] == "'":
            octave += 1
        elif token[index] == ",":
            octave -= 1
        index += 1

    return (octave + 1) * 12 + base + accidental


def to_abc(
    notes: Sequence[Note],
    *,
    meter: Meter,
    tempo_bpm: float,
    key: Key | None = None,
) -> AbcDocument:
    """Render notes as ABC.

    Rests are emitted for real gaps: dropping them would hand MelodyT5 a melody
    with no breathing, and it would return one.
    """
    if not notes:
        raise ValueError("cannot render an empty melody as ABC")

    seconds_per_unit = 60.0 / tempo_bpm / UNITS_PER_QUARTER
    assumptions: list[str] = []
    if key is None:
        # ABC requires a key field. "C" here means "no accidentals declared",
        # not "this melody is in C major", and it is recorded as an assumption
        # so it cannot be mistaken for a detection.
        assumptions.append("key not detected; ABC K: field written as C (no accidentals implied)")

    residual = 0.0
    body: list[str] = []
    cursor = notes[0].start_sec

    for note in notes:
        gap = note.start_sec - cursor
        if gap > seconds_per_unit * 0.5:
            rest_units = max(1, round(gap / seconds_per_unit))
            residual += abs(gap - rest_units * seconds_per_unit)
            body.append(f"z{rest_units}")

        units = max(1, round(note.duration_sec / seconds_per_unit))
        residual += abs(note.duration_sec - units * seconds_per_unit)
        body.append(f"{_abc_pitch(note.pitch)}{units}")
        cursor = note.start_sec + note.duration_sec

    key_field = "C" if key is None else f"{key.tonic}{'m' if key.mode.value == 'minor' else ''}"

    text = "\n".join(
        [
            "X:1",
            "T:Rhythmisoze",
            f"M:{meter.numerator}/{meter.denominator}",
            f"L:1/{UNITS_PER_QUARTER * 4}",
            f"Q:1/4={round(tempo_bpm)}",
            f"K:{key_field}",
            " ".join(body),
        ]
    )
    return AbcDocument(
        text=text,
        quantisation_residual_sec=round(residual, 6),
        assumptions=tuple(assumptions),
    )


def from_abc(document: str, *, tempo_bpm: float, start_sec: float = 0.0) -> tuple[Note, ...]:
    """Parse an ABC body back into notes.

    Only what :func:`to_abc` emits plus what MelodyT5 returns for a monophonic
    line: pitches, rests, integer unit lengths. Anything else raises rather than
    being skipped -- a token silently dropped is a note silently deleted.
    """
    body_lines = [
        line
        for line in document.splitlines()
        if line.strip() and not (len(line) > 1 and line[1] == ":")
    ]
    if not body_lines:
        raise ValueError("ABC document has no body")

    seconds_per_unit = 60.0 / tempo_bpm / UNITS_PER_QUARTER
    notes: list[Note] = []
    cursor = start_sec

    for token in " ".join(body_lines).replace("|", " ").split():
        token = token.strip()
        if not token:
            continue

        digits = ""
        while token and token[-1].isdigit():
            digits = token[-1] + digits
            token = token[:-1]
        units = int(digits) if digits else 1
        length = units * seconds_per_unit

        if not token:
            raise ValueError(f"ABC token {digits!r} has no pitch")

        if token in ("z", "Z", "x"):
            cursor += length
            continue

        try:
            pitch = _parse_abc_pitch(token)
        except (KeyError, IndexError) as error:
            raise ValueError(f"unparseable ABC token {token!r}") from error

        if not 0 <= pitch <= 127:
            raise ValueError(f"ABC token {token!r} is outside MIDI range (got {pitch})")

        notes.append(
            Note(
                pitch=pitch,
                start_sec=round(cursor, 6),
                end_sec=round(cursor + length, 6),
                velocity=96,
            )
        )
        cursor += length

    if not notes:
        raise ValueError("ABC document contained no notes")
    return tuple(notes)


def validate_with_music21(document: str) -> tuple[bool, str | None]:
    """Ask music21 whether this is coherent notation.

    Returns a verdict, never a rewrite. If music21 is not installed -- it is a
    dependency of the API container only -- this reports success rather than
    failing, because its absence is not evidence that the notation is wrong.
    """
    try:
        from music21 import converter  # noqa: PLC0415
    except ImportError:
        return True, None

    try:
        score = converter.parse(document, format="abc")
    except Exception as error:  # music21 raises a wide variety
        return False, f"music21 rejected the notation: {error}"

    if not score.flatten().notes:
        return False, "music21 parsed the notation but found no notes in it"
    return True, None
