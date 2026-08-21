"""Runtime configuration.

Everything here has a default that works on a laptop with no GPU, no Redis and
no model weights, because that is the configuration a person will have the first
time they clone this. Production differs by environment variables, not by code
paths.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum


class Device(str, Enum):
    AUTO = "auto"
    CPU = "cpu"
    CUDA = "cuda"


class AdapterMode(str, Enum):
    #: Deterministic stand-ins. What normal CI runs (AC-09).
    FAKE = "fake"
    #: HTTP calls to the worker containers.
    REAL = "real"


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    device: Device
    adapter_mode: AdapterMode

    melodyt5_url: str
    rwkv_url: str
    worker_timeout_sec: float

    redis_url: str | None
    queue_name: str

    #: Model workers are single-threaded per weight copy. Raising this beyond
    #: the number of loaded copies queues work inside the worker instead of
    #: outside it, where it is invisible.
    melody_concurrency: int
    rwkv_concurrency: int

    job_ttl_sec: int
    generation_timeout_sec: int

    #: How many jobs may be waiting before the service starts refusing.
    #:
    #: The queue was unbounded. One worker thread generates one job at a time and
    #: a job is minutes of model inference, so a hundred queued jobs is hours of
    #: backlog -- every one of them holding a full note payload in memory, and
    #: every client polling a position that will not move before its own timeout
    #: fires. The user experience of an unbounded queue is not "eventually"; it is
    #: a spinner that ends in a timeout, after the service has spent the memory
    #: anyway.
    #:
    #: Sixteen is roughly an hour of backlog at the measured Expanded latency,
    #: which is far past any wait a person will sit through and still leaves room
    #: for a burst. Refusing past it returns 503 with Retry-After, which the client
    #: already handles as a recoverable state.
    max_queue_depth: int
    log_level: str

    @staticmethod
    def from_env() -> Settings:
        redis_url = _env("MUSICIAN_REDIS_URL", "")
        return Settings(
            device=Device(_env("MUSICIAN_DEVICE", Device.AUTO.value)),
            adapter_mode=AdapterMode(_env("MUSICIAN_ADAPTERS", AdapterMode.FAKE.value)),
            melodyt5_url=_env("MUSICIAN_MELODYT5_URL", "http://melodyt5-worker:8081"),
            rwkv_url=_env("MUSICIAN_RWKV_URL", "http://rwkv-worker:8082"),
            worker_timeout_sec=float(_env("MUSICIAN_WORKER_TIMEOUT_SEC", "120")),
            # No Redis configured means the in-memory queue, which is correct
            # for a laptop and explicitly wrong for production -- /ready says so.
            redis_url=redis_url or None,
            queue_name=_env("MUSICIAN_QUEUE_NAME", "musician:jobs"),
            melody_concurrency=_env_int("MUSICIAN_MELODY_CONCURRENCY", 1),
            rwkv_concurrency=_env_int("MUSICIAN_RWKV_CONCURRENCY", 1),
            job_ttl_sec=_env_int("MUSICIAN_JOB_TTL_SEC", 3600),
            generation_timeout_sec=_env_int("MUSICIAN_GENERATION_TIMEOUT_SEC", 300),
            max_queue_depth=_env_int("MUSICIAN_MAX_QUEUE_DEPTH", 16),
            log_level=_env("MUSICIAN_LOG_LEVEL", "INFO"),
        )
