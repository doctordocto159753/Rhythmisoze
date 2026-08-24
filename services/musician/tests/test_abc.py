"""B: ABC / symbolic round-trip.

Conversion is the quietest place a bug can live. If a sharp is re-spelled or an
octave mark is dropped on the way out and again on the way back, the Identity
Guard sees a pitch change the model never made -- and either rejects a good
candidate or, worse, accepts a bad one because the reference moved too.

So the round trip is asserted note for note, over the cases that actually break:
octave extremes, accidentals, rests, and unusual meters.
"""

from __future__ import annotations

import pytest
from conftest import build_notes
from musician_shared.abc import from_abc, to_abc, validate_with_music21
from musician_shared.contract import Key, Meter, Mode, Phrase

FOUR_FOUR = Meter(numerator=4, denominator=4, confidence=0.8)


def roundtrip(pitches: list[int], *, meter: Meter = FOUR_FOUR, bpm: float = 120.0, **kwargs):
    notes = build_notes(pitches, **kwargs)
    document = to_abc(notes, meter=meter, tempo_bpm=bpm)
    return notes, document, from_abc(document.text, tempo_bpm=bpm)


class TestRoundTrip:
    def test_a_plain_diatonic_line_survives(self) -> None:
        notes, _, back = roundtrip([60, 62, 64, 65, 67], gap=0.0)
        assert [n.pitch for n in back] == [n.pitch for n in notes]

    def test_accidentals_survive(self) -> None:
        notes, _, back = roundtrip([61, 63, 66, 68, 70], gap=0.0)
        assert [n.pitch for n in back] == [n.pitch for n in notes]

    def test_octave_extremes_survive(self) -> None:
        # The octave marks (, and ') are where a naive converter loses notes.
        notes, _, back = roundtrip([24, 36, 48, 60, 72, 84, 96], gap=0.0)
        assert [n.pitch for n in back] == [n.pitch for n in notes]

    def test_on_grid_timing_survives_exactly(self) -> None:
        # 0.5 s is a quaver at 120 bpm, so it lands on the 16th-note unit and
        # nothing is lost. Off-grid timing is transported fractionally below.
        notes, _, back = roundtrip([60, 62, 64, 65], duration=0.5, gap=0.0)
        for original, restored in zip(notes, back):
            assert restored.start_sec == pytest.approx(original.start_sec, abs=1e-6)
            assert restored.end_sec == pytest.approx(original.end_sec, abs=1e-6)

    def test_off_grid_timing_is_not_snapped_to_the_unit(self) -> None:
        """Expressive timing stays in seconds instead of becoming a beat grid."""
        notes, document, back = roundtrip(
            [60, 62, 64, 65], duration=0.37, gap=0.013
        )
        assert [n.pitch for n in back] == [n.pitch for n in notes]
        for original, restored in zip(notes, back):
            assert restored.start_sec == pytest.approx(original.start_sec, abs=2e-6)
            assert restored.end_sec == pytest.approx(original.end_sec, abs=2e-6)
        # Standard ABC fractional lengths carry the non-grid values while the
        # familiar L:1/16 header stays model-compatible.
        assert "/" in document.text.splitlines()[-1]
        assert document.quantisation_residual_sec < 1e-5

    def test_rests_survive(self) -> None:
        # Dropping rests would hand MelodyT5 a melody with no breathing, and it
        # would return one.
        notes = list(build_notes([60, 62], duration=0.5, gap=0.0))
        later = build_notes([64, 65], duration=0.5, gap=0.0, start=3.0)
        notes.extend(later)
        document = to_abc(tuple(notes), meter=FOUR_FOUR, tempo_bpm=120.0)
        assert "z" in document.text
        back = from_abc(document.text, tempo_bpm=120.0)
        assert [n.pitch for n in back] == [60, 62, 64, 65]
        assert back[2].start_sec == pytest.approx(3.0, abs=1e-6)

    def test_phrase_slurs_reach_notation_without_changing_notes(self) -> None:
        notes = build_notes([60, 62, 64, 65], duration=0.5, gap=0.0)
        document = to_abc(
            notes,
            meter=FOUR_FOUR,
            tempo_bpm=120.0,
            phrases=(Phrase(start_index=0, end_index=1), Phrase(start_index=2, end_index=3)),
        )
        assert document.text.count("(") == 2
        assert document.text.count(")") == 2
        restored = from_abc(document.text, tempo_bpm=120.0)
        assert [note.pitch for note in restored] == [60, 62, 64, 65]
        assert [(note.start_sec, note.end_sec) for note in restored] == [
            (note.start_sec, note.end_sec) for note in notes
        ]

    @pytest.mark.parametrize(
        "numerator,denominator", [(3, 4), (6, 8), (5, 4), (7, 8), (2, 2), (12, 8)]
    )
    def test_unusual_meters_are_carried_not_normalised(self, numerator, denominator) -> None:
        # The meter must reach the model as detected. Silently rewriting 7/8 as
        # 4/4 is the exact failure the "never assume 4/4" rule exists to stop.
        meter = Meter(numerator=numerator, denominator=denominator, confidence=0.8)
        _, document, _ = roundtrip([60, 62, 64], meter=meter, gap=0.0)
        assert f"M:{numerator}/{denominator}" in document.text


