"""E, F, G: ranking, weak-span selection, and orchestration with fake models.

These are the acceptance criteria that are easiest to satisfy dishonestly. A
pipeline that returns its input unchanged passes "Teacher is never mutated" and
"identity is preserved" perfectly, so several tests below exist specifically to
prove the pipeline is *doing something* as well as not doing the wrong thing.
"""

from __future__ import annotations

import pytest
from conftest import build_input, build_notes
from musician_shared.adapters.base import GenerationError, MelodyRequest
from musician_shared.adapters.fake import (
    FakeMelodyAdapter,
    FakeRwkvAdapter,
    RogueMelodyAdapter,
)
from musician_shared.contract import Phrase, VariantKind
from musician_shared.pipeline import CancelledError, generate_variant, run_musician
from musician_shared.policies import DEVELOPED, REFINED
from musician_shared.weak_spans import nominate_weak_spans


class TestOrchestration:
    def test_both_variants_are_produced(self, simple_melody) -> None:
        result = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter()
        )
        assert result.refined.kind is VariantKind.REFINED
        assert result.developed.kind is VariantKind.DEVELOPED
        assert result.refined.notes and result.developed.notes

    def test_phrase_spans_reach_the_melody_adapter(self, simple_melody) -> None:
        class CapturingMelody(FakeMelodyAdapter):
            requests: list[MelodyRequest] = []

            def generate(self, request: MelodyRequest):
                self.requests.append(request)
                return super().generate(request)

        melody = CapturingMelody()
        source = simple_melody.model_copy(
            update={"phrases": (Phrase(start_index=0, end_index=5),)}
        )
        run_musician(source=source, melody=melody, rwkv=FakeRwkvAdapter())
        assert melody.requests
        assert all(request.phrases == source.phrases for request in melody.requests)

    def test_the_teacher_input_is_never_mutated(self, simple_melody) -> None:
        """AC-07.

        Checked by value rather than by identity: the same input object feeds
        both variants and every guard comparison, so a mutation would corrupt
        the reference the guard measures against -- and the guard would report
        improving scores as it did.
        """
        before = [(n.pitch, n.start_sec, n.end_sec, n.velocity) for n in simple_melody.notes]
        run_musician(source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter())
        after = [(n.pitch, n.start_sec, n.end_sec, n.velocity) for n in simple_melody.notes]
        assert before == after

    def test_the_pipeline_actually_changes_something(self, simple_melody) -> None:
        # The counterweight to every "nothing was corrupted" test above.
        result = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter()
        )
        source_pitches = [n.pitch for n in simple_melody.notes]
        assert (
            [n.pitch for n in result.refined.notes] != source_pitches
            or [n.pitch for n in result.developed.notes] != source_pitches
        )

    def test_generation_is_reproducible_from_the_seed(self, simple_melody) -> None:
        """AC-08.

        Two runs with the same seed must be identical. Without this, the
        provenance record cannot reproduce anything and is decoration.
        """
        first = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter(), base_seed=7
        )
        second = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter(), base_seed=7
        )
        assert [n.pitch for n in first.refined.notes] == [n.pitch for n in second.refined.notes]
        assert [n.pitch for n in first.developed.notes] == [
            n.pitch for n in second.developed.notes
        ]

    def test_a_different_seed_gives_a_different_result(self, simple_melody) -> None:
        first = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter(), base_seed=1
        )
        second = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter(), base_seed=999
        )
        assert [n.pitch for n in first.developed.notes] != [
            n.pitch for n in second.developed.notes
        ]

    def test_provenance_records_both_model_revisions(self, simple_melody) -> None:
        result = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter()
        )
        assert result.provenance.melody_t5_revision == "fake-melodyt5-v1"
        assert result.provenance.midi_rwkv_revision == "fake-midi-rwkv-v1"
        assert result.provenance.input_fingerprint == simple_melody.fingerprint()
        assert "refined" in result.provenance.parameters
        assert "developed" in result.provenance.parameters


