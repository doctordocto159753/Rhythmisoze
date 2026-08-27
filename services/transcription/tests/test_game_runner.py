"""The MKLDNN crash, as an assertion.

Every real `POST /witness` on the CPU-only deployment host returned 502, because
GAME's inference died with `Floating point exception (core dumped)` — SIGFPE
from native code, which no Python handler can catch. Isolation on that host:

    plain torch CPU scaled_dot_product_attention   finite output, exit 0
    GAME, MKLDNN on,  4 threads                    Floating point exception
    GAME, MKLDNN on,  1 thread                     Floating point exception
    GAME, MKLDNN off, 1 thread                     success
    GAME, MKLDNN off, 4 threads                    success

The fault is the oneDNN/MKLDNN CPU path, and it is not threading. These tests
pin both halves of that, because the tempting wrong fix — pinning the child to
one thread — also makes the symptom disappear, and would cost every real request
most of its speed while leaving the cause unexplained.

None of this runs the model. The fix is a decision about a backend flag, so the
tests assert the decision, its timing, and its blast radius.
"""

from __future__ import annotations

import importlib

import pytest


def _load(monkeypatch: pytest.MonkeyPatch, calls: list[bool] | None = None):
    """Imports the runner with `runpy.run_path` replaced.

    The replacement records the MKLDNN flag *at the moment upstream would have
    been invoked*, which is the property that matters: setting the flag after
    dispatch would be indistinguishable from setting it correctly if the test
    only inspected the end state.
    """
    module = importlib.import_module("transcription_service.game_runner")
    torch = importlib.import_module("torch")

    def fake_run_path(path: str, run_name: str | None = None):
        if calls is not None:
            calls.append(torch.backends.mkldnn.enabled)
        fake_run_path.path = path
        fake_run_path.run_name = run_name

    fake_run_path.path = None
    fake_run_path.run_name = None
    monkeypatch.setattr(module.runpy, "run_path", fake_run_path)
    return module, fake_run_path


class TestCpuHost:
    """The deployment host: no CUDA, MKLDNN on by default."""

    def test_disables_mkldnn(self, torch_stub, monkeypatch: pytest.MonkeyPatch) -> None:
        torch = torch_stub(cuda_available=False)
        assert torch.backends.mkldnn.enabled is True

        module, _ = _load(monkeypatch)
        module.main()

        assert torch.backends.mkldnn.enabled is False

    def test_disables_it_before_invoking_upstream(
        self, torch_stub, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The flag has to be off at dispatch time, not merely off afterwards.
        torch_stub(cuda_available=False)
        seen: list[bool] = []
        module, _ = _load(monkeypatch, seen)
        module.main()

        assert seen == [False]

    def test_still_runs_upstreams_own_entry_point(
        self, torch_stub, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The pinned checkout's script, as `__main__`, so its Click command
        # parses the arguments the adapter passed through.
        torch_stub(cuda_available=False)
        module, run_path = _load(monkeypatch)
        module.main()

        assert run_path.path == "infer.py"
        assert run_path.run_name == "__main__"

    def test_changes_nothing_else_about_torch(
        self, torch_stub, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Specifically: it does not pin the thread count. MKLDNN off with four
        # threads was measured working, so throttling the child would be a
        # performance cost with no evidence behind it.
        torch = torch_stub(cuda_available=False)
        module, _ = _load(monkeypatch)
        module.main()

        assert not hasattr(torch, "set_num_threads_called")
        assert vars(torch).keys() == {"cuda", "backends", "manual_seed_calls"}

    def test_does_not_seed_by_default(
        self, torch_stub, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Upstream's CLI seeds nothing, and GAME's segmenter samples: every D3PM
        # step draws `torch.rand_like`. Seeding to a fixed value does not make
        # that draw better, it makes it one particular draw taken from a
        # generator state no standalone run ever had. The service exists to
        # reproduce the standalone result, so by default it does not seed.
        torch = torch_stub(cuda_available=False)
        monkeypatch.delenv("GAME_RANDOM_SEED", raising=False)
        module, _ = _load(monkeypatch)
        module.main()

        assert torch.manual_seed_calls == []

    def test_treats_an_empty_seed_as_unset(
        self, torch_stub, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # So a compose file can declare the variable without pinning the
        # sampler, which is exactly how it is declared.
        torch = torch_stub(cuda_available=False)
        monkeypatch.setenv("GAME_RANDOM_SEED", "")
        module, _ = _load(monkeypatch)
        module.main()

        assert torch.manual_seed_calls == []

    def test_seeds_when_an_operator_asks(
        self, torch_stub, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Opt-in, for comparing two builds with the sampling held still.
        torch = torch_stub(cuda_available=False)
        monkeypatch.setenv("GAME_RANDOM_SEED", "17")
        module, _ = _load(monkeypatch)
        module.main()

        assert torch.manual_seed_calls == [17]


class TestCudaHost:
    """A host with a GPU, where the CPU path is not what executes."""

    def test_leaves_mkldnn_alone(self, torch_stub, monkeypatch: pytest.MonkeyPatch) -> None:
        torch = torch_stub(cuda_available=True)
        module, _ = _load(monkeypatch)
        module.main()

        # Disabling a backend that is not the one running would be a change with
        # no evidence behind it, on hardware this crash was never observed on.
        assert torch.backends.mkldnn.enabled is True

    def test_still_invokes_upstream(self, torch_stub, monkeypatch: pytest.MonkeyPatch) -> None:
        torch_stub(cuda_available=True)
        seen: list[bool] = []
        module, run_path = _load(monkeypatch, seen)
        module.main()

        assert seen == [True]
        assert run_path.path == "infer.py"


class TestThePolicyOnItsOwn:
    """The rule, stated once, so it can be read without the wiring."""

    @pytest.mark.parametrize(
        ("cuda_available", "expected"),
        [(False, True), (True, False)],
    )
    def test_disables_exactly_when_the_cpu_path_will_run(
        self, torch_stub, monkeypatch: pytest.MonkeyPatch, cuda_available: bool, expected: bool
    ) -> None:
        torch_stub(cuda_available=cuda_available)
        module, _ = _load(monkeypatch)

        assert module.should_disable_mkldnn(cuda_available=cuda_available) is expected