class TestTimingTransport:
    def test_a_clean_grid_loses_nothing(self) -> None:
        _, document, _ = roundtrip([60, 62, 64, 65], duration=0.5, gap=0.0)
        assert document.quantisation_residual_sec == pytest.approx(0.0, abs=1e-9)

    def test_off_grid_transport_residual_is_bounded_and_microscopic(self) -> None:
        # The exact rational may have zero residual; when approximation is
        # needed, this entire phrase still loses only microseconds.
        _, document, _ = roundtrip([60, 62, 64], duration=0.37, gap=0.013)
        assert document.quantisation_residual_sec >= 0.0
        assert document.quantisation_residual_sec < 1e-5

    @pytest.mark.parametrize("bpm", [40.0, 60.0, 88.5, 120.0, 160.0, 200.0])
    def test_bpm_describes_off_grid_timing_without_moving_it(self, bpm: float) -> None:
        notes = build_notes([60, 62, 64, 65], duration=0.37, gap=0.013, start=0.1)
        document = to_abc(notes, meter=FOUR_FOUR, tempo_bpm=bpm)
        restored = from_abc(document.text, tempo_bpm=bpm, start_sec=notes[0].start_sec)

        for original, back in zip(notes, restored):
            assert back.start_sec == pytest.approx(original.start_sec, abs=2e-6)
            assert back.end_sec == pytest.approx(original.end_sec, abs=2e-6)

    def test_a_gap_smaller_than_half_a_sixteenth_is_not_deleted(self) -> None:
        # At 120 BPM a sixteenth is 125 ms. The old serializer silently removed
        # this 20 ms articulation because it was below the 62.5 ms half-unit.
        notes = build_notes([60, 62], duration=0.37, gap=0.02)
        document = to_abc(notes, meter=FOUR_FOUR, tempo_bpm=120.0)
        restored = from_abc(document.text, tempo_bpm=120.0)
        restored_gap = restored[1].start_sec - restored[0].end_sec
        assert restored_gap == pytest.approx(0.02, abs=2e-6)


class TestAssumptions:
    def test_a_missing_key_is_recorded_as_an_assumption(self) -> None:
        notes = build_notes([60, 62, 64])
        document = to_abc(notes, meter=FOUR_FOUR, tempo_bpm=120.0, key=None)
        assert document.assumptions
        assert any("key not detected" in assumption for assumption in document.assumptions)

    def test_a_known_key_produces_no_assumption(self) -> None:
        notes = build_notes([60, 62, 64])
        document = to_abc(
            notes,
            meter=FOUR_FOUR,
            tempo_bpm=120.0,
            key=Key(tonic="D", mode=Mode.MINOR, confidence=0.9),
        )
        assert document.assumptions == ()
        assert "K:Dm" in document.text


class TestRefusals:
    def test_an_empty_melody_cannot_be_rendered(self) -> None:
        with pytest.raises(ValueError, match="empty melody"):
            to_abc((), meter=FOUR_FOUR, tempo_bpm=120.0)

    def test_a_document_with_no_notes_is_refused(self) -> None:
        with pytest.raises(ValueError, match="no notes|no body"):
            from_abc("X:1\nM:4/4\nK:C\n", tempo_bpm=120.0)

    def test_an_unparseable_token_raises_rather_than_being_skipped(self) -> None:
        # A token silently dropped is a note silently deleted.
        with pytest.raises(ValueError):
            from_abc("X:1\nK:C\nC4 @@@ D4", tempo_bpm=120.0)

    def test_a_pitch_outside_midi_range_is_refused(self) -> None:
        with pytest.raises(ValueError, match="outside MIDI range"):
            from_abc("X:1\nK:C\nC,,,,,,4", tempo_bpm=120.0)


class TestMusic21Validation:
    def test_generated_notation_is_coherent(self) -> None:
        _, document, _ = roundtrip([60, 62, 64, 65, 67], gap=0.0)
        ok, error = validate_with_music21(document.text)
        assert ok, error

    def test_validation_returns_a_verdict_never_a_rewrite(self) -> None:
        # music21 is used here to check, not to normalise. The function's only
        # outputs are a boolean and a message.
        _, document, _ = roundtrip([60, 62, 64], gap=0.0)
        result = validate_with_music21(document.text)
        assert isinstance(result, tuple) and len(result) == 2
        assert isinstance(result[0], bool)
