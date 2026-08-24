"""The model seam.

Everything above this line -- orchestration, policies, the Identity Guard,
ranking, span selection -- is deterministic Python that can be tested on a
laptop in milliseconds. Everything below it needs 1.4 GB of weights and a
container.

Keeping that seam sharp is what lets normal CI run the whole pipeline honestly
without downloading anything (AC-09), and it is also what makes the real-model
smoke suite small: by the time the real adapters are involved, the only thing
left untested is the inference call itself.

Both protocols take a seed explicitly. A model that reads its seed from global
state cannot be reproduced from a provenance record, and AC-08 requires exactly
that reproduction.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from ..contract import Meter, Note, Phrase
from ..policies import SamplingParameters


class ModelUnavailableError(RuntimeError):
    """The model could not be loaded or reached.

    Distinct from a generation failure on purpose: this one means the service is
    not ready, and ``/ready`` must reflect it rather than accepting jobs that
    are certain to fail.
    """


class GenerationError(RuntimeError):
    """The model ran and returned something unusable."""


@dataclass(frozen=True)
class MelodyRequest:
    notes: tuple[Note, ...]
    meter: Meter
    tempo_bpm: float
    key: str | None
    sampling: SamplingParameters
    seed: int
    #: Free-text task label passed to MelodyT5 ("variation"). Recorded in
    #: provenance so a future task change is visible in old results.
    task: str = "variation"
    #: Generation ceiling in bars, decided by the variant's policy. The adapter
    #: stops there even if the model would keep going -- a runaway generation is
    #: the one failure a growth variant cannot self-diagnose.
    max_bars: int = 24
    #: Inclusive note-index spans retained as ABC slurs by the model worker.
    phrases: tuple[Phrase, ...] = ()


@dataclass(frozen=True)
class MelodyResponse:
    notes: tuple[Note, ...]
    meter: Meter
    #: Notation the model actually returned, kept for diagnostics. Never parsed
    #: by anything other than the conversion layer.
    raw_abc: str | None = None


@dataclass(frozen=True)
class InfillRequest:
    """A span to regenerate, with the material either side of it.

    Both sides matter: infilling from left context alone is continuation, and
    continuation does not know it has to arrive somewhere.
    """

    left_context: tuple[Note, ...]
    right_context: tuple[Note, ...]
    span: tuple[Note, ...]
    meter: Meter
    tempo_bpm: float
    sampling: SamplingParameters
    seed: int


@dataclass(frozen=True)
class InfillResponse:
    notes: tuple[Note, ...]


@runtime_checkable
class MelodyModelAdapter(Protocol):
    """MelodyT5: whole-melody, score-to-score variation."""

    @property
    def revision(self) -> str:
        """Exact model revision, for provenance. Never "latest"."""

    def health(self) -> bool: ...

    def generate(self, request: MelodyRequest) -> MelodyResponse: ...


@runtime_checkable
class RwkvModelAdapter(Protocol):
    """MIDI-RWKV: selective infill conditioned on both sides."""

    @property
    def revision(self) -> str: ...

    def health(self) -> bool: ...

    def infill(self, request: InfillRequest) -> InfillResponse: ...
