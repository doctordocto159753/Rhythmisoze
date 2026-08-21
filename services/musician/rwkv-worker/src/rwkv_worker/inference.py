"""MIDI-RWKV infill, behind the canonical contract.

## Infilling is not continuation

The model is given material on **both** sides of the gap and must arrive at the
right-hand context, not merely leave the left-hand one plausibly. That is the
whole reason MIDI-RWKV is here rather than a generic sequence model: a
continuation model asked to repair bar 5 will happily write a bar 5 that makes
bar 6 nonsense.

So the prompt is built as ``left | <mask> | right``, and the response is
validated against the span it was given.

## The span is enforced, not requested

:meth:`RwkvRuntime.infill` truncates and re-times whatever the model returns so
it occupies exactly the span it was asked about. AC-06 says RWKV changes only
selected local spans; a model is not a contract, so the boundary is imposed on
this side of it. The orchestrator's HTTP adapter checks it a second time --
belt and braces, because the failure mode is silent corruption of the user's
melody rather than an error.

## Which rwkv.cpp

Upstream ``RWKV/rwkv.cpp``, not MIDI-RWKV's personal fork. That decision and its
cost are recorded in ``third_party/MANIFEST.md``. CPU is the baseline; GPU is a
build flag, never a requirement.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from musician_shared.contract import Meter, Note

logger = logging.getLogger(__name__)

MODEL_DIR = Path(os.environ.get("MUSICIAN_MODELS_DIR", "/models"))
RWKV_WEIGHT = os.environ.get("MIDI_RWKV_WEIGHT", "midi_rwkv.pth")


class ModelNotLoaded(RuntimeError):
    pass


@dataclass
class RuntimeInfo:
    revision: str
    backend: str
    device: str
    python_version: str


def notes_to_tokens(notes: tuple[Note, ...], *, tempo_bpm: float) -> list[str]:
    """Canonical notes to the worker's textual token form.

    Durations are expressed in sixteenths at the detected tempo rather than in
    seconds, because the model reasons about note *values*, not wall-clock
    length. The same conversion is used in both directions so the round trip is
    stable.
    """
    seconds_per_unit = 60.0 / tempo_bpm / 4.0
    tokens: list[str] = []
    previous_end: float | None = None
    for note in notes:
        if previous_end is not None:
            gap = note.start_sec - previous_end
            units = round(gap / seconds_per_unit)
            if units >= 1:
                tokens.append(f"r{units}")
        length = max(1, round(note.duration_sec / seconds_per_unit))
        tokens.append(f"n{note.pitch}:{length}")
        previous_end = note.end_sec
    return tokens


def tokens_to_notes(
    tokens: list[str], *, tempo_bpm: float, start_sec: float
) -> list[tuple[int, float, float]]:
    seconds_per_unit = 60.0 / tempo_bpm / 4.0
    cursor = start_sec
    out: list[tuple[int, float, float]] = []
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        if token.startswith("r"):
            try:
                cursor += int(token[1:]) * seconds_per_unit
            except ValueError:
                continue
            continue
        if not token.startswith("n") or ":" not in token:
            continue
        try:
            pitch_text, length_text = token[1:].split(":", 1)
            pitch = int(pitch_text)
            length = max(1, int(length_text)) * seconds_per_unit
        except ValueError:
            continue
        if not 0 <= pitch <= 127:
            continue
        out.append((pitch, cursor, cursor + length))
        cursor += length
    return out


class RwkvRuntime:
    def __init__(self, *, device_preference: str = "auto") -> None:
        self._lock = threading.Lock()
        self._model = None
        self._tokenizer = None
        self._device = "cpu"
        self._backend = "not-loaded"
        self._device_preference = device_preference
        self._revision = os.environ.get("MIDI_RWKV_REVISION", "unknown")
        self._load_error: str | None = None

    def resolve_device(self) -> str:
        """CPU baseline. GPU when it exists and was asked for (AC-13, AC-14)."""
        if self._device_preference == "cpu":
            return "cpu"
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        if self._device_preference == "cuda":
            logger.warning("MUSICIAN_DEVICE=cuda requested but unavailable; using CPU")
        return "cpu"

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return

            weight = MODEL_DIR / RWKV_WEIGHT
            if not weight.exists():
                self._load_error = (
                    f"{weight} does not exist. Weights are never committed; run "
                    f"scripts/models/bootstrap.sh (or .ps1) to fetch them."
                )
                raise ModelNotLoaded(self._load_error)

            self._device = self.resolve_device()
            try:
                # rwkv.cpp first: it is the CPU baseline and needs no torch.
                import rwkv_cpp_model  # noqa: PLC0415
                import rwkv_cpp_shared_library  # noqa: PLC0415

                library = rwkv_cpp_shared_library.load_rwkv_shared_library()
                self._model = rwkv_cpp_model.RWKVModel(library, str(weight))
                self._backend = "rwkv.cpp"
            except ImportError:
                try:
                    from rwkv.model import RWKV  # noqa: PLC0415

                    strategy = "cuda fp16" if self._device == "cuda" else "cpu fp32"
                    self._model = RWKV(model=str(weight).removesuffix(".pth"), strategy=strategy)
                    self._backend = "rwkv-pip"
                except ImportError as error:
                    self._load_error = f"no RWKV runtime available: {error}"
                    raise ModelNotLoaded(self._load_error) from error

            logger.info(
                "loaded MIDI-RWKV",
                extra={"backend": self._backend, "device": self._device, "weight": str(weight)},
            )
            self._load_error = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def info(self) -> RuntimeInfo:
        import sys

        return RuntimeInfo(
            revision=self._revision,
            backend=self._backend,
            device=self._device,
            python_version=sys.version.split()[0],
        )

    def infill(
        self,
        *,
        left_context: tuple[Note, ...],
        right_context: tuple[Note, ...],
        span: tuple[Note, ...],
        meter: Meter,
        tempo_bpm: float,
        temperature: float,
        top_k: int,
        top_p: float,
        seed: int,
    ) -> list[Note]:
        if self._model is None:
            raise ModelNotLoaded(self._load_error or "model not loaded")
        if not span:
            return []

        left = " ".join(notes_to_tokens(left_context, tempo_bpm=tempo_bpm))
        right = " ".join(notes_to_tokens(right_context, tempo_bpm=tempo_bpm))
        prompt = (
            f"<meter>{meter.numerator}/{meter.denominator}</meter> "
            f"<left>{left}</left> <mask>{len(span)}</mask> <right>{right}</right> <fill>"
        )

        with self._lock:
            raw = self._sample(prompt, temperature=temperature, top_k=top_k, top_p=top_p, seed=seed)

        span_start = span[0].start_sec
        parsed = tokens_to_notes(raw.split(), tempo_bpm=tempo_bpm, start_sec=span_start)
        if not parsed:
            return []

        return self._fit_to_span(parsed, span)

    @staticmethod
    def _fit_to_span(parsed: list[tuple[int, float, float]], span: tuple[Note, ...]) -> list[Note]:
        """Force the model's output into exactly the span it was given.

        Taking the model's own timing would let a long generation push every
        later note out of place -- the melody would be corrupted rather than
        repaired, and nothing downstream would notice because the result is
        still valid notation.
        """
        count = min(len(parsed), len(span))
        if count == 0:
            return []

        fitted: list[Note] = []
        for index in range(count):
            pitch = parsed[index][0]
            original = span[index]
            fitted.append(
                Note(
                    pitch=pitch,
                    start_sec=original.start_sec,
                    end_sec=original.end_sec,
                    velocity=original.velocity,
                )
            )

        # Short generations keep the original tail rather than shortening the
        # melody: the span must be filled, not truncated.
        for index in range(count, len(span)):
            fitted.append(span[index])
        return fitted

    def _sample(self, prompt: str, *, temperature: float, top_k: int, top_p: float, seed: int) -> str:
        """Backend-specific sampling.

        Split out so the two runtimes differ in one place, and so the compat
        spike can call it directly without an HTTP hop.
        """
        if self._backend == "rwkv-pip":
            from rwkv.utils import PIPELINE, PIPELINE_ARGS  # noqa: PLC0415

            if self._tokenizer is None:
                self._tokenizer = PIPELINE(self._model, "20B_tokenizer.json")
            args = PIPELINE_ARGS(temperature=temperature, top_p=top_p, top_k=top_k)
            return self._tokenizer.generate(prompt, token_count=256, args=args)

        import rwkv_cpp_model  # noqa: PLC0415  (imported for symmetry with load())

        raise ModelNotLoaded(
            "the rwkv.cpp sampling path needs the tokenizer wired to the vendored "
            "MIDI-RWKV tokeniser; see docs/architecture/musician-runtime-adr.md"
        )
