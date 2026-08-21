"""Choosing between the fakes and the real workers.

One function, one decision, made from configuration. The pipeline never asks
which it got -- that is the whole point of the adapter seam, and the reason the
orchestration tests are honest despite running without weights.
"""

from __future__ import annotations

import logging

from musician_shared.adapters.base import MelodyModelAdapter, RwkvModelAdapter
from musician_shared.adapters.fake import FakeMelodyAdapter, FakeRwkvAdapter

from .config import AdapterMode, Settings

logger = logging.getLogger(__name__)


def build_adapters(settings: Settings) -> tuple[MelodyModelAdapter, RwkvModelAdapter]:
    if settings.adapter_mode is AdapterMode.FAKE:
        logger.info("using deterministic fake adapters; no model weights required")
        return FakeMelodyAdapter(), FakeRwkvAdapter()

    # Imported lazily: httpx is a dependency of the real path only, so a
    # fake-mode install stays small and CI never needs it.
    from .worker_clients import HttpMelodyAdapter, HttpRwkvAdapter

    logger.info(
        "using real model workers",
        extra={"melodyT5": settings.melodyt5_url, "midiRwkv": settings.rwkv_url},
    )
    return (
        HttpMelodyAdapter(base_url=settings.melodyt5_url, timeout=settings.worker_timeout_sec),
        HttpRwkvAdapter(base_url=settings.rwkv_url, timeout=settings.worker_timeout_sec),
    )