class TestGuardIsNotDecorative:
    def test_when_every_candidate_is_rejected_the_source_is_returned(self, simple_melody) -> None:
        """The guard must not be overridable by having nothing better.

        Returning the least-bad reject would make the whole guardrail
        decorative -- exactly the failure it exists to prevent.
        """
        result = run_musician(
            source=simple_melody, melody=RogueMelodyAdapter(), rwkv=FakeRwkvAdapter()
        )
        assert result.refined.notes == simple_melody.notes
        assert result.developed.notes == simple_melody.notes
        assert result.diagnostics.rejected_candidates
        assert all(not c.accepted for c in result.diagnostics.rejected_candidates)

    def test_rejections_carry_reasons(self, simple_melody) -> None:
        result = run_musician(
            source=simple_melody, melody=RogueMelodyAdapter(), rwkv=FakeRwkvAdapter()
        )
        assert all(c.rejection_reasons for c in result.diagnostics.rejected_candidates)


class TestFailureHandling:
    def test_a_model_that_errors_does_not_fail_the_whole_run(self, simple_melody) -> None:
        class Exploding(FakeMelodyAdapter):
            def generate(self, request: MelodyRequest):
                raise GenerationError("model produced garbage")

        result = run_musician(source=simple_melody, melody=Exploding(), rwkv=FakeRwkvAdapter())
        # Every candidate failed, so the Teacher material comes back untouched
        # rather than the request failing. The user still gets a result.
        assert result.refined.notes == simple_melody.notes
        assert all(
            "generation failed" in reason
            for c in result.diagnostics.rejected_candidates
            for reason in c.rejection_reasons
        )

    def test_cancellation_stops_the_run(self, simple_melody) -> None:
        with pytest.raises(CancelledError):
            generate_variant(
                source=simple_melody,
                kind=VariantKind.REFINED,
                melody=FakeMelodyAdapter(),
                rwkv=FakeRwkvAdapter(),
                base_seed=1,
                should_cancel=lambda: True,
            )


class TestPolicyDifference:
    def test_refined_and_developed_produce_different_music(self, simple_melody) -> None:
        """AC-04, asserted rather than asserted-about.

        Same input, same seed, same models. If the two variants come back
        identical, the product is offering one thing twice, and no amount of
        configuration structure makes that untrue.
        """
        result = run_musician(
            source=simple_melody, melody=FakeMelodyAdapter(), rwkv=FakeRwkvAdapter(), base_seed=42
        )
        assert [n.pitch for n in result.refined.notes] != [n.pitch for n in result.developed.notes]

    def test_the_policies_differ_in_more_than_a_seed(self) -> None:
        # The structural half of AC-04: the difference is inspectable policy,
        # not two draws from one distribution.
        assert REFINED.melody_sampling.temperature < DEVELOPED.melody_sampling.temperature
        assert REFINED.max_infill_spans < DEVELOPED.max_infill_spans
        assert REFINED.identity.aggregate_floor > DEVELOPED.identity.aggregate_floor
        assert REFINED.identity.max_duration_ratio < DEVELOPED.identity.max_duration_ratio
        assert REFINED.identity.motif_floor > DEVELOPED.identity.motif_floor

    def test_developed_is_freer_in_practice_not_only_on_paper(self, simple_melody) -> None:
        """Configured freedom must show up in the output.

        Averaged over seeds because a single draw can go either way: the claim
        is about the policies' behaviour, not about one lucky sample.
        """
        source_pitches = [n.pitch for n in simple_melody.notes]

        def distance(notes) -> int:
            return sum(1 for a, b in zip(source_pitches, [n.pitch for n in notes]) if a != b)

        refined_total = 0
        developed_total = 0
        for seed in range(12):
            result = run_musician(
                source=simple_melody,
                melody=FakeMelodyAdapter(),
                rwkv=FakeRwkvAdapter(),
                base_seed=seed * 137,
            )
            refined_total += distance(result.refined.notes)
            developed_total += distance(result.developed.notes)

        assert developed_total > refined_total, (
            f"Developed changed {developed_total} notes over 12 seeds and Refined "
            f"changed {refined_total}; the freer policy is not actually freer"
        )


