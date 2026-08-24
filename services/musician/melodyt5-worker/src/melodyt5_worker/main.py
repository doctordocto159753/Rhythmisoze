"""HTTP surface of the MelodyT5 worker.

**Internal only.** This container is never exposed publicly: it has no
authentication, it holds gigabytes of weights, and its request shape is an
implementation detail. Compose puts it on the internal network with no published
port, and the runbook says so.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from musician_shared.contract import Meter, Note, Phrase
from pydantic import BaseModel, Field

from .inference import ModelNotLoaded, MelodyT5Runtime, key_from_payload

logging.basicConfig(level=os.environ.get("MUSICIAN_LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

runtime = MelodyT5Runtime(device_preference=os.environ.get("MUSICIAN_DEVICE", "auto"))
app = FastAPI(title="MelodyT5 worker", docs_url=None, redoc_url=None)


class Sampling(BaseModel):
    temperature: float = 0.8
    top_k: int = 32
    top_p: float = 0.9


class GenerateRequest(BaseModel):
    notes: list[Note]
    meter: Meter
    tempoBpm: float
    key: str | None = None
    sampling: Sampling = Sampling()
    seed: int = 0
    task: str = "variation"
    maxBars: int = 24
    phrases: list[Phrase] = Field(default_factory=list)


@app.on_event("startup")
def _startup() -> None:
    # Warm at startup so the first user request is not the one that pays a
    # cold load. A failure here is logged, not fatal: /health reports
    # modelLoaded=false and the orchestrator's /ready turns red, which is more
    # useful than a container that crash-loops.
    try:
        runtime.load()
    except ModelNotLoaded as error:
        logger.error("MelodyT5 not loaded at startup: %s", error)


@app.get("/health")
def health() -> dict:
    info = runtime.info()
    return {
        "status": "ok",
        "modelLoaded": runtime.loaded,
        "revision": info.revision,
        "device": info.device,
    }


@app.get("/info")
def info() -> dict:
    detail = runtime.info()
    return {
        "revision": detail.revision,
        "torch": detail.torch_version,
        "python": detail.python_version,
        "device": detail.device,
        "modelLoaded": runtime.loaded,
    }


@app.post("/generate")
def generate(request: GenerateRequest) -> dict:
    if not runtime.loaded:
        try:
            runtime.load()
        except ModelNotLoaded as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    try:
        notes, raw_abc = runtime.generate(
            notes=tuple(request.notes),
            meter=request.meter,
            tempo_bpm=request.tempoBpm,
            key=key_from_payload(request.key),
            temperature=request.sampling.temperature,
            top_k=request.sampling.top_k,
            top_p=request.sampling.top_p,
            seed=request.seed,
            task=request.task,
            max_patch=request.maxBars,
            phrases=tuple(request.phrases),
        )
    except ModelNotLoaded as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        # Unparseable notation. A rejected candidate, not a server fault.
        raise HTTPException(status_code=422, detail=f"model output unusable: {error}") from error

    return {
        "notes": [n.model_dump(mode="json") for n in notes],
        "meter": request.meter.model_dump(mode="json"),
        "rawAbc": raw_abc,
    }
