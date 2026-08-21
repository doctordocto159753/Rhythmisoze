"""Shared symbolic contract, guard and orchestration for the AI Musician.

Deliberately dependency-light. Everything here runs in the API container, in
tests, and on a laptop with no model weights present -- which is what makes the
pipeline testable without downloading 1.4 GB (AC-09).
"""

from .contract import (
    CONTRACT_VERSION,
    Key,
    Meter,
    Mode,
    Motif,
    MusicianInput,
    MusicianOutput,
    Note,
    Phrase,
    Tempo,
    Variant,
    VariantKind,
)
from .identity import IdentityThresholds, evaluate_identity
from .pipeline import SERVICE_VERSION, CancelledError, generate_variant, run_musician
from .policies import DEVELOPED, REFINED, policy_for
from .weak_spans import nominate_weak_spans

__all__ = [
    "CONTRACT_VERSION",
    "SERVICE_VERSION",
    "CancelledError",
    "DEVELOPED",
    "IdentityThresholds",
    "Key",
    "Meter",
    "Mode",
    "Motif",
    "MusicianInput",
    "MusicianOutput",
    "Note",
    "Phrase",
    "REFINED",
    "Tempo",
    "Variant",
    "VariantKind",
    "evaluate_identity",
    "generate_variant",
    "nominate_weak_spans",
    "policy_for",
    "run_musician",
]
