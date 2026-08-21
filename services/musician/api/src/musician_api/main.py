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
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from musician_shared.contract import MusicianInput
from musician_shared.normalize import NormalisationError, from_teacher
from musician_shared.pipeline import SERVICE_VERSION, CancelledError, run_musician
from pydantic import BaseModel, Field, ValidationError

from .adapters_factory import build_adapters
from .config import AdapterMode, Settings
from .jobs import Job, JobState, JobStore, QueueFull, WorkerLoop, _JobCancelled
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
        max_depth=settings.max_queue_depth,
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

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # A job that was mid-generation when this process last died still reads
        # `running` in Redis and will never advance. Failing it here is what stops
        # a client polling forever -- see JobStore.fail_orphaned_running.
        orphaned = store.fail_orphaned_running()
        if orphaned:
            logger.warning(
                "failed jobs left running by a previous process",
                extra={"count": orphaned},
            )

        loop.start()
        logger.info(
            "musician api started",
            extra={
                "device": settings.device.value,
                "adapters": settings.adapter_mode.value,
                "queue": store.backend,
            },
        )
        try:
            yield
        finally:
            # Draining rather than abandoning: a job mid-generation finishes its
            # current model call before the loop exits, so a redeploy does not
            # leave a worker holding weights in an unknown state.
            loop.stop()

    app = FastAPI(
        title="Rhythmisoze AI Musician",
        version=SERVICE_VERSION,
        docs_url="/docs",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.store = store
    app.state.metrics = metrics
    app.state.adapters = (melody, rwkv)

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

        ## Which model has to be up

        **MelodyT5 is required; MIDI-RWKV is not.** That asymmetry is the
        pipeline's own policy, not a relaxation of this probe: MelodyT5 writes the
        candidates, so without it there is nothing to guard or rank and a job can
        only fail. Infill is an improvement pass over a candidate that has already
        passed the guard, and `pipeline._run_infill` explicitly keeps the candidate
        when the RWKV worker is unreachable.

        Reporting not-ready when only RWKV is down made the two disagree, and the
        proxy's `/api/musician/status` turns that into "the musician is not
        available" -- so the product refused to generate results it was perfectly
        able to produce. `degraded` says the real thing instead.

        Reports the queue backend honestly too: an in-memory queue loses jobs on
        restart, and a service that hides that is hard to debug later.
        """
        melody_ok = _safe_health(melody)
        rwkv_ok = _safe_health(rwkv)
        # MelodyT5 alone decides readiness. See the docstring.
        ready_now = melody_ok
        body = {
            "ready": ready_now,
            "degraded": ready_now and not rwkv_ok,
            "models": {"melodyT5": melody_ok, "midiRwkv": rwkv_ok},
            "queue": {"backend": store.backend, "depth": store.queue_length()},
            "device": settings.device.value,
            "adapters": settings.adapter_mode.value,
            "durable": store.backend == "redis",
        }
        if ready_now and not rwkv_ok:
            body["detail"] = (
                "the local-repair model is unavailable; variants will be produced "
                "without the infill pass"
            )
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

        # Refuse work that cannot possibly succeed.
        #
        # Without MelodyT5 there are no candidates, so the job would queue, run,
        # reject every seed and return the Teacher material -- minutes of spinner
        # ending in a version identical to one the user already had. A 503 here is
        # the same recoverable state the client already handles, delivered
        # immediately. Only MelodyT5 is checked: the RWKV worker being down is a
        # degraded generation, not an impossible one.
        if not _safe_health(melody):
            raise HTTPException(
                status_code=503,
                detail="the melody model is not available; no generation can start",
            )

        try:
            job = store.create(
                {
                    "source": source.model_dump(mode="json"),
                    "seed": body.seed if body.seed is not None else 20260821,
                }
            )
        except QueueFull as error:
            # 503 rather than 429: this is not "you asked too often", it is "the
            # service is saturated", and the client's recoverable-error path
            # already covers it. `Retry-After` is a real number rather than a
            # ritual -- one generation has to finish before a slot opens, and the
            # measured Expanded latency is the honest estimate of that.
            logger.warning("refused a job: the queue is full")
            raise HTTPException(
                status_code=503,
                detail="the musician is busy; try again shortly",
                headers={"Retry-After": "30"},
            ) from error
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
