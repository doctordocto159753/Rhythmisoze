"""A: contract tests.

The contract's job is to refuse things a generative model will eventually
produce. These assert the refusals, because a validator that has never been
shown a bad input is a validator nobody has tested.
"""

from __future__ import annotations

import pytest
from conftest import build_input, build_notes
from musician_shared.contract import Meter, MusicianInput, Note, Phrase, Tempo
from musician_shared.normalize import NormalisationError, from_teacher, require_meter
from pydantic import ValidationError


class TestNote:
    def test_a_note_that_ends_before_it_starts_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            Note(pitch=60, start_sec=1.0, end_sec=0.5)

    def test_a_zero_length_note_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            Note(pitch=60, start_sec=1.0, end_sec=1.0)

    @pytest.mark.parametrize("pitch", [-1, 128, 500])
    def test_pitches_outside_midi_range_are_refused(self, pitch: int) -> None:
        with pytest.raises(ValidationError):
            Note(pitch=pitch, start_sec=0.0, end_sec=0.5)

    def test_a_note_is_immutable(self) -> None:
        # Frozen so that AC-07 is enforced by the type rather than by review.
        note = Note(pitch=60, start_sec=0.0, end_sec=0.5)
        with pytest.raises(ValidationError):
            note.pitch = 61  # type: ignore[misc]


class TestMusicianInput:
    def test_a_monophonic_line_may_not_overlap_itself(self) -> None:
        overlapping = (
            Note(pitch=60, start_sec=0.0, end_sec=1.0),
            Note(pitch=64, start_sec=0.5, end_sec=1.5),
        )
        with pytest.raises(ValidationError, match="overlaps itself"):
            MusicianInput(
                source_id="x",
                notes=overlapping,
                tempo=Tempo(bpm=120, confidence=0.5),
                meter=Meter(numerator=4, denominator=4, confidence=0.5),
                duration_sec=2.0,
            )

    def test_notes_must_be_in_ascending_order(self) -> None:
        out_of_order = (
            Note(pitch=60, start_sec=1.0, end_sec=1.4),
            Note(pitch=64, start_sec=0.0, end_sec=0.4),
        )
        with pytest.raises(ValidationError, match="ascending"):
            MusicianInput(
                source_id="x",
                notes=out_of_order,
                tempo=Tempo(bpm=120, confidence=0.5),
                meter=Meter(numerator=4, denominator=4, confidence=0.5),
                duration_sec=2.0,
            )

    def test_a_note_may_not_run_past_the_stated_duration(self) -> None:
        with pytest.raises(ValidationError, match="past the stated duration"):
            MusicianInput(
                source_id="x",
                notes=build_notes([60, 62]),
                tempo=Tempo(bpm=120, confidence=0.5),
                meter=Meter(numerator=4, denominator=4, confidence=0.5),
                duration_sec=0.1,
            )

    def test_an_empty_melody_is_refused(self) -> None:
        with pytest.raises(ValidationError, match="nothing for the Musician"):
            MusicianInput(
                source_id="x",
                notes=(),
                tempo=Tempo(bpm=120, confidence=0.5),
                meter=Meter(numerator=4, denominator=4, confidence=0.5),
                duration_sec=1.0,
            )

    def test_a_phrase_may_not_point_past_the_last_note(self) -> None:
        with pytest.raises(ValidationError, match="past the last note"):
            MusicianInput(
                source_id="x",
                notes=build_notes([60, 62, 64]),
                tempo=Tempo(bpm=120, confidence=0.5),
                meter=Meter(numerator=4, denominator=4, confidence=0.5),
                phrases=(Phrase(start_index=0, end_index=99),),
                duration_sec=5.0,
            )

    def test_simultaneous_notes_within_tolerance_are_allowed(self) -> None:
        # Float seconds out of an audio pipeline are not exact. A 1e-9 gap is a
        # rounding artefact, and refusing it would reject valid Teacher output.
        touching = (
            Note(pitch=60, start_sec=0.0, end_sec=0.5),
            Note(pitch=64, start_sec=0.49999999, end_sec=1.0),
        )
        assert len(
            MusicianInput(
                source_id="x",
                notes=touching,
                tempo=Tempo(bpm=120, confidence=0.5),
                meter=Meter(numerator=4, denominator=4, confidence=0.5),
                duration_sec=2.0,
            ).notes
        ) == 2


