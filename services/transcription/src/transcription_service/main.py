"""The register-witness service.

## What it is for

One question, asked of a second engine: *which octave is this note in?*

The browser's own pipeline transcribes the take, and is better at it than this
service is at most things — note boundaries especially. What it cannot do is
hear an octave leap, because YIN locks onto a subharmonic and is then confident.
GAME can, and this is the smallest thing that puts GAME's answer where the
arbitration in `@evidence` can use it.

## What it deliberately is not

Not a queue. Clips are at most sixty seconds, the caller has a timeout, and the
correct response to this service being slow, broken or absent is for the take to
proceed without a second opinion. A queue would add "work accepted and then
lost" to a service whose whole contract is that losing its answer costs nothing.

Not authenticated, and not published. It sits on the internal compose network
exactly like the model workers, for the same reasons: it holds weights, it has
no user model, and its request shape is an implementation detail.

Not on by default. It receives the user's raw recording, and the product's
standing promise is that recordings are processed on the device. Turning it on
changes that promise — to "sent to the transcription service you are running" —
and the interface says so. That is the operator's decision to make, and the
default is the one that needs no explanation.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from . import config as config_module
from .game_adapter import AdapterError, transcribe

logging.basicConfig(level=os.environ.get("TRANSCRIPTION_LOG_LEVEL", "INFO"))
log = logging.getLogger("transcription")

CONFIG = config_module.load()
ENGINE_ID = "game"

app = FastAPI(title="Rhythmisoze register witness", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness. Deliberately does not touch the model.

    Restarting because inference is slow is worst precisely when inference is
    slow, which is the same reasoning the Musician's probe uses.
    """
    return {"status": "ok"}


@app.get("/ready")
def ready() -> JSONResponse:
    """Readiness: are the weights actually here?

    503 when they are not, which is the honest answer for a service that is
    configured but cannot work. The app renders that as "no second opinion
    available" rather than as an error, because it is not one.
    """
    present = CONFIG.model_present()
    return JSONResponse(
        status_code=200 if present else 503,
        content={
            "ready": present,
            "engine": ENGINE_ID,
            "detail": None if present else f"no model.pt under {CONFIG.model_dir}",
        },
    )


@app.post("/witness")
async def witness(audio: UploadFile = File(...)) -> JSONResponse:
    """One take in, one note list out, on the take's own clock.

    The response carries absolute seconds from the start of the recording and
    fractional MIDI pitch. Nothing is rounded, quantized or ordered by anything
    but time: this is evidence, and every decision about what to do with it is
    made on the other side of the boundary.
    """
    if not CONFIG.model_present():
        raise HTTPException(status_code=503, detail="model weights are not present")

    payload = await audio.read()
    if len(payload) == 0:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(payload) > CONFIG.max_upload_bytes:
        raise HTTPException(status_code=413, detail="upload too large")

    try:
        result = transcribe(payload, CONFIG)
    except AdapterError as error:
        # A witness that cannot answer is not a failed request in any sense the
        # caller cares about, but it is still a 502: the caller has to be able
        # to tell "no opinion" from "an opinion with no notes in it", because
        # the second one is evidence and the first one is not.
        log.warning("inference failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error)) from error

    return JSONResponse(
        content={
            "engine": ENGINE_ID,
            "elapsedMs": result.elapsed_ms,
            "notes": [
                {
                    "startSec": round(note.start_sec, 4),
                    "endSec": round(note.end_sec, 4),
                    "pitch": round(note.pitch, 3),
                }
                for note in result.notes
            ],
        }
    )
