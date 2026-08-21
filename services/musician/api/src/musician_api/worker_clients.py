"""HTTP adapters over the two model workers.

The workers are separate containers because their dependency stacks cannot
coexist -- MelodyT5's published setup is an old Python/PyTorch line, MIDI-RWKV
runs on 3.11 with rwkv.cpp. Forcing them together to make "microservice" mean
"one container" produces a dependency graveyard, and the brief says so
explicitly.

What crosses the wire is the canonical contract, never model-native formats.
That keeps the orchestrator ignorant of tokenisers, ABC dialects and checkpoint
layouts, which is what makes swapping or modernising a worker a worker-local
change.
"""

from __future__ import annotations

import logging

import httpx
from musician_shared.adapters.base import (
    GenerationError,
    InfillRequest,
    InfillResponse,
    MelodyRequest,
    MelodyResponse,
    ModelUnavailableError,
)
from musician_shared.contract import Meter, Note

logger = logging.getLogger(__name__)


class _WorkerClient:
    def __init__(self, *, base_url: str, timeout: float) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout)
        self._revision: str | None = None

    @property
    def revision(self) -> str:
        """Cached after the first successful call.

        Never "unknown" in a result that succeeded: provenance without an exact
        revision cannot reproduce a generation, which is what AC-08 asks for.
        """
        if self._revision is None:
            self._refresh_revision()
        return self._revision or "unavailable"

    def _refresh_revision(self) -> None:
        try:
            response = self._client.get(f"{self._base_url}/info")
            response.raise_for_status()
            self._revision = str(response.json()["revision"])
        except Exception as error:
            logger.warning("could not read worker revision: %s", error)

    def health(self) -> bool:
        try:
            response = self._client.get(f"{self._base_url}/health")
            if response.status_code != 200:
                return False
            body = response.json()
            if self._revision is None and "revision" in body:
                self._revision = str(body["revision"])
            return bool(body.get("modelLoaded", False))
        except Exception:
            return False

    def _post(self, path: str, payload: dict) -> dict:
        try:
            response = self._client.post(f"{self._base_url}{path}", json=payload)
        except httpx.HTTPError as error:
            raise ModelUnavailableError(f"{self._base_url} unreachable: {error}") from error

        if response.status_code == 503:
            raise ModelUnavailableError(f"{self._base_url} reports the model is not loaded")
        if response.status_code >= 400:
            raise GenerationError(f"{self._base_url}{path} returned {response.status_code}")

        try:
            return response.json()
        except ValueError as error:
            raise GenerationError("worker returned a body that is not JSON") from error


def _notes_from(payload: list[dict]) -> tuple[Note, ...]:
    try:
        return tuple(Note.model_validate(item) for item in payload)
    except Exception as error:
        # A model returning unusable notation is an ordinary outcome, not a
        # crash: the candidate is rejected and the next seed is tried.
        raise GenerationError(f"worker returned notes that fail validation: {error}") from error


def _notes_to(notes: tuple[Note, ...]) -> list[dict]:
    return [n.model_dump(mode="json") for n in notes]


class HttpMelodyAdapter(_WorkerClient):
    def generate(self, request: MelodyRequest) -> MelodyResponse:
        body = self._post(
            "/generate",
            {
                "notes": _notes_to(request.notes),
                "meter": request.meter.model_dump(mode="json"),
                "tempoBpm": request.tempo_bpm,
                "key": request.key,
                "sampling": request.sampling.as_dict(),
                "seed": request.seed,
                "task": request.task,
                "maxBars": request.max_bars,
            },
        )
        notes = _notes_from(body.get("notes", []))
        if not notes:
            raise GenerationError("MelodyT5 worker returned no notes")
        meter = Meter.model_validate(body.get("meter", request.meter.model_dump(mode="json")))
        return MelodyResponse(notes=notes, meter=meter, raw_abc=body.get("rawAbc"))


class HttpRwkvAdapter(_WorkerClient):
    def infill(self, request: InfillRequest) -> InfillResponse:
        body = self._post(
            "/infill",
            {
                "leftContext": _notes_to(request.left_context),
                "rightContext": _notes_to(request.right_context),
                "span": _notes_to(request.span),
                "meter": request.meter.model_dump(mode="json"),
                "tempoBpm": request.tempo_bpm,
                "sampling": request.sampling.as_dict(),
                "seed": request.seed,
            },
        )
        notes = _notes_from(body.get("notes", []))

        # The worker is not trusted to respect its own span. A model that
        # returns a longer or differently-placed span would corrupt the melody
        # it was asked to repair, and AC-06 would be satisfied only by
        # convention rather than by construction.
        if notes:
            span_start = request.span[0].start_sec
            span_end = request.span[-1].end_sec
            if notes[0].start_sec < span_start - 1e-3 or notes[-1].end_sec > span_end + 1e-3:
                raise GenerationError(
                    f"infill escaped its span: got "
                    f"{notes[0].start_sec:.3f}..{notes[-1].end_sec:.3f}, "
                    f"allowed {span_start:.3f}..{span_end:.3f}"
                )
        return InfillResponse(notes=notes)
