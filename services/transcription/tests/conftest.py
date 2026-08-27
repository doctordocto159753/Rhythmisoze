"""Test fixtures for the register-witness service.

The one interesting thing here is the torch stub. `game_runner` imports torch
at module scope, because it has to — it sets a torch backend flag before the
model is dispatched. Installing the real thing to assert which flag it sets
would put a 700 MB CUDA-less wheel into every test run to check two booleans,
and this repository's standing position is that normal CI never downloads a
model runtime.

So the tests substitute a stub that records what was set. That is enough to
assert the whole of the fix — *which* flag, *when*, and *under what condition*
— because the fix is a decision, not a computation.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
SRC = SERVICE_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


@dataclass
class StubBackendsMkldnn:
    enabled: bool = True


@dataclass
class StubBackends:
    mkldnn: StubBackendsMkldnn = field(default_factory=StubBackendsMkldnn)


@dataclass
class StubCuda:
    available: bool

    def is_available(self) -> bool:
        return self.available


class StubTorch:
    """Just enough torch to observe the two things `game_runner` touches."""

    def __init__(self, *, cuda_available: bool) -> None:
        self.cuda = StubCuda(available=cuda_available)
        self.backends = StubBackends()
        self.manual_seed_calls: list[int] = []

    def manual_seed(self, seed: int) -> None:
        self.manual_seed_calls.append(seed)


@pytest.fixture
def torch_stub(monkeypatch: pytest.MonkeyPatch):
    """Installs a stub `torch` and gives back a factory for one.

    Returns a callable so a test chooses whether this host has CUDA. The real
    module is put back by monkeypatch, and `game_runner` is dropped from the
    module cache on both sides so each test imports it against its own stub.
    """

    def install(*, cuda_available: bool) -> StubTorch:
        stub = StubTorch(cuda_available=cuda_available)
        monkeypatch.setitem(sys.modules, "torch", stub)
        monkeypatch.delitem(sys.modules, "transcription_service.game_runner", raising=False)
        return stub

    yield install
    sys.modules.pop("transcription_service.game_runner", None)
