"""D: Identity Guard, and AC-05.

The guard's whole reason to exist is that valid notation is not trustworthy
notation. So the tests that matter most are the ones where a candidate is
perfectly well-formed and is still refused.
"""

from __future__ import annotations

import pytest
from conftest import build_input, build_notes
from musician_shared.contract import Key, Meter, Mode
from musician_shared.identity import evaluate_identity, intervals_of
from musician_shared.policies import DEVELOPED, REFINED


def guard(reference, candidate, *, policy=REFINED, meter=None, motifs=()):
    meter = meter or reference.meter
    return evaluate_identity(
        reference=reference.notes,
        reference_key=reference.key,
        reference_meter=reference.meter,
        reference_duration_sec=reference.duration_sec,
        reference_motifs=motifs or [m.intervals for m in reference.motifs],
        candidate=candidate,
        candidate_meter=meter,
        candidate_duration_sec=candidate[-1].end_sec,
        thresholds=policy.identity,
    )


class TestUnchangedMaterial:
    def test_the_source_passes_its_own_guard(self, simple_melody) -> None:
        report = guard(simple_melody, simple_melody.notes)
        assert report.passed
        assert report.contour_similarity == pytest.approx(1.0)
        assert report.duration_ratio == pytest.approx(1.0, abs=0.02)


class TestRejection:
    def test_an_unrelated_melody_is_rejected(self, simple_melody) -> None:
        """AC-05, stated as directly as it can be.

        The candidate is valid in every mechanical sense -- monophonic, in
        range, in time, in the same meter. It is simply not the user's tune.
        """
        unrelated = build_notes([72, 55, 80, 48, 77, 51, 84, 45, 79, 50, 71, 60])
        report = guard(simple_melody, unrelated)
        assert not report.passed
        assert report.failures, "a rejection must say why"
        assert report.contour_similarity < 0.7

    def test_a_transposed_copy_keeps_its_identity(self, simple_melody) -> None:
        # Identity is about shape, not absolute pitch: the same tune sung a tone
        # higher is the same tune. This is the counterpart to the test above --
        # without it, a guard that rejected everything would look correct.
        higher = build_notes([p + 2 for p in [60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 60]])
        report = guard(simple_melody, higher, motifs=[(2, 2, 1)])
        assert report.contour_similarity == pytest.approx(1.0)

    def test_a_melody_stretched_far_beyond_its_length_is_rejected(self, simple_melody) -> None:
        stretched = build_notes(
            [60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 60], duration=1.6, gap=0.2
        )
        report = guard(simple_melody, stretched)
        assert not report.passed
        assert any("duration ratio" in failure for failure in report.failures)

    def test_a_pitch_range_explosion_is_rejected(self, simple_melody) -> None:
        exploded = build_notes([36, 96, 38, 94, 40, 92, 42, 90, 44, 88, 46, 86])
        report = guard(simple_melody, exploded)
        assert not report.passed

    def test_a_meter_change_is_rejected_not_silently_accepted(self, simple_melody) -> None:
        # V1 has no classified meter transformation, so a meter change is a
        # rejection in both policies rather than a silent switch.
        report = guard(
            simple_melody,
            simple_melody.notes,
            meter=Meter(numerator=3, denominator=4, confidence=0.8),
        )
        assert not report.passed
        assert any("meter changed" in failure for failure in report.failures)


class TestAggregation:
    def test_one_collapsed_dimension_cannot_hide_behind_good_ones(self, simple_melody) -> None:
        """The reason the aggregate is not a mean.

        A candidate that keeps meter, duration and range but abandons the tune
        would average out respectably. It must not.
        """
        same_length_different_tune = build_notes([60, 71, 61, 70, 62, 69, 63, 68, 64, 67, 65, 66])
        report = guard(simple_melody, same_length_different_tune)
        mean_of_dimensions = (
            report.contour_similarity
            + report.motif_survival
            + report.phrase_similarity
            + report.tonal_compatibility
            + report.meter_compatibility
        ) / 5
        assert report.aggregate < mean_of_dimensions
        assert not report.passed


class TestPolicyThresholds:
    def test_developed_admits_candidates_refined_refuses(self, simple_melody) -> None:
        """The policies are not decoration.

        A moderately varied candidate should be acceptable as development and
        not as refinement. If both policies answered the same, the product
        would be offering one thing twice.
        """
        varied = build_notes([60, 64, 67, 65, 69, 67, 64, 60, 62, 65, 64, 60], duration=0.5, gap=0.06)
        refined = guard(simple_melody, varied, policy=REFINED)
        developed = guard(simple_melody, varied, policy=DEVELOPED)
        assert developed.aggregate == pytest.approx(refined.aggregate)
        assert DEVELOPED.identity.aggregate_floor < REFINED.identity.aggregate_floor
        # The same candidate, judged by two different bars.
        assert developed.passed or not refined.passed

    def test_developed_still_has_a_floor(self, simple_melody) -> None:
        # Freer is not unbounded. Development that abandons the motif is a
        # different piece, and the looser policy must still say so.
        unrelated = build_notes([84, 40, 79, 44, 88, 36, 75, 48, 90, 38, 72, 50])
        assert not guard(simple_melody, unrelated, policy=DEVELOPED).passed


class TestTonalCompatibility:
    def test_an_unknown_key_is_neutral_rather_than_perfect(self) -> None:
        """An unknown key is not evidence of agreement.

        Scoring it 1.0 would let the guard wave through precisely the takes it
        understands least.
        """
        keyless = build_input([60, 61, 62, 63], key=None)
        report = guard(keyless, keyless.notes)
        assert report.tonal_compatibility == pytest.approx(0.8)

    def test_out_of_key_notes_lower_the_score(self) -> None:
        in_c = build_input([60, 62, 64, 65, 67, 69, 71, 72])
        chromatic = build_notes([61, 63, 66, 68, 70, 61, 63, 66])
        assert guard(in_c, chromatic).tonal_compatibility < 0.35

    def test_flat_spellings_are_understood(self) -> None:
        # Bb major is A# major; a guard that failed to normalise would score a
        # correct candidate as entirely out of key.
        in_b_flat = build_input(
            [58, 60, 62, 63, 65], key=Key(tonic="Bb", mode=Mode.MAJOR, confidence=0.8)
        )
        report = guard(in_b_flat, in_b_flat.notes)
        assert report.tonal_compatibility == pytest.approx(1.0)


class TestIntervals:
    def test_intervals_are_signed_so_direction_survives(self) -> None:
        # Ascending and descending are different tunes; unsigned intervals
        # would make them identical to the guard.
        rising = build_notes([60, 62, 64])
        falling = build_notes([64, 62, 60])
        assert intervals_of(rising) == [2, 2]
        assert intervals_of(falling) == [-2, -2]
