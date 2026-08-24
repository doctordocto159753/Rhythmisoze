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

from .contract import Key, Meter, Note, Phrase

_PITCH_LETTERS = ("C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B")
_IS_SHARP = (False, True, False, True, False, False, True, False, True, False, True, False)

#: Sixteenth-note resolution. Finer buys nothing -- neither model works below
#: it -- and coarser loses genuine performed detail.
UNITS_PER_QUARTER = 4

#: Semitone offset of each natural letter within an octave.
_LETTER_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

#: Sharps in order of appearance in a key signature, and flats likewise.
_SHARP_ORDER = ("F", "C", "G", "D", "A", "E", "B")
_FLAT_ORDER = ("B", "E", "A", "D", "G", "C", "F")

#: How many sharps (positive) or flats (negative) each major tonic carries.
_MAJOR_FIFTHS = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7,
    "F": -1, "Bb": -2, "Eb": -3, "Ab": -4, "Db": -5, "Gb": -6, "Cb": -7,
}

#: Modes MelodyT5's folk corpus actually writes, as an offset in fifths from the
#: relative major. Minor is -3 (A minor has the same signature as C major).
_MODE_FIFTHS = {
    "": 0, "maj": 0, "major": 0, "ion": 0, "ionian": 0,
    "m": -3, "min": -3, "minor": -3, "aeo": -3, "aeolian": -3,
    "dor": -2, "dorian": -2,
    "phr": -4, "phrygian": -4,
    "lyd": 1, "lydian": 1,
    "mix": -1, "mixolydian": -1,
    "loc": -5, "locrian": -5,
}


def key_accidentals(key_field: str) -> dict[str, int]:
    """Which letters a ``K:`` field sharpens or flattens.

    Without this, a bare ``f`` in ``K:G`` parses as F natural instead of F sharp
    -- MelodyT5 writes idiomatic ABC, which means it relies on the key signature
    rather than marking every accidental, and the Identity Guard then sees a
    pitch the model never wrote. Silently wrong by a semitone on every leading
    note is worse than a parse error, because nothing reports it.

    Returns a mapping of upper-case letter to semitone offset. An unrecognised or
    explicitly signature-free field (``K:none``, ``K:C``) yields no accidentals,
    which is the correct reading rather than a fallback.
    """
    cleaned = key_field.strip()
    if not cleaned or cleaned.lower() in ("none", "hp", "hp^"):
        return {}

    # Tonic: a letter plus an optional # or b. Anything after it is the mode.
    tonic = cleaned[0].upper()
    index = 1
    if index < len(cleaned) and cleaned[index] in "#b♯♭":
        tonic += "#" if cleaned[index] in "#♯" else "b"
        index += 1
    if tonic not in _MAJOR_FIFTHS:
        return {}

    # Mode words are matched longest-first: `min` must not be read as `m`
    # followed by junk, and `mixolydian` must not be read as `m`.
    rest = cleaned[index:].strip().replace(" ", "").lower()
    fifths_offset = None
    for name in sorted(_MODE_FIFTHS, key=len, reverse=True):
        if name and rest.startswith(name):
            fifths_offset = _MODE_FIFTHS[name]
            break
    if fifths_offset is None:
        fifths_offset = 0 if not rest else _MODE_FIFTHS.get(rest, 0)

    fifths = _MAJOR_FIFTHS[tonic] + fifths_offset
    fifths = max(-7, min(7, fifths))

    if fifths > 0:
        return {letter: 1 for letter in _SHARP_ORDER[:fifths]}
    if fifths < 0:
        return {letter: -1 for letter in _FLAT_ORDER[:-fifths]}
    return {}



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
    """MIDI number to ABC pitch, with octave marks and an explicit accidental.

    ABC's middle octave is C..B written uppercase, which is MIDI 60..71.

    Use :func:`_abc_pitch_in_context` when a key signature is in force:
    :func:`from_abc` honours ``K:``, so a bare ``F`` under ``K:G`` reads back as
    F sharp and this spelling would not round-trip.
    """
    letter, needed, octave = _spell(midi)
    accidental = {1: "^", 0: "", -1: "_"}[needed]
    if octave >= 5:
        letter = letter.lower()
        marks = "'" * (octave - 5)
    else:
        marks = "," * (4 - octave)
    return f"{accidental}{letter}{marks}"


def _spell(midi: int) -> tuple[str, int, int]:
    """MIDI number as (letter, alteration, octave). Always spelled with sharps."""
    octave = midi // 12 - 1
    index = midi % 12
    return _PITCH_LETTERS[index], 1 if _IS_SHARP[index] else 0, octave


