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

#: Only sweep the in-process job cache once it is worth sweeping. Below this the
#: dict is a few kilobytes and walking it on every state change costs more than
#: it saves.
_CACHE_HIGH_WATER = 64


class QueueFull(RuntimeError):
    """The backlog is already longer than anyone will wait for.

    Raised by :meth:`JobStore.create` rather than returned, so that no caller can
    accept a job by forgetting to check a boolean.
    """


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

    def __init__(
        self,
        *,
        redis_url: str | None,
        queue_name: str,
        ttl_sec: int,
        max_depth: int = 16,
    ) -> None:
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._pending: list[str] = []
        self._ttl_sec = ttl_sec
        self._max_depth = max_depth
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
        """Queue a job, or refuse because the backlog is already too long.

        Refusing is the kinder answer. One worker thread runs one generation at a
        time and a generation is minutes, so accepting the hundredth job means
        holding its payload for an hour and then handing the client a timeout --
        having spent the memory and the queue slot to arrive at the same place.
        Raises :class:`QueueFull` so the caller cannot accept by omission.
        """
        job = Job(
            id=uuid.uuid4().hex,
            state=JobState.PENDING,
            payload=payload,
            created_at=time.time(),
        )
        # Checked inside the lock, with the enqueue. Split apart, two requests
        # arriving together both read a depth one below the limit and both are
        # accepted -- a bound that holds only when nobody is testing it is not a
        # bound. The lock is re-entrant, so `queue_length` may take it again.
        with self._lock:
            depth = self.queue_length()
            if depth >= self._max_depth:
                raise QueueFull(
                    f"{depth} jobs are already waiting, which is the configured limit"
                )
            self._jobs[job.id] = job
            if self._redis is not None:
                self._redis.setex(self._key(job.id), self._ttl_sec, self._encode(job))
                self._redis.rpush(self._queue_name, job.id)
            else:
                # Only the memory backend keeps its own queue. Appending here on
                # the Redis path too would build a second, never-drained list of
                # every job the process ever saw -- claim() pops from Redis, so
                # nothing would ever remove them -- and `queue_length()` would
                # report that backlog whenever Redis hiccuped.
                self._pending.append(job.id)
        return job

    def update(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
            if self._redis is not None:
                self._redis.setex(self._key(job.id), self._ttl_sec, self._encode(job))
        self._evict_finished()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            if self._redis is None:
                return self._jobs.get(job_id)

            # Redis is the source of truth when it is configured. Preferring the
            # local dict would serve this process's stale copy of a job another
            # instance has since advanced, and would keep serving a job Redis has
            # already expired.
            try:
                raw = self._redis.get(self._key(job_id))
            except Exception as error:
                # A Redis blip must not lose an in-flight job. The local copy is
                # the best available answer, and it is the one this worker is
                # itself updating.
                logger.warning("redis read failed, falling back to the local copy: %s", error)
                return self._jobs.get(job_id)

            if raw is None:
                # Expired or never existed. A local copy of an expired job is not
                # a reason to keep answering for it -- the TTL is the contract.
                self._jobs.pop(job_id, None)
                return None

            restored = self._decode(raw)
            local = self._jobs.get(job_id)
            if local is not None:
                # `cancel_requested` is the one flag a worker polls between model
                # calls, and the worker owns the local object. Carrying it across
                # keeps a cancel that arrived through another instance visible
                # here rather than being overwritten by the reload.
                restored.cancel_requested = restored.cancel_requested or local.cancel_requested
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

        # Read, check and promote under one lock.
        #
        # Split across three statements, a `DELETE /v1/jobs/{id}` landing between
        # the read and the write is acknowledged as `cancelled` and then
        # overwritten by `RUNNING` -- so the client is told the job stopped while
        # the service starts it. The window is small and the failure is silent,
        # which is the combination worth closing rather than documenting.
        with self._lock:
            job = self.get(job_id)
            if job is None or job.state.terminal:
                return None
            if job.cancel_requested:
                # Cancelled while queued. Claiming it would burn a model call on
                # a result nobody will read.
                job.state = JobState.CANCELLED
                job.finished_at = time.time()
                self.update(job)
                return None

            job.state = JobState.RUNNING
            job.started_at = time.time()
            self.update(job)
            return job

    def queue_length(self) -> int:
        """How many jobs are actually waiting for a worker.

        Not ``len(self._pending)``. That list is drained by ``claim`` and by
        cancelling a queued job, which covers how a job normally leaves it -- but
        an id whose job reached a terminal state by any other route stays behind,
        and counting it publishes backlog that does not exist. `/ready` and
        `/metrics` both report this number and `create` now refuses on it, so a
        phantom entry is not a cosmetic error: it is a job refused because of one
        that already finished.
        """
        with self._lock:
            if self._redis is not None:
                try:
                    return int(self._redis.llen(self._queue_name))
                except Exception:
                    # No local queue exists on the Redis path, so there is no
                    # honest number to give. Zero is wrong in a knowable way;
                    # -1 would be worse, because /ready publishes this.
                    return 0
            waiting = 0
            for job_id in self._pending:
                job = self._jobs.get(job_id)
                # Evicted from the cache means finished long enough ago to have
                # passed its TTL, which is not waiting either.
                if job is not None and job.state is JobState.PENDING:
                    waiting += 1
            return waiting

    def _evict_finished(self) -> None:
        """Drop finished jobs from the in-process cache once their TTL is up.

        Without this the dict is a memory leak with a result payload attached:
        every job's notes, provenance and diagnostics stay resident for the life
        of the process. Redis expires its copy; nothing expired this one.

        Only terminal jobs are evicted, and only past the TTL, so a client that
        is still polling always finds its result -- on the Redis path it is read
        back from Redis anyway, and on the memory path the TTL is the same
        promise `/ready` already makes about durability.
        """
        with self._lock:
            if len(self._jobs) <= _CACHE_HIGH_WATER:
                return
            cutoff = time.time() - self._ttl_sec
            stale = [
                job_id
                for job_id, job in self._jobs.items()
                if job.state.terminal and (job.finished_at or job.created_at) < cutoff
            ]
            for job_id in stale:
                del self._jobs[job_id]
            if stale:
                logger.info("evicted %d finished jobs from the cache", len(stale))
            # The queue list is drained by `claim` and by cancelling a queued
            # job. Anything still here whose job is no longer pending left by
            # some other route and would otherwise sit in the list forever.
            self._pending = [
                job_id
                for job_id in self._pending
                if (job := self._jobs.get(job_id)) is not None and job.state is JobState.PENDING
            ]

    def fail_orphaned_running(self) -> int:
        """Fail jobs that were mid-generation when the process died.

        A restart kills the worker thread; the job's Redis record still says
        ``running`` and nothing will ever advance it. The client polls a state
        that cannot change, which is the eternal spinner -- the single worst
        restart outcome, because the user cannot tell it from slow generation.

        Failing them is the honest answer: the work really did stop, the job
        really will not finish, and `failed` is a state the UI already handles by
        keeping every existing version and offering a retry. Requeueing instead
        would be wrong -- the payload is there but the elapsed time, the partial
        model state and the user's intent are not, and silently redoing minutes of
        inference nobody is waiting for is worse than saying so.

        Returns how many were failed, so startup can log a real number.
        """
        if self._redis is None:
            # Nothing survived the restart to orphan. `/ready` already reports
            # this backend as non-durable.
            return 0

        failed = 0
        try:
            cursor = 0
            pattern = f"{self._queue_name}:job:*"
            while True:
                cursor, keys = self._redis.scan(cursor=cursor, match=pattern, count=200)
                for key in keys:
                    raw = self._redis.get(key)
                    if raw is None:
                        continue
                    try:
                        job = self._decode(raw)
                    except (ValueError, KeyError):
                        continue
                    if job.state is not JobState.RUNNING:
                        continue
                    job.state = JobState.FAILED
                    job.finished_at = time.time()
                    job.error = (
                        "the generation was interrupted by a service restart; "
                        "your existing versions are unchanged"
                    )
                    self._redis.setex(key, self._ttl_sec, self._encode(job))
                    with self._lock:
                        self._jobs[job.id] = job
                    failed += 1
                if cursor == 0:
                    break
        except Exception as error:
            # A recovery sweep that cannot run must not stop the service from
            # starting: the alternative is a container that crash-loops because
            # Redis was briefly slow.
            logger.error("could not sweep orphaned jobs: %s", error)

        return failed

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
            except _JobCancelled:
                job.state = JobState.CANCELLED
            except Exception as error:
                logger.exception("job %s failed", job.id)
                job.state = JobState.FAILED
                # The message, not the traceback: internals do not leave the
                # service (brief section 13).
                job.error = f"{type(error).__name__}: {error}"
            else:
                # A cancel can land after the pipeline's last checkpoint. Storing
                # the result then would have the service report `succeeded` for a
                # job it already acknowledged as cancelled -- and a client that
                # has moved on would be told its stopped generation finished.
                # The work is discarded rather than the acknowledgement.
                if self.store.is_cancelled(job.id):
                    logger.info(
                        "discarding a result for a cancelled job", extra={"jobId": job.id}
                    )
                    job.state = JobState.CANCELLED
                    job.result = None
                else:
                    job.result = result
                    job.state = JobState.SUCCEEDED
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
