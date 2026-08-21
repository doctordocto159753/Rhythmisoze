"""The Musician pipeline.

One sequence, run twice under two policies:

    Teacher material
        -> MelodyT5 variation, a few candidates
        -> Identity Guard, reject anything that left the idea behind
        -> rank survivors
        -> nominate weak spans
        -> MIDI-RWKV infill, accept only on evidence of improvement
        -> Identity Guard again
        -> variant

## Two rules that are load-bearing

**The Teacher input is never mutated** (AC-07). ``MusicianInput`` is frozen, and
every stage returns new note tuples rather than editing in place. This is not
defensive style: the same input object is used for both variants and for every
identity comparison, so a mutation would silently corrupt the reference the
guard measures against -- and the guard would report improving scores as it did.

**Nothing is accepted because a model returned it.** A MelodyT5 candidate is
accepted only if the guard passes it; an infill is accepted only if local
structure improves *and* the guard still passes. When nothing survives, the
pipeline returns the Teacher material unchanged rather than the least-bad
reject. Handing back something the guard refused would make the guard
decorative.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass

from .adapters.base import (
    GenerationError,
    InfillRequest,
    MelodyModelAdapter,
    MelodyRequest,
    ModelUnavailableError,
    RwkvModelAdapter,
)
from .contract import (
    CandidateOutcome,
    Diagnostics,
    IdentityReport,
    InfillSpan,
    Key,
    MusicianInput,
    MusicianOutput,
    Note,
    Provenance,
    Variant,
    VariantKind,
)
from .identity import evaluate_identity, intervals_of
from .policies import VariantPolicy, policy_for
from .weak_spans import SpanCandidate, nominate_weak_spans

logger = logging.getLogger(__name__)

SERVICE_VERSION = "0.1.0"


class CancelledError(RuntimeError):
    """The job was cancelled while running (AC: cancellation)."""


@dataclass
class _Candidate:
    notes: tuple[Note, ...]
    seed: int
    identity: IdentityReport
    infill_spans: tuple[InfillSpan, ...] = ()


def _local_coherence(notes: Sequence[Note]) -> float:
    """How well a span holds together on its own.

    Two things a listener notices: whether the line moves by steps rather than
    lurches, and whether note lengths are consistent. Both are measured relative
    to the span, so this is comparable before and after an infill of the same
    span -- which is the only comparison it is used for.
    """
    if len(notes) < 2:
        return 1.0

    steps = [abs(b.pitch - a.pitch) for a, b in zip(notes, notes[1:])]
    smoothness = sum(1.0 / (1.0 + step / 2.0) for step in steps) / len(steps)

    durations = [n.duration_sec for n in notes]
    mean_duration = sum(durations) / len(durations)
    if mean_duration <= 0:
        regularity = 0.0
    else:
        spread = sum(abs(d - mean_duration) for d in durations) / len(durations)
        regularity = max(0.0, 1.0 - spread / mean_duration)

    return 0.62 * smoothness + 0.38 * regularity


def _fit_to_policy(
    notes: tuple[Note, ...], source: MusicianInput, policy: VariantPolicy
) -> tuple[Note, ...]:
    """Trim a candidate to the length its variant is allowed to be.

    MelodyT5 writes *tunes*. Given a four-bar phrase it will happily return a
    complete sixteen-bar melody with repeats, because that is what its training
    data looks like. For Expanded that is the feature. For Refined and Developed
    it is not, and rejecting the candidate for it would throw away good material
    over a length the policy could simply have cut.

    So a non-growth policy takes the opening of what the model wrote, up to its
    own duration ceiling. The opening rather than a middle slice because that is
    the part that answers the prompt -- the model starts from our phrase.

    Growth policies are returned untouched: trimming Expanded would defeat it.
    """
    if policy.identity.allow_growth or not notes:
        return notes

    source_span = source.notes[-1].end_sec - source.notes[0].start_sec
    if source_span <= 0:
        return notes

    ceiling = source_span * policy.identity.max_duration_ratio
    origin = notes[0].start_sec
    kept = tuple(note for note in notes if note.end_sec - origin <= ceiling)

    # Never trim to nothing: a single very long note would leave an empty
    # candidate, which reads as a generation failure rather than a long note.
    return kept if len(kept) >= 2 else notes[: max(2, len(source.notes))]


def _guard(
    source: MusicianInput,
    notes: Sequence[Note],
    policy: VariantPolicy,
) -> IdentityReport:
    duration = notes[-1].end_sec if notes else 0.0
    return evaluate_identity(
        reference=source.notes,
        reference_key=source.key,
        reference_meter=source.meter,
        reference_duration_sec=source.duration_sec,
        reference_motifs=[m.intervals for m in source.motifs],
        candidate=notes,
        candidate_meter=source.meter,
        candidate_duration_sec=duration,
        thresholds=policy.identity,
    )


def _bar_budget(source: MusicianInput, policy: VariantPolicy) -> int:
    """How many bars the model may write for this input.

    Scaled from the source rather than fixed, because a 4-bar seed and a 32-bar
    phrase do not want the same ceiling, and capped absolutely because a ratio
    alone cannot stop a 1-bar seed from becoming 200 bars when a model loses the
    thread.
    """
    beats = source.meter.beats_per_bar
    seconds_per_bar = beats * 60.0 / source.tempo.bpm
    span = max(source.notes[-1].end_sec - source.notes[0].start_sec, seconds_per_bar)
    source_bars = max(1, round(span / seconds_per_bar))
    return max(2, min(policy.max_generated_bars, int(source_bars * policy.max_bar_growth) + 1))


def _seeds_for(base_seed: int, policy: VariantPolicy) -> list[int]:
    # Derived rather than random, so the provenance record's single base seed
    # reproduces every candidate (AC-08).
    offsets = {VariantKind.REFINED: 1000, VariantKind.DEVELOPED: 2000, VariantKind.EXPANDED: 3000}
    offset = offsets[policy.kind]
    return [base_seed + offset + i for i in range(policy.candidate_count)]


def _rank(candidates: Sequence[_Candidate], source: MusicianInput) -> list[_Candidate]:
    """Best first.

    Identity alone is the wrong ranking key: it is a guardrail, and maximising
    it selects the candidate that changed least, which is the candidate that did
    the least work. So survivors are ranked on musical structure, with identity
    acting only as the gate they already passed.
    """
    source_intervals = intervals_of(source.notes)
    source_smoothness = _local_coherence(source.notes)

    def score(candidate: _Candidate) -> tuple[float, int]:
        coherence = _local_coherence(candidate.notes)
        # Reward improvement over the Teacher version, not absolute smoothness:
        # a monotone would score perfectly on smoothness alone.
        improvement = coherence - source_smoothness
        variety = 0.0
        if source_intervals:
            candidate_intervals = intervals_of(candidate.notes)
            changed = sum(
                1
                for a, b in zip(source_intervals, candidate_intervals)
                if a != b
            )
            variety = changed / len(source_intervals)
        # A little variety is the point; a lot of it is why the guard exists.
        return (improvement + 0.25 * min(variety, 0.5), -candidate.seed)

    return sorted(candidates, key=score, reverse=True)


def _apply_infill(
    notes: tuple[Note, ...],
    span: SpanCandidate,
    replacement: Sequence[Note],
) -> tuple[Note, ...]:
    """Splice a regenerated span back in, leaving everything else untouched.

    AC-06 is enforced here rather than trusted: the notes outside the span are
    carried across by identity, so an adapter that returned a whole new melody
    would still only be able to change the span it was given.
    """
    return notes[: span.start_index] + tuple(replacement) + notes[span.end_index :]


def _run_infill(
    *,
    source: MusicianInput,
    candidate: _Candidate,
    policy: VariantPolicy,
    rwkv: RwkvModelAdapter,
    base_seed: int,
    should_cancel,
) -> _Candidate:
    spans = nominate_weak_spans(candidate.notes, limit=policy.max_infill_spans)
    if not spans:
        return candidate

    notes = candidate.notes
    applied: list[InfillSpan] = []

    for span_index, span in enumerate(spans):
        if should_cancel():
            raise CancelledError("cancelled during infill")

        # Re-derive against the current notes: a previous accepted infill may
        # have shifted what this span contains.
        if span.end_index > len(notes):
            continue
        before = notes[span.start_index : span.end_index]
        if len(before) < 2:
            continue

        baseline = _local_coherence(before)
        best: tuple[float, tuple[Note, ...], IdentityReport] | None = None

        for attempt in range(policy.infill_candidates):
            seed = base_seed + 5000 + span_index * 100 + attempt
            try:
                response = rwkv.infill(
                    InfillRequest(
                        left_context=notes[max(0, span.start_index - 6) : span.start_index],
                        right_context=notes[span.end_index : span.end_index + 6],
                        span=before,
                        meter=source.meter,
                        tempo_bpm=source.tempo.bpm,
                        sampling=policy.infill_sampling,
                        seed=seed,
                    )
                )
            except ModelUnavailableError as error:
                # Infill is an improvement pass, not a requirement. If the RWKV
                # worker is down, the MelodyT5 candidate has already passed the
                # guard and is a perfectly good result -- failing the whole
                # variant would take the feature away over an optional stage.
                # Further spans are pointless too, so stop rather than retry.
                logger.warning(
                    "infill unavailable, keeping the candidate unchanged",
                    extra={"reason": str(error)},
                )
                return _Candidate(
                    notes=notes,
                    seed=candidate.seed,
                    identity=candidate.identity,
                    infill_spans=tuple(applied),
                )
            except GenerationError:
                logger.warning("infill candidate failed", extra={"span": span.start_index})
                continue

            if not response.notes:
                continue

            spliced = _apply_infill(notes, span, response.notes)
            local_gain = _local_coherence(response.notes) - baseline
            if local_gain < policy.min_local_improvement:
                continue

            report = _guard(source, spliced, policy)
            if not report.passed:
                continue
            # No global dimension may degrade materially just because a local
            # one improved.
            if report.aggregate < candidate.identity.aggregate - 0.05:
                continue

            if best is None or local_gain > best[0]:
                best = (local_gain, spliced, report)

        if best is not None:
            _, notes, report = best
            candidate = _Candidate(
                notes=notes,
                seed=candidate.seed,
                identity=report,
                infill_spans=candidate.infill_spans,
            )
            applied.append(span.to_span())

    return _Candidate(
        notes=notes,
        seed=candidate.seed,
        identity=candidate.identity,
        infill_spans=tuple(applied),
    )


def generate_variant(
    *,
    source: MusicianInput,
    kind: VariantKind,
    melody: MelodyModelAdapter,
    rwkv: RwkvModelAdapter,
    base_seed: int,
    should_cancel=lambda: False,
) -> tuple[Variant, list[CandidateOutcome]]:
    policy = policy_for(kind)
    outcomes: list[CandidateOutcome] = []
    survivors: list[_Candidate] = []

    for seed in _seeds_for(base_seed, policy):
        if should_cancel():
            raise CancelledError("cancelled during candidate generation")

        try:
            response = melody.generate(
                MelodyRequest(
                    notes=source.notes,
                    meter=source.meter,
                    tempo_bpm=source.tempo.bpm,
                    key=f"{source.key.tonic} {source.key.mode.value}" if source.key else None,
                    sampling=policy.melody_sampling,
                    seed=seed,
                    max_bars=_bar_budget(source, policy),
                )
            )
        except GenerationError as error:
            outcomes.append(
                CandidateOutcome(
                    stage="melody",
                    seed=seed,
                    accepted=False,
                    identity_aggregate=0.0,
                    rejection_reasons=(f"generation failed: {error}",),
                )
            )
            continue

        candidate_notes = _fit_to_policy(response.notes, source, policy)
        report = _guard(source, candidate_notes, policy)
        outcomes.append(
            CandidateOutcome(
                stage="melody",
                seed=seed,
                accepted=report.passed,
                identity_aggregate=report.aggregate,
                rejection_reasons=report.failures,
            )
        )
        if report.passed:
            survivors.append(_Candidate(notes=candidate_notes, seed=seed, identity=report))

    if not survivors:
        # Every candidate left the idea behind. Returning the least-bad one
        # would make the guard decorative, so the Teacher material is returned
        # unchanged and the diagnostics say why.
        logger.info("no candidate survived the identity guard", extra={"kind": kind.value})
        fallback = _Candidate(
            notes=source.notes,
            seed=base_seed,
            identity=_guard(source, source.notes, policy),
        )
        return _to_variant(source, fallback, kind), outcomes

    best = _rank(survivors, source)[0]
    best = _run_infill(
        source=source,
        candidate=best,
        policy=policy,
        rwkv=rwkv,
        base_seed=base_seed,
        should_cancel=should_cancel,
    )
    return _to_variant(source, best, kind), outcomes


def _to_variant(source: MusicianInput, candidate: _Candidate, kind: VariantKind) -> Variant:
    duration = candidate.notes[-1].end_sec if candidate.notes else source.duration_sec
    return Variant(
        kind=kind,
        notes=candidate.notes,
        tempo=source.tempo,
        meter=source.meter,
        key=source.key,
        duration_sec=round(duration, 6),
        identity=candidate.identity,
        infill_spans=candidate.infill_spans,
    )


def run_musician(
    *,
    source: MusicianInput,
    melody: MelodyModelAdapter,
    rwkv: RwkvModelAdapter,
    base_seed: int = 20260821,
    should_cancel=lambda: False,
) -> MusicianOutput:
    """Both variants, one call."""
    started = time.perf_counter()

    variants: dict[VariantKind, Variant] = {}
    outcomes_by_kind: dict[VariantKind, list[CandidateOutcome]] = {}

    # The three variants run the same sequence under three policies. Iterating
    # the enum rather than writing three near-identical blocks is what keeps a
    # fourth from being a fourth copy.
    for kind in (VariantKind.REFINED, VariantKind.DEVELOPED, VariantKind.EXPANDED):
        variant, outcomes = generate_variant(
            source=source,
            kind=kind,
            melody=melody,
            rwkv=rwkv,
            base_seed=base_seed,
            should_cancel=should_cancel,
        )
        variants[kind] = variant
        outcomes_by_kind[kind] = outcomes

    refined = variants[VariantKind.REFINED]
    developed = variants[VariantKind.DEVELOPED]
    expanded = variants[VariantKind.EXPANDED]
    all_outcomes = [o for kind in outcomes_by_kind for o in outcomes_by_kind[kind]]
    rejected = tuple(o for o in all_outcomes if not o.accepted)
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    return MusicianOutput(
        source_id=source.source_id,
        refined=refined,
        developed=developed,
        expanded=expanded,
        provenance=Provenance(
            melody_t5_revision=melody.revision,
            midi_rwkv_revision=rwkv.revision,
            musician_service_version=SERVICE_VERSION,
            input_fingerprint=source.fingerprint(),
            seeds={"base": base_seed},
            parameters={kind.value: policy_for(kind).as_dict() for kind in outcomes_by_kind},
            elapsed_ms=elapsed_ms,
        ),
        diagnostics=Diagnostics(
            candidate_counts={
                **{kind.value: len(outcomes) for kind, outcomes in outcomes_by_kind.items()},
                "accepted": sum(1 for o in all_outcomes if o.accepted),
            },
            rejected_candidates=rejected,
            identity_guard_summary={
                **{
                    f"{kind.value}_aggregate": variant.identity.aggregate
                    for kind, variant in variants.items()
                },
                "rejection_rate": (len(rejected) / len(all_outcomes)) if all_outcomes else 0.0,
            },
        ),
    )
