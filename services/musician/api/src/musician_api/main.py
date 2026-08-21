"""The one product-facing surface of the AI Musician.

Everything else in `services/musician/` is internal. The model workers are never
exposed publicly: they load gigabytes of weights, they have no authentication,
and their request format is an implementation detail that would become a
compatibility obligation the moment anything outside could call it.

## What this returns, and what it does not

The result carries symbolic notes, provenance and diagnostics. It does not carry
raw model output, tokens, logits, ABC strings the model produced, or stack
traces. Those are useful in a log and are a liability in a response body.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from musician_shared.contract import MusicianInput
from musician_shared.normalize import NormalisationError, from_teacher
from musician_shared.pipeline import SERVICE_VERSION, CancelledError, run_musician
from pydantic import BaseModel, Field, ValidationError

from .adapters_factory import build_adapters
from .config import AdapterMode, Settings
from .jobs import Job, JobState, JobStore, WorkerLoop, _JobCancelled
from .observability import Metrics, configure_logging, request_id_var

logger = logging.getLogger(__name__)


class CreateJobRequest(BaseModel):
    """Teacher material, plus optional determinism controls."""

    teacher: dict[str, Any] = Field(description="Teacher Version in the canonical shape")
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    configure_logging(settings.log_level)

    metrics = Metrics()
    store = JobStore(
        redis_url=settings.redis_url,
        queue_name=settings.queue_name,
        ttl_sec=settings.job_ttl_sec,
    )
    melody, rwkv = build_adapters(settings)

    def handle(job: Job) -> dict[str, Any]:
        payload = job.payload
        source = MusicianInput.model_validate(payload["source"])
        seed = int(payload.get("seed", 20260821))
        deadline = time.monotonic() + settings.generation_timeout_sec

        def should_cancel() -> bool:
            if store.is_cancelled(job.id):
                raise _JobCancelled(job.id)
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"generation exceeded {settings.generation_timeout_sec}s"
                )
            return False

        started = time.perf_counter()
        try:
            output = run_musician(
                source=source,
                melody=melody,
                rwkv=rwkv,
                base_seed=seed,
                should_cancel=should_cancel,
            )
        except CancelledError as error:
            raise _JobCancelled(job.id) from error
        finally:
            metrics.observe_inference(time.perf_counter() - started)

        rejected = len(output.diagnostics.rejected_candidates)
        total = sum(
            output.diagnostics.candidate_counts.get(k, 0) for k in ("refined", "developed")
        )
        metrics.observe_rejection(rejected, total)
        return output.model_dump(mode="json", by_alias=False)

    loop = WorkerLoop(store=store, handler=handle)

    app = FastAPI(
        title="Rhythmisoze AI Musician",
        version=SERVICE_VERSION,
        docs_url="/docs",
    )
    app.state.settings = settings
    app.state.store = store
    app.state.metrics = metrics
    app.state.adapters = (melody, rwkv)

    @app.on_event("startup")
    def _startup() -> None:
        loop.start()
        logger.info(
            "musician api started",
            extra={
                "device": settings.device.value,
                "adapters": settings.adapter_mode.value,
                "queue": store.backend,
            },
        )

    @app.on_event("shutdown")
    def _shutdown() -> None:
        loop.stop()

    @app.middleware("http")
    async def _request_id(request: Request, call_next):
        token = request_id_var.set(request.headers.get("x-request-id") or os.urandom(8).hex())
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        return response

    @app.exception_handler(ValidationError)
    async def _validation(_: Request, error: ValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"error": "invalid payload", "detail": error.errors()})

    # -- liveness and readiness ----------------------------------------

    @app.get("/health")
    def health() -> dict[str, Any]:
        """Is the process up. Deliberately does not touch the models.

        A liveness probe that consults a model restarts the container whenever
        inference is merely slow, which is precisely when restarting is worst.
        """
        return {"status": "ok", "version": SERVICE_VERSION}

    @app.get("/ready")
    def ready() -> JSONResponse:
        """Can this instance actually do work.

        Reports the queue backend honestly: an in-memory queue loses jobs on
        restart, and a service that hides that is hard to debug later.
        """
        melody_ok = _safe_health(melody)
        rwkv_ok = _safe_health(rwkv)
        ready_now = melody_ok and rwkv_ok
        body = {
            "ready": ready_now,
            "models": {"melodyT5": melody_ok, "midiRwkv": rwkv_ok},
            "queue": {"backend": store.backend, "depth": store.queue_length()},
            "device": settings.device.value,
            "adapters": settings.adapter_mode.value,
            "durable": store.backend == "redis",
        }
        return JSONResponse(status_code=200 if ready_now else 503, content=body)

    @app.get("/v1/models")
    def models() -> dict[str, Any]:
        return {
            "melodyT5": {"revision": melody.revision, "available": _safe_health(melody)},
            "midiRwkv": {"revision": rwkv.revision, "available": _safe_health(rwkv)},
            "serviceVersion": SERVICE_VERSION,
            "mode": settings.adapter_mode.value,
        }

    @app.get("/metrics")
    def metrics_endpoint() -> dict[str, Any]:
        return metrics.snapshot(queue_depth=store.queue_length())

    # -- jobs ----------------------------------------------------------

    @app.post("/v1/jobs", status_code=202)
    def create_job(body: CreateJobRequest) -> dict[str, Any]:
        try:
            source = from_teacher(body.teacher)
        except NormalisationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        job = store.create(
            {
                "source": source.model_dump(mode="json"),
                "seed": body.seed if body.seed is not None else 20260821,
            }
        )
        metrics.observe_enqueued()
        logger.info("job accepted", extra={"jobId": job.id, "sourceId": source.source_id})
        return {"jobId": job.id, "state": job.state.value}

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str) -> dict[str, Any]:
        job = store.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        return job.to_public()

    @app.delete("/v1/jobs/{job_id}")
    def cancel_job(job_id: str) -> dict[str, Any]:
        job = store.request_cancel(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="no such job")
        return job.to_public()

    return app


def _safe_health(adapter: Any) -> bool:
    try:
        return bool(adapter.health())
    except Exception:
        return False


app = create_app()
