"""ABC round-trip regressions found by attacking the parser.

`test_abc.py` covers what :func:`to_abc` emits. These cover what **MelodyT5**
emits, which is not the same language: it was trained on a folk corpus and writes
idiomatic ABC -- key signatures instead of marked accidentals, ornaments, chord
symbols, tuplets, ties.

Every case here was a *silent wrong answer* before the fix, which is the reason
they are worth a file. A parse error is loud and rejects one candidate. A note
read a semitone flat passes every check and is measured by the Identity Guard as a
pitch change the model never made.
"""

from __future__ import annotations

import pytest
from conftest import build_notes
from musician_shared.abc import from_abc, key_accidentals, to_abc
from musician_shared.contract import Key, Meter, Mode

FOUR_FOUR = Meter(numerator=4, denominator=4, confidence=0.8)
SIX_EIGHT = Meter(numerator=6, denominator=8, confidence=0.8)


def pitches(document: str, bpm: float = 120.0) -> list[int]:
    return [note.pitch for note in from_abc(document, tempo_bpm=bpm)]


def durations(document: str, bpm: float = 120.0) -> list[float]:
    return [round(note.duration_sec, 6) for note in from_abc(document, tempo_bpm=bpm)]


class TestKeySignaturesAreHonoured:
    """The worst of the set: every leading note in a sharp key came back flat.

    MelodyT5 writes ``f`` in ``K:G`` and means F sharp -- that is what a key
    signature is for. Read as F natural, the guard sees a semitone the model never
    wrote, and the candidate it rejects (or accepts) is not the one that was
    generated.
    """

    def test_g_major_sharpens_f(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:G\nG4 A4 B4 c4 | d4 e4 f4 g4 |") == [
            67, 69, 71, 72, 74, 76, 78, 79
        ]

    def test_d_minor_flattens_b(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:Dm\nD4 E4 F4 G4 | A4 B4 c4 d4 |") == [
            62, 64, 65, 67, 69, 70, 72, 74
        ]

    def test_a_major_sharpens_three_letters(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:A\nA4 B4 c4 d4 | e4 f4 g4 a4 |") == [
            69, 71, 73, 74, 76, 78, 80, 81
        ]

    def test_e_flat_major_flattens_three(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:Eb\nE4 F4 G4 A4 | B4 c4 d4 e4 |") == [
            63, 65, 67, 68, 70, 72, 74, 75
        ]

    def test_c_major_has_no_accidentals(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:C\nC4 D4 E4 F4 |") == [60, 62, 64, 65]

    def test_an_explicit_natural_overrides_the_signature(self) -> None:
        # `=f` in K:G is F natural. Without this, a modal folk tune's flattened
        # seventh is read as the sharp the signature implies.
        assert pitches("X:1\nM:4/4\nL:1/16\nK:G\nf4 =f4 |") == [78, 77]

    @pytest.mark.parametrize(
        "field,expected",
        [
            ("G", {"F": 1}),
            ("D", {"F": 1, "C": 1}),
            ("F", {"B": -1}),
            ("Bb", {"B": -1, "E": -1}),
            ("Am", {}),
            ("Em", {"F": 1}),
            # D dorian and G mixolydian both share C major's signature. Worth
            # asserting precisely because they look like they should not.
            ("Ddor", {}),
            ("Gmix", {}),
            ("Edor", {"F": 1, "C": 1}),
            ("Dmix", {"F": 1}),
            ("none", {}),
            ("", {}),
        ],
    )
    def test_the_signature_map_matches_the_circle_of_fifths(self, field, expected) -> None:
        assert key_accidentals(field) == expected

    def test_a_mid_tune_key_change_is_followed(self) -> None:
        # MelodyT5 writes these. Ignoring one puts every later accidental wrong.
        assert pitches("X:1\nM:4/4\nL:1/16\nK:C\nF4 | [K:G] F4 |") == [65, 66]


class TestAccidentalsHoldToTheBarline:
    """ABC scopes a written accidental to its bar. The parser scoped it to one note."""

    def test_a_sharp_carries_through_its_bar(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:C\n^F4 F4 F4 F4 |") == [66, 66, 66, 66]

    def test_a_barline_ends_the_scope(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:C\n^F4 F4 | F4 F4 |") == [66, 66, 65, 65]

    def test_the_scope_is_per_octave(self) -> None:
        # A sharp written on middle F does not alter the F an octave up.
        assert pitches("X:1\nM:4/4\nL:1/16\nK:C\n^F4 f4 |") == [66, 77]

    def test_a_natural_within_a_bar_overrides_an_earlier_sharp(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:C\n^F4 =F4 F4 |") == [66, 65, 65]


class TestUnitLengthIsRead:
    """``L:`` decides what a length digit means; the parser assumed its own unit.

    ``C2`` under ``L:1/8`` is a quarter note and under ``L:1/16`` an eighth.
    Assuming one halves or doubles every duration in the candidate, which the
    guard reads as a density and duration change.
    """

    def test_l_one_eighth(self) -> None:
        # One unit = an eighth = 0.25 s at 120 bpm.
        assert durations("X:1\nM:4/4\nL:1/8\nK:C\nC1 D2 E4 |") == [0.25, 0.5, 1.0]

    def test_l_one_sixteenth(self) -> None:
        assert durations("X:1\nM:4/4\nL:1/16\nK:C\nC1 D2 E4 |") == [0.125, 0.25, 0.5]

    def test_l_one_quarter(self) -> None:
        assert durations("X:1\nM:4/4\nL:1/4\nK:C\nC1 D2 |") == [0.5, 1.0]

    def test_a_missing_l_falls_back_to_our_own_unit(self) -> None:
        # Every document this parser is handed carries an L:. This is the
        # fallback, and it matches what to_abc writes.
        assert durations("X:1\nK:C\nC4 |") == [0.5]


class TestIdiomaticNotationIsReadRatherThanRefused:
    """Tokens a folk corpus is full of, which used to reject the whole candidate.

    Raising on a grace note threw away a complete, otherwise-valid MelodyT5
    variation over an ornament mark.
    """

    def test_grace_notes_are_ornament_not_melody(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\nC4 {d}E4 G4 |") == [60, 64, 67]

    def test_a_grace_note_adds_no_time(self) -> None:
        assert durations("X:1\nL:1/16\nK:C\nC4 {d}E4 |") == [0.5, 0.5]

    def test_chord_symbols_are_text(self) -> None:
        assert pitches('X:1\nL:1/16\nK:C\n"Am"C4 "F"E4 |') == [60, 64]

    def test_an_annotation_with_a_barline_inside_it_is_still_text(self) -> None:
        assert pitches('X:1\nL:1/16\nK:C\n"D.C. al |: fine"C4 |') == [60]

    def test_decorations_are_skipped(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\n!trill!C4 .E4 ~G4 |") == [60, 64, 67]

    def test_legacy_letter_decorations_are_skipped(self) -> None:
        # `H` (fermata), `T` (trill), `u`/`v` (bowing) are decorations, not
        # pitches. Reading `T` as a note is not possible, but raising on it
        # rejected the candidate.
        assert pitches("X:1\nL:1/16\nK:C\nTC4 HE4 uG4 |") == [60, 64, 67]

    def test_a_trailing_comment_is_not_music(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\nC4 E4 % a remark\nG4 |") == [60, 64, 67]

    def test_repeats_and_endings_are_structure(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\n|: C4 D4 |1 E4 :|2 F4 |]") == [60, 62, 64, 65]

    def test_slurs_are_phrasing(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\n(C4 D4) E4 |") == [60, 62, 64]

    def test_a_genuinely_unknown_token_still_raises(self) -> None:
        # The counterweight. If everything unknown were skipped, a note silently
        # dropped would be a note silently deleted.
        with pytest.raises(ValueError, match="unparseable"):
            from_abc("X:1\nK:C\nC4 @@@ D4", tempo_bpm=120.0)


class TestChordsAreNotLinearised:
    """A chord became three sequential notes: invented rhythm, inflated count.

    The parser stripped ``[`` and ``]`` with the other structural symbols, so
    ``[CEG]4`` read as C then E then G, each a quarter of the written length. That
    triples the note count the Identity Guard measures and fabricates a run the
    model never wrote.
    """

    def test_a_chord_is_one_note(self) -> None:
        assert pitches("X:1\nM:4/4\nL:1/16\nK:C\n[CEG]4 D4 |") == [67, 62]

    def test_a_chord_keeps_the_written_length(self) -> None:
        assert durations("X:1\nM:4/4\nL:1/16\nK:C\n[CEG]4 D4 |") == [0.5, 0.5]

    def test_a_length_inside_the_bracket_is_honoured(self) -> None:
        assert durations("X:1\nM:4/4\nL:1/16\nK:C\n[C4E4G4] D4 |") == [0.5, 0.5]

    def test_the_top_voice_is_the_melody(self) -> None:
        # A monophonic pipeline has to pick one, and the melody is on top.
        assert pitches("X:1\nL:1/16\nK:C\n[CEc]4 |") == [72]

    def test_an_accidental_inside_a_chord_is_read(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\n[C^EG]4 |") == [67]

    def test_an_inline_field_is_not_mistaken_for_a_chord(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\nC4 [K:G]F4 |") == [60, 66]


class TestTiesJoinRatherThanDuplicate:
    def test_a_tie_makes_one_longer_note(self) -> None:
        assert pitches("X:1\nL:1/16\nK:C\nC4-C4 D4 |") == [60, 62]

    def test_the_tied_note_carries_both_lengths(self) -> None:
        assert durations("X:1\nL:1/16\nK:C\nC4-C4 D4 |") == [1.0, 0.5]

    def test_a_tie_across_a_barline_still_joins(self) -> None:
        assert durations("X:1\nM:4/4\nL:1/16\nK:C\nC4- | C4 |") == [1.0]

    def test_a_tie_between_different_pitches_is_not_applied(self) -> None:
        # Not a tie at all -- ABC would call that a slur. Two notes, unchanged.
        assert pitches("X:1\nL:1/16\nK:C\nC4-D4 |") == [60, 62]


class TestTupletsScaleTime:
    def test_a_triplet_compresses_three_notes_into_two_beats(self) -> None:
        # (3 means three in the time of two.
        assert durations("X:1\nM:4/4\nL:1/8\nK:C\n(3C1D1E1 |") == [
            pytest.approx(0.25 * 2 / 3, abs=1e-6)
        ] * 3

    def test_the_tuplet_ends_after_its_own_notes(self) -> None:
        result = durations("X:1\nM:4/4\nL:1/8\nK:C\n(3C1D1E1 F1 |")
        assert result[3] == pytest.approx(0.25, abs=1e-6)

    def test_a_duplet_stretches(self) -> None:
        # (2 is two in the time of three.
        assert durations("X:1\nM:4/4\nL:1/8\nK:C\n(2C1D1 |") == [
            pytest.approx(0.25 * 3 / 2, abs=1e-6)
        ] * 2

    def test_a_compound_meter_changes_the_meter_dependent_defaults(self) -> None:
        # ABC 2.1: (5, (7 and (9 are "n notes in the time of n", where n is 3 in a
        # compound meter and 2 otherwise. (3 is always three-in-two.
        simple = durations("X:1\nM:4/4\nL:1/8\nK:C\n(5C1D1E1F1G1 |")
        compound = durations("X:1\nM:6/8\nL:1/8\nK:C\n(5C1D1E1F1G1 |")
        assert simple[0] == pytest.approx(0.25 * 2 / 5, abs=1e-6)
        assert compound[0] == pytest.approx(0.25 * 3 / 5, abs=1e-6)

    def test_a_triplet_is_three_in_two_in_every_meter(self) -> None:
        for meter in ("4/4", "6/8", "3/4"):
            result = durations(f"X:1\nM:{meter}\nL:1/8\nK:C\n(3C1D1E1 |")
            assert result[0] == pytest.approx(0.25 * 2 / 3, abs=1e-6), meter

    def test_the_explicit_form_is_read(self) -> None:
        # (p:q:r -- p notes in the time of q, applied to r notes.
        result = durations("X:1\nM:4/4\nL:1/8\nK:C\n(3:2:2C1D1E1 |")
        assert result[0] == pytest.approx(0.25 * 2 / 3, abs=1e-6)
        assert result[2] == pytest.approx(0.25, abs=1e-6)


class TestRoundTripsStayExact:
    """What :func:`to_abc` writes must read back identically.

    Honouring the key signature on the way in changed what a correct *spelling*
    is on the way out: ``F`` under ``K:G`` now means F sharp, so a natural F has
    to be written ``=F``. Without that the writer and the reader disagree, which
    is worse than either bug alone.
    """

    @pytest.mark.parametrize(
        "tonic,mode,melody",
        [
            ("C", Mode.MAJOR, [60, 62, 64, 65, 67]),
            ("G", Mode.MAJOR, [67, 69, 71, 72, 74, 76, 78, 79]),
            ("G", Mode.MAJOR, [67, 69, 71, 72, 74, 76, 77, 79]),  # natural 7th
            ("D", Mode.MINOR, [62, 64, 65, 67, 69, 70, 72, 74]),
            ("A", Mode.MAJOR, [69, 71, 73, 74, 76, 78, 80, 81]),
            ("Eb", Mode.MAJOR, [63, 65, 67, 68, 70, 72, 74, 75]),
            ("F", Mode.MAJOR, [65, 67, 69, 70, 72, 74, 76, 77]),
        ],
    )
    def test_a_scale_survives_its_own_key(self, tonic, mode, melody) -> None:
        notes = build_notes(melody, duration=0.5, gap=0.0)
        document = to_abc(
            notes,
            meter=FOUR_FOUR,
            tempo_bpm=120.0,
            key=Key(tonic=tonic, mode=mode, confidence=0.9),
        )
        assert pitches(document.text) == melody, document.text

    def test_chromatic_material_survives(self) -> None:
        chromatic = list(range(60, 73))
        notes = build_notes(chromatic, duration=0.25, gap=0.0)
        document = to_abc(
            notes,
            meter=FOUR_FOUR,
            tempo_bpm=120.0,
            key=Key(tonic="G", mode=Mode.MAJOR, confidence=0.9),
        )
        assert pitches(document.text) == chromatic, document.text

    def test_octave_extremes_survive_in_a_sharp_key(self) -> None:
        melody = [30, 42, 54, 66, 78, 90, 102]
        notes = build_notes(melody, duration=0.5, gap=0.0)
        document = to_abc(
            notes,
            meter=FOUR_FOUR,
            tempo_bpm=120.0,
            key=Key(tonic="D", mode=Mode.MAJOR, confidence=0.9),
        )
        assert pitches(document.text) == melody, document.text

    def test_rests_and_a_key_signature_together(self) -> None:
        notes = list(build_notes([67, 69], duration=0.5, gap=0.0))
        notes.extend(build_notes([78, 79], duration=0.5, gap=0.0, start=3.0))
        document = to_abc(
            tuple(notes),
            meter=FOUR_FOUR,
            tempo_bpm=120.0,
            key=Key(tonic="G", mode=Mode.MAJOR, confidence=0.9),
        )
        restored = from_abc(document.text, tempo_bpm=120.0)
        assert [n.pitch for n in restored] == [67, 69, 78, 79]
        assert restored[2].start_sec == pytest.approx(3.0, abs=1e-6)

    @pytest.mark.parametrize("numerator,denominator", [(3, 4), (6, 8), (5, 4), (7, 8), (12, 8)])
    def test_unusual_meters_round_trip_in_a_sharp_key(self, numerator, denominator) -> None:
        melody = [67, 69, 71, 78]
        notes = build_notes(melody, duration=0.5, gap=0.0)
        document = to_abc(
            notes,
            meter=Meter(numerator=numerator, denominator=denominator, confidence=0.8),
            tempo_bpm=120.0,
            key=Key(tonic="G", mode=Mode.MAJOR, confidence=0.9),
        )
        assert pitches(document.text) == melody, document.text
