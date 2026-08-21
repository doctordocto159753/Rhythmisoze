"""Structured logs and metrics.

## The one rule that matters

**User MIDI is never logged by default.** Note data is the user's music, and a
log line is the easiest place for it to leak into a system nobody audited. Logs
carry identifiers, counts and timings; if the notes themselves are needed to
debug something, that is a deliberate, temporary act with
``MUSICIAN_LOG_NOTES=1``, not the default.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from contextvars import ContextVar
from typing import Any

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

_RESERVED = {
    "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
    "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
    "pathname", "process", "processName", "relativeCreated", "stack_info",
    "thread", "threadName", "taskName",
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": round(record.created, 3),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "requestId": request_id_var.get(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(getattr(logging, level.upper(), logging.INFO))


def notes_may_be_logged() -> bool:
    return os.environ.get("MUSICIAN_LOG_NOTES", "").strip() == "1"


class Metrics:
    """Small in-process counters.

    Not Prometheus. The service runs one or two instances; a scrape endpoint
    returning JSON is enough, and adding a metrics library to get four counters
    would be more dependency than signal.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._enqueued = 0
        self._inferences = 0
        self._inference_seconds = 0.0
        self._slowest_seconds = 0.0
        self._candidates = 0
        self._rejected = 0
        self._started = time.time()

    def observe_enqueued(self) -> None:
        with self._lock:
            self._enqueued += 1

    def observe_inference(self, seconds: float) -> None:
        with self._lock:
            self._inferences += 1
            self._inference_seconds += seconds
            self._slowest_seconds = max(self._slowest_seconds, seconds)

    def observe_rejection(self, rejected: int, total: int) -> None:
        with self._lock:
            self._rejected += rejected
            self._candidates += total

    def snapshot(self, *, queue_depth: int) -> dict[str, Any]:
        with self._lock:
            mean = self._inference_seconds / self._inferences if self._inferences else 0.0
            rate = self._rejected / self._candidates if self._candidates else 0.0
            return {
                "uptimeSec": round(time.time() - self._started, 1),
                "queueDepth": queue_depth,
                "jobsEnqueued": self._enqueued,
                "inferences": self._inferences,
                "inferenceMeanSec": round(mean, 4),
                "inferenceSlowestSec": round(self._slowest_seconds, 4),
                "candidatesEvaluated": self._candidates,
                "candidateRejectionRate": round(rate, 4),
            }
