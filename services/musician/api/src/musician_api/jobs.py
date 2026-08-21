"""Job store and worker loop.

Generation takes seconds to minutes, so `POST /v1/jobs` returns a job id and the
work happens behind it. That is not only a latency decision -- it is what keeps
the product rule that Unprocessed, Judge and Teacher appear immediately and are
never blocked by the Musician.

## Why not Celery

Celery brings a broker abstraction, a worker protocol, a result backend and a
configuration surface, to solve a problem this service does not have: it runs a
handful of long jobs against one or two warm model processes. The queue below is
a list push and a blocking pop. Redis-backed because the service is self-hosted
and a restart must not lose queued work; in-memory when no Redis is configured,
so a laptop needs no infrastructure.

The in-memory store is deliberately *not* silently equivalent. `/ready` reports
which one is active, because "jobs vanished after a restart" is a confusing
thing to debug if the service never said it was ephemeral.

## Cancellation

A cancelled job stops at the next checkpoint rather than being killed. The
pipeline calls `should_cancel()` between candidates and between infill spans, so
the longest a cancel waits is one model call. Killing mid-inference would leave
a warm worker in an unknown state, which costs more than the wait.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class JobState(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def terminal(self) -> bool:
        return self in (JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED)


@dataclass
class Job:
    id: str
    state: JobState
    payload: dict[str, Any]
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    cancel_requested: bool = False

    def to_public(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "jobId": self.id,
            "state": self.state.value,
            "createdAt": self.created_at,
        }
        if self.started_at is not None:
            body["startedAt"] = self.started_at
        if self.finished_at is not None:
            body["finishedAt"] = self.finished_at
        if self.state is JobState.SUCCEEDED:
            body["result"] = self.result
        if self.state is JobState.FAILED:
            body["error"] = self.error
        return body


class JobStore:
    """Thread-safe job storage with a pluggable backend.

    The Redis backend stores the same JSON the in-memory one holds, so the two
    are behaviourally identical apart from durability.
    """

    def __init__(self, *, redis_url: str | None, queue_name: str, ttl_sec: int) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._pending: list[str] = []
        self._ttl_sec = ttl_sec
        self._queue_name = queue_name
        self._redis = None
        self.backend = "memory"

        if redis_url:
            try:
                import redis  # noqa: PLC0415

                client = redis.Redis.from_url(redis_url, decode_responses=True)
                client.ping()
                self._redis = client
                self.backend = "redis"
            except Exception as error:
                # Loud, and then degrade. A service that refuses to start
                # because Redis is briefly unavailable is worse than one that
                # says so and keeps working; /ready reports the real backend.
                logger.error("redis unavailable, falling back to memory: %s", error)

    # -- writing -------------------------------------------------------

    def create(self, payload: dict[str, Any]) -> Job:
        job = Job(
            id=uuid.uuid4().hex,
            state=JobState.PENDING,
            payload=payload,
            created_at=time.time(),
        )
        with self._lock:
            self._jobs[job.id] = job
            self._pending.append(job.id)
            if self._redis is not None:
                self._redis.setex(self._key(job.id), self._ttl_sec, self._encode(job))
                self._redis.rpush(self._queue_name, job.id)
        return job

    def update(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
            if self._redis is not None:
                self._redis.setex(self._key(job.id), self._ttl_sec, self._encode(job))

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                return job
            if self._redis is None:
                return None
            raw = self._redis.get(self._key(job_id))
            if raw is None:
                return None
            restored = self._decode(raw)
            self._jobs[job_id] = restored
            return restored

    def request_cancel(self, job_id: str) -> Job | None:
        with self._lock:
            job = self.get(job_id)
            if job is None:
                return None
            if job.state.terminal:
                return job
            job.cancel_requested = True
            if job.state is JobState.PENDING:
                # Never started, so it can go straight to cancelled without
                # waiting for a worker to notice.
                job.state = JobState.CANCELLED
                job.finished_at = time.time()
                if job.id in self._pending:
                    self._pending.remove(job.id)
            self.update(job)
            return job

    def is_cancelled(self, job_id: str) -> bool:
        job = self.get(job_id)
        return job is not None and job.cancel_requested

    # -- reading -------------------------------------------------------

    def claim(self, timeout_sec: float = 1.0) -> Job | None:
        """Take the next pending job, or return None if there is none."""
        if self._redis is not None:
            popped = self._redis.blpop(self._queue_name, timeout=int(max(1, timeout_sec)))
            if popped is None:
                return None
            job_id = popped[1]
        else:
            deadline = time.monotonic() + timeout_sec
            job_id = None
            while time.monotonic() < deadline:
                with self._lock:
                    if self._pending:
                        job_id = self._pending.pop(0)
                        break
                time.sleep(0.01)
            if job_id is None:
                return None

        job = self.get(job_id)
        if job is None or job.state.terminal:
            return None

        job.state = JobState.RUNNING
        job.started_at = time.time()
        self.update(job)
        return job

    def queue_length(self) -> int:
        with self._lock:
            if self._redis is not None:
                try:
                    return int(self._redis.llen(self._queue_name))
                except Exception:
                    return len(self._pending)
            return len(self._pending)

    # -- serialisation -------------------------------------------------

    def _key(self, job_id: str) -> str:
        return f"{self._queue_name}:job:{job_id}"

    @staticmethod
    def _encode(job: Job) -> str:
        return json.dumps(
            {
                "id": job.id,
                "state": job.state.value,
                "payload": job.payload,
                "created_at": job.created_at,
                "started_at": job.started_at,
                "finished_at": job.finished_at,
                "result": job.result,
                "error": job.error,
                "cancel_requested": job.cancel_requested,
            }
        )

    @staticmethod
    def _decode(raw: str) -> Job:
        data = json.loads(raw)
        return Job(
            id=data["id"],
            state=JobState(data["state"]),
            payload=data["payload"],
            created_at=data["created_at"],
            started_at=data.get("started_at"),
            finished_at=data.get("finished_at"),
            result=data.get("result"),
            error=data.get("error"),
            cancel_requested=data.get("cancel_requested", False),
        )


@dataclass
class WorkerLoop:
    """Drains the queue in a background thread."""

    store: JobStore
    handler: Callable[[Job], dict[str, Any]]
    _thread: threading.Thread | None = field(default=None, init=False)
    _stop: threading.Event = field(default_factory=threading.Event, init=False)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="musician-worker", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                job = self.store.claim(timeout_sec=1.0)
            except Exception:
                logger.exception("failed to claim a job")
                time.sleep(0.5)
                continue

            if job is None:
                continue

            started = time.perf_counter()
            try:
                result = self.handler(job)
                job.result = result
                job.state = JobState.SUCCEEDED
            except _JobCancelled:
                job.state = JobState.CANCELLED
            except Exception as error:
                logger.exception("job %s failed", job.id)
                job.state = JobState.FAILED
                # The message, not the traceback: internals do not leave the
                # service (brief section 13).
                job.error = f"{type(error).__name__}: {error}"
            finally:
                job.finished_at = time.time()
                self.store.update(job)
                logger.info(
                    "job finished",
                    extra={
                        "jobId": job.id,
                        "state": job.state.value,
                        "elapsedMs": int((time.perf_counter() - started) * 1000),
                    },
                )


class _JobCancelled(RuntimeError):
    """Internal signal; callers see :class:`JobState.CANCELLED`."""