class TestWeakSpans:
    def test_a_clean_melody_nominates_nothing(self, simple_melody) -> None:
        # The negative case matters most: a heuristic that flags everything
        # would let RWKV rewrite every take.
        assert nominate_weak_spans(simple_melody.notes, limit=3) == []

    def test_a_leap_outlier_is_nominated(self, defective_melody) -> None:
        spans = nominate_weak_spans(defective_melody.notes, limit=3)
        assert any("interval outlier" in span.reason for span in spans)

    def test_a_clipped_ending_is_nominated(self, defective_melody) -> None:
        spans = nominate_weak_spans(defective_melody.notes, limit=3)
        assert any("weak closure" in span.reason for span in spans)

    def test_every_nomination_explains_itself(self, defective_melody) -> None:
        # "The model changed bars 3-4" is not reviewable; "bars 3-4: interval
        # outlier, 20 semitones against a median of 2" is.
        for span in nominate_weak_spans(defective_melody.notes, limit=5):
            assert span.reason and ":" in span.reason

    def test_nomination_is_deterministic(self, defective_melody) -> None:
        first = nominate_weak_spans(defective_melody.notes, limit=3)
        second = nominate_weak_spans(defective_melody.notes, limit=3)
        assert [(s.start_index, s.end_index) for s in first] == [
            (s.start_index, s.end_index) for s in second
        ]

    def test_the_limit_is_respected(self, defective_melody) -> None:
        assert len(nominate_weak_spans(defective_melody.notes, limit=1)) <= 1
        assert nominate_weak_spans(defective_melody.notes, limit=0) == []

    def test_spans_do_not_overlap(self, defective_melody) -> None:
        # Two heuristics firing on the same bars is one weak span, not two;
        # infilling it twice means the second pass rewrites the first's work.
        spans = sorted(nominate_weak_spans(defective_melody.notes, limit=5), key=lambda s: s.start_index)
        for earlier, later in zip(spans, spans[1:]):
            assert earlier.end_index <= later.start_index

    def test_a_leap_filled_melody_is_not_all_defect(self) -> None:
        # Relative to the melody's own habits: a line built from leaps is a
        # style, and an absolute threshold would flag the whole piece.
        leapy = build_notes([60, 72, 61, 73, 62, 74, 63, 75, 64, 76, 65, 77])
        spans = nominate_weak_spans(leapy, limit=5)
        assert not any("interval outlier" in span.reason for span in spans)


class TestInfillIsLocal:
    def test_infill_changes_only_its_span(self, defective_melody) -> None:
        """AC-06.

        Compares against the same run with infill switched off, so what is
        measured is the infill's footprint rather than MelodyT5's.
        """
        variant, _ = generate_variant(
            source=defective_melody,
            kind=VariantKind.DEVELOPED,
            melody=FakeMelodyAdapter(),
            rwkv=FakeRwkvAdapter(),
            base_seed=3,
        )
        if not variant.infill_spans:
            pytest.skip("no infill was accepted for this melody and seed")

        # An adapter that hands the span straight back: the pipeline still runs
        # its infill loop, but nothing it produces can differ. That isolates the
        # infill's own footprint from MelodyT5's.
        class Passthrough(FakeRwkvAdapter):
            def infill(self, request):
                from musician_shared.adapters.base import InfillResponse

                return InfillResponse(notes=request.span)

        without_infill, _ = generate_variant(
            source=defective_melody,
            kind=VariantKind.DEVELOPED,
            melody=FakeMelodyAdapter(),
            rwkv=Passthrough(),
            base_seed=3,
        )
        changed = {
            index
            for index, (a, b) in enumerate(zip(without_infill.notes, variant.notes))
            if a.pitch != b.pitch
        }
        covered = {
            index
            for span in variant.infill_spans
            for index in range(span.start_index, span.end_index)
        }
        assert changed <= covered, f"infill changed notes outside its spans: {changed - covered}"

    def test_an_unavailable_rwkv_worker_does_not_lose_the_variant(self, defective_melody) -> None:
        """Infill is an improvement pass, not a requirement.

        Found by a test that was trying to do something else: with the RWKV
        worker down the whole variant used to fail, taking the feature away
        over an optional stage. The MelodyT5 candidate has already passed the
        guard and is a good result on its own.
        """
        variant, _ = generate_variant(
            source=defective_melody,
            kind=VariantKind.DEVELOPED,
            melody=FakeMelodyAdapter(),
            rwkv=FakeRwkvAdapter(available=False),
            base_seed=3,
        )
        assert variant.notes
        assert variant.infill_spans == ()

    def test_infill_preserves_the_note_count(self, defective_melody) -> None:
        variant, _ = generate_variant(
            source=defective_melody,
            kind=VariantKind.DEVELOPED,
            melody=FakeMelodyAdapter(),
            rwkv=FakeRwkvAdapter(),
            base_seed=3,
        )
        assert len(variant.notes) == len(defective_melody.notes)
