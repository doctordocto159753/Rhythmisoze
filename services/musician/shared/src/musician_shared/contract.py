"""The canonical symbolic contract.

Every internal stage speaks this, and only this. MIDI files are an import and
export format, never a transport between stages: passing MIDI around means every
stage re-derives tempo, meter and note grouping from a byte format that does not
carry the things we actually decided, and the re-derivations drift apart.

The validation here is deliberately strict. A generative model will happily
return notation that parses and is nonsense -- notes that end before they start,
pitches outside MIDI range, a monophonic line that overlaps itself. Catching
that at the boundary is the difference between a rejected candidate and a
corrupt result that reaches a user.
"""

from __future__ import annotations

import hashlib
import json
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = 1

MIN_MIDI_PITCH = 0
MAX_MIDI_PITCH = 127

#: Two notes closer than this are treated as simultaneous rather than
#: overlapping. Float seconds coming out of an audio pipeline are not exact, and
#: a 1e-9 gap is a rounding artefact, not polyphony.
OVERLAP_TOLERANCE_SEC = 1e-4

#: A note shorter than this is not something a person performed.
MIN_NOTE_DURATION_SEC = 1e-3


class Mode(str, Enum):
    MAJOR = "major"
    MINOR = "minor"


class Note(BaseModel):
    """One note. Monophonic: it does not overlap its neighbours."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    pitch: Annotated[int, Field(ge=MIN_MIDI_PITCH, le=MAX_MIDI_PITCH)]
    start_sec: Annotated[float, Field(ge=0.0)]
    end_sec: Annotated[float, Field(gt=0.0)]
    velocity: Annotated[int, Field(ge=1, le=127)] = 96

    @model_validator(mode="after")
    def _positive_duration(self) -> Note:
        if self.end_sec - self.start_sec < MIN_NOTE_DURATION_SEC:
            raise ValueError(
                f"note at {self.start_sec:.4f}s has non-positive duration "
                f"({self.start_sec:.4f} -> {self.end_sec:.4f})"
            )
        return self

    @property
    def duration_sec(self) -> float:
        return self.end_sec - self.start_sec


class Tempo(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    bpm: Annotated[float, Field(gt=10.0, lt=400.0)]
    confidence: Annotated[float, Field(ge=0.0, le=1.0)]


class Meter(BaseModel):
    """Time signature.

    ``confidence`` is not decoration. A low value means downstream code must not
    assume barlines, and in particular must not silently substitute 4/4 -- see
    :func:`musician_shared.normalize.require_meter`.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    numerator: Annotated[int, Field(ge=1, le=32)]
    denominator: Literal[1, 2, 4, 8, 16, 32]
    confidence: Annotated[float, Field(ge=0.0, le=1.0)]

    @property
    def beats_per_bar(self) -> float:
        return self.numerator * (4.0 / self.denominator)


