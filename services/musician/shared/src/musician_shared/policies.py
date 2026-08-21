"""What separates Refined from Developed.

Not the models -- both variants run MelodyT5 then MIDI-RWKV. Not the seed. The
difference is policy, and it lives here so that it is one readable object per
variant rather than a scatter of ``if kind == REFINED`` branches through the
pipeline.

That structure is deliberate. AC-04 requires the two to be "distinct policies,
not merely two random seeds of an identical pipeline", and the honest way to
satisfy that is to make the difference a value that can be inspected, diffed and
asserted on in a test -- which ``tests/test_policies.py`` does.

## Choosing the numbers

They are reasoned, not fitted. There is no corpus of "correct" refinements to
fit them to, and inventing one by tuning against our own identity score would be
optimising the proxy rather than the music. They encode a stance:

* **Refined** should be something the user recognises immediately as their own
  idea, played better. Its identity floor is high, meter is fixed, and it gets
  at most one infill -- one repair, not a rewrite.
* **Developed** may surprise. Its floor is lower, it can extend a little, and it
  may repair a few spans. It still may not become a different piece, which is
  why its floor is lowered rather than removed.

If these two ever converge, the feature has stopped offering a choice, and the
test that compares them is what will say so.
"""

from __future__ import annotations

from dataclasses import dataclass

from .contract import VariantKind
from .identity import IdentityThresholds


@dataclass(frozen=True)
class SamplingParameters:
    temperature: float
    top_k: int
    top_p: float

    def as_dict(self) -> dict[str, float | int | str]:
        return {"temperature": self.temperature, "top_k": self.top_k, "top_p": self.top_p}


@dataclass(frozen=True)
class VariantPolicy:
    kind: VariantKind

    #: Start small. Dozens of candidates multiply inference cost linearly and
    #: add very little: the ranking is over a proxy, so the tenth candidate is
    #: not meaningfully better-chosen than the fourth.
    candidate_count: int

    melody_sampling: SamplingParameters
    infill_sampling: SamplingParameters

    #: How many local spans MIDI-RWKV may regenerate. Refined gets one repair;
    #: Developed gets a few.
    max_infill_spans: int

    #: Infill candidates per span.
    infill_candidates: int

    identity: IdentityThresholds

    #: An infill is kept only if local structure improves by at least this much
    #: *and* no global identity dimension materially degrades. Without it, the
    #: model rewrites spans for no gain and the result drifts.
    min_local_improvement: float

    def as_dict(self) -> dict[str, float | int | str]:
        return {
            "candidate_count": self.candidate_count,
            "melody_temperature": self.melody_sampling.temperature,
            "melody_top_k": self.melody_sampling.top_k,
            "melody_top_p": self.melody_sampling.top_p,
            "infill_temperature": self.infill_sampling.temperature,
            "max_infill_spans": self.max_infill_spans,
            "infill_candidates": self.infill_candidates,
            "identity_floor": self.identity.aggregate_floor,
            "min_local_improvement": self.min_local_improvement,
        }


REFINED = VariantPolicy(
    kind=VariantKind.REFINED,
    candidate_count=4,
    melody_sampling=SamplingParameters(temperature=0.70, top_k=24, top_p=0.88),
    infill_sampling=SamplingParameters(temperature=0.65, top_k=20, top_p=0.85),
    max_infill_spans=1,
    infill_candidates=2,
    identity=IdentityThresholds(
        aggregate_floor=0.78,
        contour_floor=0.72,
        motif_floor=0.60,
        # The same general length: a Refined take that runs half again as long
        # has done something other than refine.
        min_duration_ratio=0.88,
        max_duration_ratio=1.15,
        max_pitch_range_change=1.40,
        max_density_change=1.35,
        require_meter_match=True,
    ),
    min_local_improvement=0.03,
)

DEVELOPED = VariantPolicy(
    kind=VariantKind.DEVELOPED,
    candidate_count=4,
    melody_sampling=SamplingParameters(temperature=0.95, top_k=48, top_p=0.94),
    infill_sampling=SamplingParameters(temperature=0.88, top_k=40, top_p=0.92),
    max_infill_spans=3,
    infill_candidates=3,
    identity=IdentityThresholds(
        # Lower, never absent. Development that abandons the motif is not
        # development, it is a different piece.
        aggregate_floor=0.62,
        contour_floor=0.55,
        motif_floor=0.45,
        min_duration_ratio=0.80,
        # "May extend a phrase slightly if musically coherent" -- slightly.
        max_duration_ratio=1.45,
        max_pitch_range_change=1.85,
        max_density_change=1.70,
        # Meter may change only as an explicitly classified transformation,
        # which V1 does not implement. Until it does, a meter change is a
        # rejection rather than a silent switch.
        require_meter_match=True,
    ),
    min_local_improvement=0.02,
)

POLICIES: dict[VariantKind, VariantPolicy] = {
    VariantKind.REFINED: REFINED,
    VariantKind.DEVELOPED: DEVELOPED,
}


def policy_for(kind: VariantKind) -> VariantPolicy:
    return POLICIES[kind]
