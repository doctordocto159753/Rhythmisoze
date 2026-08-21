"""Teacher material into the canonical contract.

The Teacher speaks the web app's TypeScript shapes: seconds, floats, camelCase.
This is the one place that translation happens, and it is also the one place
that gets to refuse.

## Why this refuses rather than repairs

It would be easy to make this forgiving -- clamp a pitch, drop a negative
duration, nudge an overlap apart. Every one of those is a silent decision about
someone's music, made by a function whose name says "normalise", and recorded
nowhere. When the result is wrong the trail leads back to a helper that appeared
to be doing nothing.

So malformed input raises. The caller can decide what to tell the user; this
module does not decide it for them.

## The 4/4 rule

If meter is unknown, we do not invent 4/4 because it is convenient. An assumed
meter propagates into measure construction, into the ABC that MelodyT5 sees, and
into the Identity Guard's meter check -- and the guard would then be comparing
the candidate against an assumption rather than against the performance.
"""

from __future__ import annotations

from typing import Any

from .contract import (
    Key,
    Meter,
    Mode,
    Motif,
    MusicianInput,
    Note,
    Phrase,
    Tempo,
)


class NormalisationError(ValueError):
    """Teacher material that cannot be represented in the contract."""


#: Below this we do not claim to know the meter.
METER_CONFIDENCE_FLOOR = 0.35


def require_meter(meter: Meter | None) -> Meter:
    """Return a meter, or explain why there is not one.

    Deliberately has no default. See the module docstring.
    """
    if meter is None:
        raise NormalisationError(
            "no meter was detected. The Musician will not assume 4/4: an assumed "
            "meter reaches the model as though it were measured, and the Identity "
            "Guard would then check the candidate against a guess."
        )
    if meter.confidence < METER_CONFIDENCE_FLOOR:
        raise NormalisationError(
            f"meter {meter.numerator}/{meter.denominator} was detected with "
            f"confidence {meter.confidence:.2f}, below the floor of "
            f"{METER_CONFIDENCE_FLOOR:.2f}"
        )
    return meter


def _as_float(value: Any, field: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise NormalisationError(f"{field} is not a number: {value!r}") from error
    if result != result or result in (float("inf"), float("-inf")):
        raise NormalisationError(f"{field} is not finite: {value!r}")
    return result


def _note_from(raw: dict[str, Any], index: int) -> Note:
    try:
        return Note(
            pitch=int(raw["pitch"]),
            start_sec=_as_float(raw.get("startSec", raw.get("start_sec")), f"note[{index}].startSec"),
            end_sec=_as_float(raw.get("endSec", raw.get("end_sec")), f"note[{index}].endSec"),
            velocity=int(raw.get("velocity", 96)),
        )
    except KeyError as error:
        raise NormalisationError(f"note[{index}] is missing {error}") from error
    except (TypeError, ValueError) as error:
        raise NormalisationError(f"note[{index}] is not usable: {error}") from error


def from_teacher(payload: dict[str, Any]) -> MusicianInput:
    """Build a validated :class:`MusicianInput` from a Teacher payload."""
    raw_notes = payload.get("notes")
    if not isinstance(raw_notes, list) or not raw_notes:
        raise NormalisationError("Teacher payload carries no notes")

    notes = tuple(_note_from(raw, index) for index, raw in enumerate(raw_notes))

    raw_tempo = payload.get("tempo") or {}
    tempo = Tempo(
        bpm=_as_float(raw_tempo.get("bpm"), "tempo.bpm"),
        confidence=_as_float(raw_tempo.get("confidence", 0.0), "tempo.confidence"),
    )

    raw_meter = payload.get("meter")
    meter = require_meter(
        Meter(
            numerator=int(raw_meter["numerator"]),
            denominator=int(raw_meter["denominator"]),
            confidence=_as_float(raw_meter.get("confidence", 0.0), "meter.confidence"),
        )
        if isinstance(raw_meter, dict)
        else None
    )

    key: Key | None = None
    raw_key = payload.get("key")
    if isinstance(raw_key, dict) and raw_key.get("tonic"):
        mode_value = str(raw_key.get("mode", "major")).lower()
        if mode_value not in {m.value for m in Mode}:
            raise NormalisationError(f"unsupported mode {mode_value!r}")
        key = Key(
            tonic=str(raw_key["tonic"]),
            mode=Mode(mode_value),
            confidence=_as_float(raw_key.get("confidence", 0.0), "key.confidence"),
        )

    phrases = tuple(
        Phrase(
            start_index=int(p.get("startIndex", p.get("start_index"))),
            end_index=int(p.get("endIndex", p.get("end_index"))),
        )
        for p in payload.get("phrases", [])
        if isinstance(p, dict)
    )

    motifs = tuple(
        Motif(
            intervals=tuple(int(i) for i in m.get("intervals", [])),
            occurrences=tuple(int(o) for o in m.get("occurrences", [])),
        )
        for m in payload.get("motifs", [])
        if isinstance(m, dict)
    )

    duration = payload.get("durationSec", payload.get("duration_sec"))
    duration_sec = (
        _as_float(duration, "durationSec") if duration is not None else notes[-1].end_sec
    )

    try:
        return MusicianInput(
            source_id=str(payload.get("sourceId", payload.get("source_id", "unknown"))),
            notes=notes,
            tempo=tempo,
            meter=meter,
            key=key,
            phrases=phrases,
            motifs=motifs,
            duration_sec=duration_sec,
        )
    except ValueError as error:
        raise NormalisationError(str(error)) from error
