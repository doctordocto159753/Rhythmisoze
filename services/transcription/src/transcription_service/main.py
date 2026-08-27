"""Authoritative server-side transcription boundary for Rhythmisoze.

Melodic audio is transcribed by GAME. Deliberately rhythmic audio is routed to
the server rhythm extractor without invoking GAME. There is no browser-model or
legacy pitch-tracker fallback: an unavailable configured engine is an explicit
503, not a different transcription presented under the same Raw label.
"""

from __future__ import annotations

import logging
import os
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from . import config as config_module
from .audio_analysis import AudioEvidence, classify, rhythm_events
from .game_adapter import AdapterError, transcribe as game_transcribe

logging.basicConfig(level=os.environ.get("TRANSCRIPTION_LOG_LEVEL", "INFO"))
log = logging.getLogger("transcription")

CONFIG = config_module.load()
ENGINE_ID = "game"

app = FastAPI(title="Rhythmisoze authoritative transcription", version="1.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    """Process liveness; model readiness is intentionally a separate signal."""
    return {"status": "ok"}


@app.get("/ready")
def ready() -> JSONResponse:
    detail = CONFIG.readiness_detail()
    available = detail is None
    return JSONResponse(
        status_code=200 if available else 503,
        content={
            "ready": available,
            "engine": ENGINE_ID,
            "backend": CONFIG.backend,
            "modelTier": CONFIG.model_tier,
            "modelVersion": CONFIG.model_version,
            "detail": detail,
        },
    )


def _classification(evidence: AudioEvidence, route: str) -> dict[str, object]:
    confidence = evidence.confidence if route == evidence.route else max(0.8, evidence.confidence)
    return {
        "type": route,
        "confidence": round(min(1.0, confidence), 4),
        "reasoning": [
            "server_audio_router",
            f"periodic_frame_ratio:{evidence.voiced_ratio:.4f}",
            f"onset_rate_hz:{evidence.onset_rate:.4f}",
        ],
        "features": {
            "voicedRatio": round(evidence.voiced_ratio, 6),
            "onsetRate": round(evidence.onset_rate, 6),
        },
        "method": "automatic",
    }


@app.post("/transcribe")
async def authoritative_transcribe(
    audio: UploadFile = File(...),
    mode: Literal["auto", "voice", "instrument", "rhythm"] = Form("auto"),
) -> JSONResponse:
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="empty upload")
    if len(payload) > CONFIG.max_upload_bytes:
        raise HTTPException(status_code=413, detail="upload too large")

    try:
        evidence = classify(payload)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if evidence.duration_sec > CONFIG.max_duration_sec + 0.25:
        raise HTTPException(status_code=413, detail="audio too long")

    if mode == "rhythm":
        requested_route = "rhythm"
    elif mode in {"voice", "instrument"}:
        requested_route = "melody"
    else:
        requested_route = evidence.route
    if requested_route == "unknown":
        raise HTTPException(status_code=422, detail="input route is unknown")

    if requested_route == "rhythm":
        drums = rhythm_events(evidence)
        raw = {
            "version": 1,
            "sourceKind": "audio",
            "notes": [],
            "drums": drums,
            "provenance": {
                "source": "rhythm-extraction",
                "transcriber": "rhythm-extraction",
                "model": "server-spectral-flux",
                "modelVersion": "1.0.0",
                "backend": "server-dsp",
            },
            "sourceDurationSec": evidence.duration_sec,
        }
        return JSONResponse(content={
            "rawTranscription": raw,
            "classification": _classification(evidence, "rhythm"),
            "elapsedMs": 0,
        })

    detail = CONFIG.readiness_detail()
    if detail is not None:
        raise HTTPException(status_code=503, detail=detail)
    try:
        result = game_transcribe(payload, CONFIG)
    except AdapterError as error:
        log.warning("GAME inference failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error)) from error

    raw_notes = [
        {
            "startSec": note.start_sec,
            "endSec": note.end_sec,
            "pitchMidi": round(note.pitch),
            "continuousPitch": note.pitch,
            "velocity": 96,
        }
        for note in result.notes
    ]
    raw = {
        "version": 1,
        "sourceKind": "audio",
        "notes": raw_notes,
        "drums": [],
        "provenance": {
            "source": "game",
            "transcriber": "game",
            "model": "GAME",
            "modelVersion": CONFIG.model_version,
            "backend": CONFIG.backend,
        },
        "sourceDurationSec": evidence.duration_sec,
    }
    return JSONResponse(content={
        "rawTranscription": raw,
        "classification": _classification(evidence, "melody"),
        "elapsedMs": result.elapsed_ms,
    })
