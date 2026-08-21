"""HTTP surface of the MIDI-RWKV worker. **Internal only** -- never published."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from musician_shared.contract import Meter, Note
from pydantic import BaseModel

from .inference import ModelNotLoaded, RwkvRuntime

logging.basicConfig(level=os.environ.get("MUSICIAN_LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

runtime = RwkvRuntime(device_preference=os.environ.get("MUSICIAN_DEVICE", "auto"))
app = FastAPI(title="MIDI-RWKV worker", docs_url=None, redoc_url=None)


class Sampling(BaseModel):
    temperature: float = 0.8
    top_k: int = 32
    top_p: float = 0.9


class InfillRequestBody(BaseModel):
    leftContext: list[Note] = []
    rightContext: list[Note] = []
    span: list[Note]
    meter: Meter
    tempoBpm: float
    sampling: Sampling = Sampling()
    seed: int = 0


@app.on_event("startup")
def _startup() -> None:
    try:
        runtime.load()
    except ModelNotLoaded as error:
        logger.error("MIDI-RWKV not loaded at startup: %s", error)


@app.get("/health")
def health() -> dict:
    info = runtime.info()
    return {
        "status": "ok",
        "modelLoaded": runtime.loaded,
        "revision": info.revision,
        "device": info.device,
        "backend": info.backend,
    }


@app.get("/info")
def info() -> dict:
    detail = runtime.info()
    return {
        "revision": detail.revision,
        "backend": detail.backend,
        "python": detail.python_version,
        "device": detail.device,
        "modelLoaded": runtime.loaded,
    }


@app.post("/infill")
def infill(request: InfillRequestBody) -> dict:
    if not runtime.loaded:
        try:
            runtime.load()
        except ModelNotLoaded as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    try:
        notes = runtime.infill(
            left_context=tuple(request.leftContext),
            right_context=tuple(request.rightContext),
            span=tuple(request.span),
            meter=request.meter,
            tempo_bpm=request.tempoBpm,
            temperature=request.sampling.temperature,
            top_k=request.sampling.top_k,
            top_p=request.sampling.top_p,
            seed=request.seed,
        )
    except ModelNotLoaded as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    return {"notes": [n.model_dump(mode="json") for n in notes]}