def _abc_pitch_in_context(
    midi: int,
    *,
    key_map: dict[str, int],
    bar_state: dict[tuple[str, int], int],
) -> str:
    """Spell a pitch so that :func:`from_abc` reads back exactly this MIDI number.

    An accidental is written only when the letter's *implied* alteration -- from
    the key signature, or from an earlier accidental in this bar -- is not the one
    the pitch needs. When they differ, the accidental is written explicitly,
    including a natural sign.

    Both halves matter. Omitting a needed ``=`` is how a natural F in G major
    became an F sharp on the way back; writing an accidental on every note would
    be safe but produces notation unlike anything MelodyT5 was trained on, and
    the model's output quality follows its input's shape.
    """
    letter, needed, octave = _spell(midi)
    implied = bar_state.get((letter, octave), key_map.get(letter, 0))

    if implied == needed:
        accidental = ""
    else:
        accidental = {1: "^", 0: "=", -1: "_"}[needed]
        bar_state[(letter, octave)] = needed

    written = letter
    if octave >= 5:
        written = letter.lower()
        marks = "'" * (octave - 5)
    else:
        marks = "," * (4 - octave)
    return f"{accidental}{written}{marks}"



def to_abc(
    notes: Sequence[Note],
    *,
    meter: Meter,
    tempo_bpm: float,
    key: Key | None = None,
    phrases: Sequence[Phrase] = (),
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

    key_field = "C" if key is None else f"{key.tonic}{'m' if key.mode.value == 'minor' else ''}"
    # The same map `from_abc` will build from this K: field. Spelling against it
    # is what makes the round trip exact: a bare `F` under `K:G` reads back as F
    # sharp, so a natural F has to be written `=F`.
    key_map = key_accidentals(key_field)
    bar_state: dict[tuple[str, int], int] = {}

    # Barlines are not cosmetic here.
    #
    # MelodyT5 is a *bar-patching* model: its Patchilizer splits the body on
    # barline delimiters and encodes one bar per patch. ABC with no `|` in it
    # collapses to a single patch, which is nothing like the training
    # distribution and produces correspondingly poor output. Emitting real bars
    # is what makes the input look like music the model has seen.
    units_per_bar = round(meter.beats_per_bar * UNITS_PER_QUARTER)
    units_in_bar = 0

    def close_bar() -> None:
        nonlocal units_in_bar
        body.append("|")
        units_in_bar = 0
        # A barline ends every written accidental's scope, on both sides of the
        # conversion. Forgetting it here would make the reader and the writer
        # disagree about the bar they are in.
        bar_state.clear()

    phrase_starts = {phrase.start_index for phrase in phrases}
    phrase_ends = {phrase.end_index for phrase in phrases}
    if phrase_ends and max(phrase_ends) >= len(notes):
        raise ValueError("phrase points past the last note")

    for note_index, note in enumerate(notes):
        gap = note.start_sec - cursor
        if gap > seconds_per_unit * 0.5:
            rest_units = max(1, round(gap / seconds_per_unit))
            residual += abs(gap - rest_units * seconds_per_unit)
            body.append(f"z{rest_units}")
            units_in_bar += rest_units
            while units_per_bar > 0 and units_in_bar >= units_per_bar:
                units_in_bar -= units_per_bar
                if units_in_bar == 0:
                    close_bar()
                else:
                    body.append("|")
                    bar_state.clear()
                    units_in_bar = units_in_bar % units_per_bar

        units = max(1, round(note.duration_sec / seconds_per_unit))
        residual += abs(note.duration_sec - units * seconds_per_unit)
        token = f"{_abc_pitch_in_context(note.pitch, key_map=key_map, bar_state=bar_state)}{units}"
        # ABC slurs carry the phrase gesture into MelodyT5 without changing a
        # note or a duration. Our parser already treats slurs as articulation,
        # so the representation remains lossless on round-trip.
        if note_index in phrase_starts:
            token = f"({token}"
        if note_index in phrase_ends:
            token = f"{token})"
        body.append(token)
        units_in_bar += units
        cursor = note.start_sec + note.duration_sec

        # A note that fills or overruns the bar closes it. Overrun is left
        # rather than split with a tie: splitting would change the note count,
        # and the note count is what the Identity Guard measures.
        if units_per_bar > 0 and units_in_bar >= units_per_bar:
            close_bar()

    if body and body[-1] != "|":
        body.append("|")

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


#: How many of *our* units fit in a quarter note, by default.
#:
#: ABC's real default depends on the meter, but every document this parser is
#: given carries an explicit ``L:`` -- :func:`to_abc` writes one, and MelodyT5's
#: decoder prompt carries ours through. This is the fallback for a hand-written
#: document with no ``L:`` at all, and it matches what :func:`to_abc` emits.
_DEFAULT_UNITS_PER_QUARTER = float(UNITS_PER_QUARTER)

#: Tuplet defaults from the ABC 2.1 standard: ``(p`` means *p* notes in the time
#: of *q*. ``None`` means "depends on the meter" -- 3 in a compound meter, 2
#: otherwise.
_TUPLET_DEFAULT_Q: dict[int, int | None] = {
    2: 3, 3: 2, 4: 3, 5: None, 6: 2, 7: None, 8: 3, 9: None,
}

#: Legacy single-letter decorations. They carry no pitch and no duration, so
#: skipping them is not a loss -- but *raising* on them would reject an entire
#: MelodyT5 candidate over an ornament mark.
_DECORATION_LETTERS = set("HIJKLMNOPQRSTUVWY") | set("hijklmnopqrstuvwy")


@dataclass(frozen=True)
class _AbcContext:
    """What the header fields say about how to read the body."""

    units_per_quarter: float
    key_accidentals: dict[str, int]
    compound_meter: bool


def _read_header(lines: list[str]) -> _AbcContext:
    units_per_quarter = _DEFAULT_UNITS_PER_QUARTER
    key_field = ""
    numerator, denominator = 4, 4

    for line in lines:
        if len(line) < 2 or not line[0].isalpha() or line[1] != ":":
            continue
        field, _, value = line.partition(":")
        value = value.split("%")[0].strip()
        if field == "L":
            top, _, bottom = value.partition("/")
            try:
                top_value = int(top or 1)
                bottom_value = int(bottom or 1)
            except ValueError:
                continue
            if top_value > 0 and bottom_value > 0:
                # A unit is top/bottom of a whole note; a quarter is 1/4 of one.
                units_per_quarter = bottom_value / (4.0 * top_value)
        elif field == "M":
            if value.lower() in ("c", "c|"):
                numerator, denominator = 4, 4
            else:
                top, _, bottom = value.partition("/")
                try:
                    numerator, denominator = int(top), int(bottom)
                except ValueError:
                    pass
        elif field == "K" and not key_field:
            # The first K: is the tune's key. Later ones are mid-tune changes and
            # are handled inline.
            key_field = value

    compound = denominator == 8 and numerator in (6, 9, 12)
    return _AbcContext(
        units_per_quarter=units_per_quarter or _DEFAULT_UNITS_PER_QUARTER,
        key_accidentals=key_accidentals(key_field),
        compound_meter=compound,
    )


def from_abc(document: str, *, tempo_bpm: float, start_sec: float = 0.0) -> tuple[Note, ...]:
    """Parse an ABC body back into notes.

    ## What this reads, and why each piece is load-bearing

    MelodyT5 was trained on a folk corpus and writes *idiomatic* ABC, not the
    restricted subset :func:`to_abc` emits. Three things follow, and each was a
    silent wrong answer before it was handled:

    * **The key signature is honoured.** A bare ``f`` in ``K:G`` is F sharp. Read
      as F natural, every leading note in a sharp key comes back a semitone flat
      and the Identity Guard measures a pitch change the model never made.
    * **An accidental holds to the barline.** ``^F4 F4`` is two F sharps. Reading
      the second as natural is the same class of error, inside a single bar.
    * **``L:`` decides what a length digit means.** ``C2`` under ``L:1/8`` is a
      quarter note; under ``L:1/16`` it is an eighth. Assuming our own unit
      halves or doubles every duration in the candidate.

    Chords, grace notes, chord symbols, inline fields and tuplets are read for
    what they contribute to a monophonic line -- documented at each site. Genuine
    unknown tokens still raise: a token silently dropped is a note silently
    deleted.
    """
    raw_lines = document.splitlines()
    context = _read_header(raw_lines)

    # An ABC header field is a *letter* followed by a colon (`L:`, `M:`, `K:`).
    # Testing only for the colon misreads a body line that opens with a repeat
    # mark -- `|: C>DE>F ...` -- as a header and discards the music.
    body_lines = []
    for line in raw_lines:
        if not line.strip():
            continue
        if len(line) > 1 and line[0].isalpha() and line[1] == ":":
            continue
        if line.startswith("%%") or line.startswith("%"):
            continue
        # A trailing `%` comment is not music. Stripping it per line, before the
        # lines are joined, is the only place the line boundary still exists.
        body_lines.append(line.split("%")[0])

    if not any(line.strip() for line in body_lines):
        raise ValueError("ABC document has no body")

    seconds_per_unit = 60.0 / tempo_bpm / context.units_per_quarter
    notes: list[Note] = []
    cursor = start_sec

    body = " ".join(body_lines)
    key_accidental_map = dict(context.key_accidentals)
    # Accidentals written in the current bar, keyed by (letter, octave). ABC
    # scopes an accidental to the bar, and to the octave it was written in.
    bar_accidentals: dict[tuple[str, int], int] = {}
    tuplet_remaining = 0
    tuplet_multiplier = 1.0
    pending_tie = False

    def resolve_pitch(letter: str, octave: int, written: int | None) -> int:
        upper = letter.upper()
        if written is not None:
            bar_accidentals[(upper, octave)] = written
            accidental = written
        elif (upper, octave) in bar_accidentals:
            accidental = bar_accidentals[(upper, octave)]
        else:
            accidental = key_accidental_map.get(upper, 0)
        return (octave + 1) * 12 + _LETTER_SEMITONE[upper] + accidental

    index = 0
    length = len(body)
    while index < length:
        char = body[index]

        # -- things with no pitch and no duration --------------------------
        if char in " \t":
            index += 1
            continue
        if char == "|":
            # A barline ends the scope of every written accidental.
            bar_accidentals.clear()
            index += 1
            continue
        if char in ":]<>~.*+`$)":
            index += 1
            continue
        if char == "-":
            # A tie: the next note of the same pitch continues this one rather
            # than starting a new one. Left unhandled, one tied note became two,
            # and the note count is what the Identity Guard measures.
            pending_tie = True
            index += 1
            continue

        if char == '"':
            # A chord symbol or annotation, e.g. "Am". Text, not music.
            close = body.find('"', index + 1)
            index = length if close < 0 else close + 1
            continue
        if char == "{":
            # Grace notes. Ornament, no rhythmic value of their own in ABC, and
            # raising on them would reject the whole candidate over decoration.
            close = body.find("}", index + 1)
            index = length if close < 0 else close + 1
            continue
        if char == "!":
            close = body.find("!", index + 1)
            index = length if close < 0 else close + 1
            continue
        if char in _DECORATION_LETTERS:
            index += 1
            continue
        if char.isdigit():
            # A bare digit here belongs to nothing -- a length always follows a
            # pitch, and a tuplet count always follows `(`.
            index += 1
            continue

        if char == "(":
            index += 1
            digits = ""
            while index < length and body[index].isdigit():
                digits += body[index]
                index += 1
            if not digits:
                # A slur. Phrasing, not rhythm.
                continue
            p = int(digits)
            q = _TUPLET_DEFAULT_Q.get(p)
            if q is None:
                q = 3 if context.compound_meter else 2
            r = p
            # Full `(p:q:r` form.
            if index < length and body[index] == ":":
                index += 1
                second = ""
                while index < length and body[index].isdigit():
                    second += body[index]
                    index += 1
                if second:
                    q = int(second)
                if index < length and body[index] == ":":
                    index += 1
                    third = ""
                    while index < length and body[index].isdigit():
                        third += body[index]
                        index += 1
                    if third:
                        r = int(third)
            if p > 0 and q > 0 and r > 0:
                tuplet_remaining = r
                tuplet_multiplier = q / p
            continue

        if char == "[":
            # Either an inline field (`[K:G]`) or a chord (`[CEG]`).
            if index + 2 < length and body[index + 1].isalpha() and body[index + 2] == ":":
                close = body.find("]", index + 1)
                inline = body[index + 1 : close if close >= 0 else length]
                field, _, value = inline.partition(":")
                if field == "K":
                    # A mid-tune key change. Honoured, because MelodyT5 writes
                    # them and ignoring one puts every later accidental wrong.
                    key_accidental_map = key_accidentals(value.strip())
                    bar_accidentals.clear()
                index = length if close < 0 else close + 1
                continue

            close = body.find("]", index + 1)
            if close < 0:
                index += 1
                continue
            chord_body = body[index + 1 : close]
            index = close + 1
            # A duration written after the bracket applies to the whole chord.
            outer_units, index = _read_length(body, index)
            inner = _chord_notes(chord_body, resolve_pitch)
            if not inner:
                continue
            # Monophonic pipeline: the melody is the top voice. Reading a chord
            # as three sequential notes -- which is what stripping the brackets
            # did -- invents rhythm the model never wrote and inflates the note
            # count the guard measures.
            top_pitch, inner_units = max(inner, key=lambda item: item[0])
            units = outer_units if outer_units is not None else inner_units
            span, tuplet_remaining = _apply_tuplet(
                units * seconds_per_unit, tuplet_remaining, tuplet_multiplier
            )
            cursor, pending_tie = _emit(notes, top_pitch, cursor, span, pending_tie)
            continue

        # -- a pitch, a rest, or something unknown --------------------------
        written: int | None = None
        while index < length and body[index] in "^_=":
            if written is None:
                written = 0
            written += 1 if body[index] == "^" else (-1 if body[index] == "_" else 0)
            index += 1
        if index >= length:
            break

        letter = body[index]
        index += 1

        if letter in "zZxX":
            octave = None
        elif letter.upper() in "ABCDEFG":
            octave = 5 if letter.islower() else 4
        else:
            # Not a pitch, not a symbol this parser knows. Raising rather than
            # skipping: a token silently dropped is a note silently deleted.
            raise ValueError(f"unparseable ABC character {letter!r}")

        while index < length and body[index] in ",'":
            if octave is not None:
                octave += 1 if body[index] == "'" else -1
            index += 1

        units, index = _read_length(body, index)
        if units is None:
            units = 1.0
        span, tuplet_remaining = _apply_tuplet(
            units * seconds_per_unit, tuplet_remaining, tuplet_multiplier
        )

        if octave is None:
            cursor += span
            # A rest breaks a tie: there is nothing for it to continue into.
            pending_tie = False
            continue

        pitch = resolve_pitch(letter, octave, written)
        if not 0 <= pitch <= 127:
            raise ValueError(f"ABC note {letter!r} is outside MIDI range (got {pitch})")

        cursor, pending_tie = _emit(notes, pitch, cursor, span, pending_tie)

    if not notes:
        raise ValueError("ABC document contained no notes")
    return tuple(notes)


def _read_length(body: str, index: int) -> tuple[float | None, int]:
    """Read an ABC length suffix, in units. ``None`` when none was written."""
    length = len(body)
    digits = ""
    while index < length and body[index].isdigit():
        digits += body[index]
        index += 1

    divisor = 1
    saw_slash = False
    while index < length and body[index] == "/":
        saw_slash = True
        divisor *= 2
        index += 1
        extra = ""
        while index < length and body[index].isdigit():
            extra += body[index]
            index += 1
        if extra:
            divisor = int(extra)
            break

    if not digits and not saw_slash:
        return None, index
    numerator = int(digits) if digits else 1
    return max(1, numerator) / max(1, divisor), index


def _apply_tuplet(span: float, remaining: int, multiplier: float) -> tuple[float, int]:
    if remaining <= 0:
        return span, 0
    return span * multiplier, remaining - 1


def _emit(
    notes: list[Note], pitch: int, cursor: float, span: float, pending_tie: bool
) -> tuple[float, bool]:
    """Append a note, or extend the previous one when a tie is pending."""
    if pending_tie and notes and notes[-1].pitch == pitch:
        previous = notes[-1]
        notes[-1] = Note(
            pitch=previous.pitch,
            start_sec=previous.start_sec,
            end_sec=round(previous.end_sec + span, 6),
            velocity=previous.velocity,
        )
        return cursor + span, False

    notes.append(
        Note(
            pitch=pitch,
            start_sec=round(cursor, 6),
            end_sec=round(cursor + span, 6),
            velocity=96,
        )
    )
    return cursor + span, False


def _chord_notes(chord_body: str, resolve) -> list[tuple[int, float]]:
    """Pitches inside a chord bracket, each with the length written on it."""
    found: list[tuple[int, float]] = []
    index = 0
    length = len(chord_body)
    while index < length:
        char = chord_body[index]
        if char in " \t-":
            index += 1
            continue

        written: int | None = None
        while index < length and chord_body[index] in "^_=":
            if written is None:
                written = 0
            written += 1 if chord_body[index] == "^" else (-1 if chord_body[index] == "_" else 0)
            index += 1
        if index >= length:
            break

        letter = chord_body[index]
        index += 1
        if letter.upper() not in "ABCDEFG":
            continue
        octave = 5 if letter.islower() else 4
        while index < length and chord_body[index] in ",'":
            octave += 1 if chord_body[index] == "'" else -1
            index += 1

        units, index = _read_length(chord_body, index)
        pitch = resolve(letter, octave, written)
        if 0 <= pitch <= 127:
            found.append((pitch, units if units is not None else 1.0))
    return found



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
