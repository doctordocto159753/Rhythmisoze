"""MelodyT5 inference, behind the canonical contract.

## What this worker is responsible for

Turning canonical notes into the ABC that MelodyT5 reads, running the model, and
turning its ABC back into canonical notes. Nothing else. The orchestrator does
not know this model uses ABC, and must not: that is what makes modernising or
replacing this worker a change confined to this directory.

## The runtime question, stated honestly

MelodyT5's published environment is an old Python/PyTorch line. Two options
exist, and which one is correct is an empirical question, not a preference:

1. run the inference adapter on a maintained runtime, keeping the architecture
   and weights untouched;
2. pin the legacy runtime inside this container.

``scripts/spike/melodyt5_compat.py`` decides it by generating fixed-seed
reference fixtures and comparing. Until that spike has been run against real
weights, this module makes no claim about which runtime it is on -- it reports
the versions it actually loaded, and ``docs/architecture/musician-runtime-adr.md``
records the outcome.

## Determinism

The seed is set on every generate call, not once at startup. A worker that seeds
once produces a different result for the same request depending on how many
requests preceded it, which makes the provenance record a lie.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from musician_shared.abc import from_abc, to_abc
from musician_shared.contract import Key, Meter, Mode, Note

logger = logging.getLogger(__name__)

MODEL_DIR = Path(os.environ.get("MUSICIAN_MODELS_DIR", "/models"))
MELODYT5_NAME = "melodyt5"


class ModelNotLoaded(RuntimeError):
    pass


@dataclass
class RuntimeInfo:
    revision: str
    torch_version: str
    device: str
    python_version: str


class MelodyT5Runtime:
    """Loads the weights once and keeps them warm.

    Guarded by a lock rather than assumed single-threaded: uvicorn will happily
    run two requests concurrently, and a transformer's generate call is not
    reentrant with a shared seeded generator.
    """

    def __init__(self, *, device_preference: str = "auto") -> None:
        self._lock = threading.Lock()
        self._model = None
        self._tokenizer = None
        self._device = "cpu"
        self._device_preference = device_preference
        self._revision = os.environ.get("MELODYT5_REVISION", "unknown")
        self._torch_version = "not-loaded"
        self._load_error: str | None = None

    # -- lifecycle -----------------------------------------------------

    def resolve_device(self) -> str:
        """Never crash because CUDA is absent (AC-14).

        ``auto`` means "use the GPU if there is one", not "require one". A
        service that fails to start on a CPU VPS because it was configured for
        auto has misunderstood the word.
        """
        if self._device_preference == "cpu":
            return "cpu"
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                return "cuda"
        except Exception as error:
            logger.info("no CUDA available, using CPU: %s", error)

        if self._device_preference == "cuda":
            logger.warning("MUSICIAN_DEVICE=cuda was requested but no GPU is available; using CPU")
        return "cpu"

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            try:
                import torch  # noqa: PLC0415
                from transformers import AutoTokenizer, T5ForConditionalGeneration  # noqa: PLC0415
            except ImportError as error:
                self._load_error = f"inference dependencies missing: {error}"
                raise ModelNotLoaded(self._load_error) from error

            weights = MODEL_DIR / MELODYT5_NAME
            if not weights.exists():
                self._load_error = (
                    f"{weights} does not exist. Weights are never committed; run "
                    f"scripts/models/bootstrap.sh (or .ps1) to fetch them."
                )
                raise ModelNotLoaded(self._load_error)

            self._device = self.resolve_device()
            self._torch_version = torch.__version__
            logger.info(
                "loading MelodyT5",
                extra={"path": str(weights), "device": self._device, "torch": self._torch_version},
            )
            self._tokenizer = AutoTokenizer.from_pretrained(str(weights))
            self._model = T5ForConditionalGeneration.from_pretrained(str(weights))
            self._model.to(self._device)
            self._model.eval()
            self._load_error = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def info(self) -> RuntimeInfo:
        import sys

        return RuntimeInfo(
            revision=self._revision,
            torch_version=self._torch_version,
            device=self._device,
            python_version=sys.version.split()[0],
        )

    # -- generation ----------------------------------------------------

    def generate(
        self,
        *,
        notes: tuple[Note, ...],
        meter: Meter,
        tempo_bpm: float,
        key: Key | None,
        temperature: float,
        top_k: int,
        top_p: float,
        seed: int,
        task: str = "variation",
    ) -> tuple[tuple[Note, ...], str]:
        if self._model is None:
            raise ModelNotLoaded(self._load_error or "model not loaded")

        import torch  # noqa: PLC0415

        document = to_abc(notes, meter=meter, tempo_bpm=tempo_bpm, key=key)
        prompt = f"{task}: {document.text}"

        with self._lock:
            torch.manual_seed(seed)
            if self._device == "cuda":
                torch.cuda.manual_seed_all(seed)

            encoded = self._tokenizer(
                prompt, return_tensors="pt", truncation=True, max_length=1024
            ).to(self._device)

            with torch.no_grad():
                generated = self._model.generate(
                    **encoded,
                    do_sample=True,
                    temperature=temperature,
                    top_k=top_k,
                    top_p=top_p,
                    max_new_tokens=1024,
                    num_return_sequences=1,
                )

        raw_abc = self._tokenizer.decode(generated[0], skip_special_tokens=True)

        # A model returning notation we cannot parse is an ordinary outcome:
        # the orchestrator rejects the candidate and tries the next seed. It is
        # not a reason to fail the request.
        parsed = from_abc(raw_abc, tempo_bpm=tempo_bpm, start_sec=notes[0].start_sec)
        return parsed, raw_abc


def key_from_payload(payload: str | None) -> Key | None:
    if not payload:
        return None
    parts = payload.split()
    if not parts:
        return None
    tonic = parts[0]
    mode = Mode.MINOR if len(parts) > 1 and parts[1].lower().startswith("min") else Mode.MAJOR
    return Key(tonic=tonic, mode=mode, confidence=1.0)