class Key(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tonic: Annotated[str, Field(min_length=1, max_length=3)]
    mode: Mode
    confidence: Annotated[float, Field(ge=0.0, le=1.0)]


class Phrase(BaseModel):
    """A span of notes, by index, that the Teacher identified as a phrase."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    start_index: Annotated[int, Field(ge=0)]
    end_index: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def _ordered(self) -> Phrase:
        if self.end_index < self.start_index:
            raise ValueError("phrase ends before it starts")
        return self


class Motif(BaseModel):
    """A repeated interval figure, and where it occurs.

    Identified by intervals rather than pitches, so a transposed restatement is
    the same motif. That is also why the Teacher never aligns motif *pitches*.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    intervals: tuple[int, ...]
    occurrences: tuple[int, ...]


class MusicianInput(BaseModel):
    """Teacher material, ready for the Musician.

    Frozen, and never mutated in place. AC-07 is not a code review item -- it is
    enforced by the type.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1] = CONTRACT_VERSION
    source_id: Annotated[str, Field(min_length=1, max_length=128)]
    notes: tuple[Note, ...]
    tempo: Tempo
    meter: Meter
    duration_sec: Annotated[float, Field(gt=0.0)]
    key: Key | None = None
    phrases: tuple[Phrase, ...] = ()
    motifs: tuple[Motif, ...] = ()

    @model_validator(mode="after")
    def _coherent(self) -> MusicianInput:
        notes = self.notes
        if not notes:
            raise ValueError("no notes: there is nothing for the Musician to work with")

        for previous, current in zip(notes, notes[1:]):
            if current.start_sec < previous.start_sec:
                raise ValueError("notes are not in ascending start order")
            if current.start_sec < previous.end_sec - OVERLAP_TOLERANCE_SEC:
                raise ValueError(
                    f"monophonic line overlaps itself: a note starting at "
                    f"{current.start_sec:.4f}s while the previous runs to "
                    f"{previous.end_sec:.4f}s"
                )

        last_end = notes[-1].end_sec
        if last_end > self.duration_sec + OVERLAP_TOLERANCE_SEC:
            raise ValueError(
                f"a note ends at {last_end:.4f}s, past the stated duration "
                f"of {self.duration_sec:.4f}s"
            )

        for phrase in self.phrases:
            if phrase.end_index >= len(notes):
                raise ValueError(
                    f"phrase ends at index {phrase.end_index}, past the last note "
                    f"({len(notes) - 1})"
                )

        for motif in self.motifs:
            for occurrence in motif.occurrences:
                if occurrence < 0 or occurrence + len(motif.intervals) >= len(notes) + 1:
                    raise ValueError(f"motif occurrence at {occurrence} runs past the melody")

        return self

    def fingerprint(self) -> str:
        """Stable digest of the musical content, for provenance and cache keys.

        Deliberately excludes ``source_id`` so that the same performance
        submitted twice produces the same fingerprint.
        """
        payload = json.dumps(
            {
                "notes": [[n.pitch, round(n.start_sec, 6), round(n.end_sec, 6)] for n in self.notes],
                "tempo": round(self.tempo.bpm, 4),
                "meter": [self.meter.numerator, self.meter.denominator],
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


class VariantKind(str, Enum):
    REFINED = "refined"
    DEVELOPED = "developed"


class InfillSpan(BaseModel):
    """A span RWKV was asked to regenerate. Note indices, half-open."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    start_index: Annotated[int, Field(ge=0)]
    end_index: Annotated[int, Field(ge=0)]
    reason: str


class IdentityReport(BaseModel):
    """Why a candidate was kept or rejected.

    This is a guardrail, not a quality score, and the field names say so. It
    never reaches a user as a measure of how good the music is.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    contour_similarity: float
    motif_survival: float
    phrase_similarity: float
    tonal_compatibility: float
    meter_compatibility: float
    duration_ratio: float
    pitch_range_change: float
    note_density_change: float
    aggregate: float
    passed: bool
    failures: tuple[str, ...] = ()


class Variant(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kind: VariantKind
    notes: tuple[Note, ...]
    tempo: Tempo
    meter: Meter
    key: Key | None
    duration_sec: float
    identity: IdentityReport
    infill_spans: tuple[InfillSpan, ...] = ()


class Provenance(BaseModel):
    """Everything needed to reproduce a generation (AC-08)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    melody_t5_revision: str
    midi_rwkv_revision: str
    musician_service_version: str
    input_fingerprint: str
    seeds: dict[str, int]
    parameters: dict[str, dict[str, float | int | str]]
    elapsed_ms: int


class CandidateOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    stage: str
    seed: int
    accepted: bool
    identity_aggregate: float
    rejection_reasons: tuple[str, ...] = ()


class Diagnostics(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    candidate_counts: dict[str, int]
    rejected_candidates: tuple[CandidateOutcome, ...]
    identity_guard_summary: dict[str, float]


class MusicianOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: Literal[1] = CONTRACT_VERSION
    source_id: str
    refined: Variant
    developed: Variant
    provenance: Provenance
    diagnostics: Diagnostics