class TestFingerprint:
    def test_the_same_music_fingerprints_the_same(self) -> None:
        assert build_input([60, 62, 64]).fingerprint() == build_input([60, 62, 64]).fingerprint()

    def test_different_music_fingerprints_differently(self) -> None:
        assert build_input([60, 62, 64]).fingerprint() != build_input([60, 62, 65]).fingerprint()

    def test_the_source_id_is_not_part_of_the_fingerprint(self) -> None:
        # So the same performance submitted twice is recognisably the same.
        first = build_input([60, 62, 64])
        second = first.model_copy(update={"source_id": "somewhere-else"})
        assert first.fingerprint() == second.fingerprint()

    def test_phrase_interpretation_is_part_of_the_fingerprint(self) -> None:
        source = build_input([60, 62, 64])
        phrased = source.model_copy(
            update={"phrases": (Phrase(start_index=0, end_index=2),)}
        )
        assert source.fingerprint() != phrased.fingerprint()


class TestMeterIsNeverAssumed:
    def test_an_absent_meter_is_refused_rather_than_defaulted(self) -> None:
        with pytest.raises(NormalisationError, match="will not assume 4/4"):
            require_meter(None)

    def test_a_meter_detected_with_low_confidence_is_refused(self) -> None:
        with pytest.raises(NormalisationError, match="below the floor"):
            require_meter(Meter(numerator=4, denominator=4, confidence=0.1))

    def test_a_confident_meter_passes_through_unchanged(self) -> None:
        meter = Meter(numerator=7, denominator=8, confidence=0.9)
        assert require_meter(meter) is meter


class TestFromTeacher:
    def _payload(self, **overrides) -> dict:
        payload = {
            "sourceId": "teacher-1",
            "notes": [
                {"pitch": 60, "startSec": 0.0, "endSec": 0.45, "velocity": 90},
                {"pitch": 62, "startSec": 0.5, "endSec": 0.95, "velocity": 90},
            ],
            "tempo": {"bpm": 118.0, "confidence": 0.7},
            "meter": {"numerator": 3, "denominator": 4, "confidence": 0.6},
            "key": {"tonic": "D", "mode": "minor", "confidence": 0.55},
            "durationSec": 1.5,
        }
        payload.update(overrides)
        return payload

    def test_a_well_formed_payload_converts(self) -> None:
        result = from_teacher(self._payload())
        assert [n.pitch for n in result.notes] == [60, 62]
        assert result.meter.numerator == 3
        assert result.key is not None
        assert result.key.mode.value == "minor"

    def test_phrase_spans_survive_the_web_payload(self) -> None:
        result = from_teacher(
            self._payload(phrases=[{"startIndex": 0, "endIndex": 1}])
        )
        assert result.phrases == (Phrase(start_index=0, end_index=1),)

    def test_a_malformed_phrase_is_refused_as_bad_input(self) -> None:
        with pytest.raises(NormalisationError, match="phrase span"):
            from_teacher(self._payload(phrases=[{"startIndex": "nope"}]))

    def test_a_payload_with_no_notes_is_refused(self) -> None:
        with pytest.raises(NormalisationError, match="no notes"):
            from_teacher(self._payload(notes=[]))

    def test_a_non_finite_time_is_refused_not_coerced(self) -> None:
        with pytest.raises(NormalisationError, match="not finite|not a number"):
            from_teacher(
                self._payload(notes=[{"pitch": 60, "startSec": float("inf"), "endSec": 1.0}])
            )

    def test_an_unknown_mode_is_refused(self) -> None:
        with pytest.raises(NormalisationError, match="unsupported mode"):
            from_teacher(self._payload(key={"tonic": "D", "mode": "lydian", "confidence": 0.5}))

    def test_snake_case_is_accepted_alongside_camel_case(self) -> None:
        # The web app sends camelCase; a Python caller writing the contract by
        # hand will reach for snake_case. Both are the same payload.
        result = from_teacher(
            {
                "source_id": "s",
                "notes": [{"pitch": 60, "start_sec": 0.0, "end_sec": 0.5}],
                "tempo": {"bpm": 100, "confidence": 0.5},
                "meter": {"numerator": 4, "denominator": 4, "confidence": 0.5},
                "duration_sec": 1.0,
            }
        )
        assert result.notes[0].pitch == 60
