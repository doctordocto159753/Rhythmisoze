"""Deterministic stand-ins for both models.

## What a useful fake has to do

A fake that returns its input unchanged passes every test and proves nothing:
the Identity Guard is trivially satisfied, ranking has one candidate, and infill
acceptance never has to make a decision. A fake that returns noise is equally
useless in the other direction -- everything is rejected, and no test ever
exercises the accepting path.

So these fakes *transform*, in a way that is:

* **deterministic** given a seed, so a test asserting an exact output stays true;
* **responsive to sampling parameters**, so a higher temperature really does
  produce a further-away candidate -- which is what lets the Refined/Developed
  policy difference be asserted rather than asserted-about;
* **musically shaped rather than random**, so candidates land in the range where
  the Identity Guard has to actually discriminate instead of trivially passing
  or trivially failing.

They are not a model. They make no claim to musical judgement. Their job is to
let every line of orchestration, guarding, ranking and span selection be tested
without 1.4 GB of weights.
"""

from __future__ import annotations

import random

from ..contract import Meter, Note
from .base import (
    InfillRequest,
    InfillResponse,
    MelodyRequest,
    MelodyResponse,
    ModelUnavailableError,
)

FAKE_MELODY_REVISION = "fake-melodyt5-v1"
FAKE_RWKV_REVISION = "fake-midi-rwkv-v1"


def _rng(seed: int, salt: str) -> random.Random:
    # Salting keeps the melody pass and the infill pass from drawing the same
    # sequence when they happen to share a seed.
    return random.Random(f"{seed}:{salt}")


class FakeMelodyAdapter:
    """Stands in for MelodyT5.

    Applies a bounded, seeded variation whose magnitude scales with temperature:
    small pitch adjustments, mild duration stretching, and -- above a threshold
    -- an occasional passing-note substitution.
    """

    def __init__(self, *, available: bool = True, revision: str = FAKE_MELODY_REVISION) -> None:
        self._available = available
        self._revision = revision

    @property
    def revision(self) -> str:
        return self._revision

    def health(self) -> bool:
        return self._available

    def generate(self, request: MelodyRequest) -> MelodyResponse:
        if not self._available:
            raise ModelUnavailableError("fake melody adapter configured as unavailable")

        rng = _rng(request.seed, "melody")
        temperature = request.sampling.temperature

        # At 0.70 (Refined) this is 0.2; at 0.95 (Developed) it is 0.45. So the
        # two policies genuinely diverge instead of differing only in a number
        # nobody reads.
        drift = max(0.0, (temperature - 0.60) * 1.4)

        # A growth policy asks for more bars than it was given. The fake grows by
        # restating the source, which is the crudest possible A A' and is enough
        # for the pipeline and guard to be exercised without a model.
        source_notes = list(request.notes)
        if request.max_bars > 8 and drift > 0.5:
            repeats = min(3, max(1, request.max_bars // 8))
            source_notes = list(request.notes) * repeats

        notes: list[Note] = []
        elapsed = 0.0
        for index, note in enumerate(source_notes):
            pitch = note.pitch
            if rng.random() < drift * 0.55:
                # Step, never leap: a fake that jumps octaves would be rejected
                # by the guard every time and the accepting path would go
                # untested.
                pitch += rng.choice((-2, -1, 1, 2))
                pitch = max(24, min(96, pitch))

            duration = note.duration_sec
            if rng.random() < drift * 0.45:
                duration *= 1.0 + rng.uniform(-0.18, 0.22) * drift

            gap = 0.0
            if index > 0:
                previous = source_notes[index - 1]
                gap = max(0.0, note.start_sec - previous.end_sec)
                if gap < 0:
                    gap = 0.05

            start = elapsed + gap
            end = start + max(0.05, duration)
            notes.append(
                Note(
                    pitch=pitch,
                    start_sec=round(start, 6),
                    end_sec=round(end, 6),
                    velocity=note.velocity,
                )
            )
            elapsed = end

        return MelodyResponse(notes=tuple(notes), meter=request.meter, raw_abc=None)


class FakeRwkvAdapter:
    """Stands in for MIDI-RWKV.

    Regenerates only the span it was given, and does so *using its context*: the
    replacement is steered toward the pitches on either side, which is the
    behaviour that distinguishes infilling from continuation. A fake that
    ignored its right context would let a broken context-passing bug pass tests.
    """

    def __init__(self, *, available: bool = True, revision: str = FAKE_RWKV_REVISION) -> None:
        self._available = available
        self._revision = revision

    @property
    def revision(self) -> str:
        return self._revision

    def health(self) -> bool:
        return self._available

    def infill(self, request: InfillRequest) -> InfillResponse:
        if not self._available:
            raise ModelUnavailableError("fake rwkv adapter configured as unavailable")
        if not request.span:
            return InfillResponse(notes=())

        rng = _rng(request.seed, "infill")

        anchor_left = request.left_context[-1].pitch if request.left_context else request.span[0].pitch
        anchor_right = (
            request.right_context[0].pitch if request.right_context else request.span[-1].pitch
        )

        span_start = request.span[0].start_sec
        span_end = request.span[-1].end_sec
        count = len(request.span)

        notes: list[Note] = []
        for index, original in enumerate(request.span):
            # Interpolate between the anchors, then perturb. The result is a
            # smoother line through the same span, which is what an infill is
            # supposed to look like when the span was nominated as an outlier.
            position = (index + 1) / (count + 1)
            target = anchor_left + (anchor_right - anchor_left) * position
            jitter = rng.choice((-1, 0, 0, 1)) * (
                1 if request.sampling.temperature > 0.8 else 0
            )
            pitch = int(round(target)) + jitter
            pitch = max(24, min(96, pitch))

            # Timing is preserved exactly: the span must still fit between its
            # neighbours, and a model that returns a longer span than it was
            # given would corrupt the melody it was asked to repair.
            notes.append(
                Note(
                    pitch=pitch,
                    start_sec=original.start_sec,
                    end_sec=original.end_sec,
                    velocity=original.velocity,
                )
            )

        assert notes[0].start_sec == span_start
        assert notes[-1].end_sec == span_end
        return InfillResponse(notes=tuple(notes))


class RogueMelodyAdapter:
    """A model that returns valid notation which is not the user's melody.

    This exists for AC-05. The Identity Guard's whole purpose is that valid
    output is not trustworthy output, and the only way to demonstrate the guard
    works is to hand it something that would otherwise sail through: correct
    types, plausible ranges, monophonic, in time -- and a completely different
    tune.
    """

    def __init__(self, *, revision: str = "fake-rogue-v1") -> None:
        self._revision = revision

    @property
    def revision(self) -> str:
        return self._revision

    def health(self) -> bool:
        return True

    def generate(self, request: MelodyRequest) -> MelodyResponse:
        rng = _rng(request.seed, "rogue")
        notes: list[Note] = []
        cursor = 0.0
        for _ in range(max(4, len(request.notes))):
            pitch = rng.randint(48, 84)
            duration = rng.choice((0.25, 0.5, 0.75))
            notes.append(
                Note(
                    pitch=pitch,
                    start_sec=round(cursor, 6),
                    end_sec=round(cursor + duration, 6),
                    velocity=90,
                )
            )
            cursor += duration
        return MelodyResponse(
            notes=tuple(notes),
            meter=Meter(numerator=request.meter.numerator, denominator=request.meter.denominator, confidence=request.meter.confidence),
            raw_abc=None,
        )
