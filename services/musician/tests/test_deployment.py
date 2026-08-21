"""Two deployment mistakes that only a real machine used to catch.

Both of these shipped. Both were invisible to every existing suite, because the
suites test the *code* and these are properties of how the code is packaged and
fetched. Both cost a user an afternoon on a clean Windows box.

They are cheap to assert and expensive to rediscover, so they are asserted here
rather than left to the next person to run `docker compose build`.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

#: Repository root: tests/ -> musician/ -> services/ -> root.
ROOT = Path(__file__).resolve().parents[3]

COMPOSE = ROOT / "compose.yaml"
VENDOR_BOOTSTRAPS = (
    ROOT / "scripts" / "vendor" / "bootstrap.sh",
    ROOT / "scripts" / "vendor" / "bootstrap.ps1",
)


def _compose_services() -> dict:
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]


def _copy_sources(dockerfile: Path) -> list[str]:
    """Every source path a ``COPY`` in this Dockerfile reads from the context.

    Deliberately simple. It does not need to understand every COPY form -- it
    needs to notice a path that climbs out of the build context, and those are
    written plainly.
    """
    sources: list[str] = []
    text = dockerfile.read_text(encoding="utf-8")
    # Join line continuations first, so a wrapped COPY is still one instruction.
    text = re.sub(r"\\\s*\n\s*", " ", text)
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.upper().startswith("COPY "):
            continue
        parts = stripped.split()[1:]
        # `--from=` copies from another build stage, not from the context.
        if any(part.startswith("--from=") for part in parts):
            continue
        parts = [part for part in parts if not part.startswith("--")]
        # The last argument is the destination inside the image.
        sources.extend(parts[:-1])
    return sources


class TestDockerfilesStayInsideTheirBuildContext:
    """A ``COPY`` whose source is outside the context can never succeed.

    The rwkv-worker image carried ``COPY vendor/rwkv.cpp /opt/rwkv.cpp`` while
    compose built it with ``context: ./services/musician``. ``vendor/`` is at the
    repository root, so Docker resolved the path against the context, found
    nothing, and failed with ``"/vendor/rwkv.cpp": not found`` -- on every single
    build, for anyone, forever.

    Nothing caught it because CI builds only the web image and the orchestrator;
    the model workers are built at deploy time. So the first machine to run
    ``docker compose build`` was the first to find out.
    """

    def test_every_compose_built_image_copies_only_from_its_own_context(self) -> None:
        """Two ways a COPY fails, and the second is the one that bit us.

        The obvious one is a path that climbs out with ``..``, which Docker
        refuses. The subtle one is a path that stays inside the context lexically
        and simply is not there -- ``vendor/rwkv.cpp`` under a context of
        ``services/musician`` looks perfectly local and resolves to a directory
        that does not exist, which is exactly why it read as "not found" rather
        than as "outside the context". So existence is what is checked; it
        subsumes the escape.
        """
        offenders: list[str] = []

        for name, service in _compose_services().items():
            build = service.get("build")
            if not isinstance(build, dict):
                continue
            context = (ROOT / build["context"]).resolve()
            dockerfile = context / build.get("dockerfile", "Dockerfile")
            if not dockerfile.exists():
                offenders.append(f"{name}: {dockerfile} does not exist")
                continue

            for source in _copy_sources(dockerfile):
                resolved = (context / source).resolve()
                try:
                    resolved.relative_to(context)
                except ValueError:
                    offenders.append(
                        f"{name}: COPY {source} escapes its build context "
                        f"({build['context']})"
                    )
                    continue
                # A glob is satisfied by any match; a plain path has to exist.
                if any(char in source for char in "*?["):
                    if not list(context.glob(source)):
                        offenders.append(f"{name}: COPY {source} matches nothing in the context")
                elif not resolved.exists():
                    offenders.append(
                        f"{name}: COPY {source} does not exist in the build context "
                        f"({build['context']}) -- docker will fail with "
                        f'"/{source}": not found'
                    )

        assert not offenders, "\n".join(offenders)

    def test_the_rwkv_worker_does_not_reach_for_the_root_vendor_tree(self) -> None:
        """The specific regression, named.

        The general check above would also catch a re-introduction, but only
        while the path stays spelled the same way. This one says what the mistake
        was, so a reviewer reading a future diff knows why the line is not there.

        rwkv.cpp is still reachable -- compose mounts ``./vendor`` read-only at
        runtime. What must not come back is a *build-time* dependency on it.
        """
        dockerfile = ROOT / "services/musician/rwkv-worker/Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        copies = [
            source
            for source in _copy_sources(dockerfile)
            if "vendor" in source or source.startswith("..")
        ]
        assert not copies, f"the image builds against the root vendor tree again: {copies}"
        assert "cmake --build" not in text, (
            "the mandatory rwkv.cpp CMake build is back. rwkv.cpp is a deferred "
            "optimisation for V1, not a startup dependency -- see "
            "docs/architecture/musician-runtime-adr.md"
        )


class TestTheRwkvImageCanActuallyRunTheV1Runtime:
    """An image that builds but cannot load the model is not a working image.

    The old Dockerfile installed the worker without its ``[pip]`` extra, so
    ``rwkv``, ``torch`` and ``tokenizers`` were simply absent. The container
    started, answered ``/health``, and failed every generation with "no RWKV
    runtime available" -- which reads like an outage rather than a packaging bug.
    """

    def test_the_runtime_extra_is_installed(self) -> None:
        text = (ROOT / "services/musician/rwkv-worker/Dockerfile").read_text(encoding="utf-8")
        assert "worker[pip]" in text, "the V1 runtime dependencies are not installed"

    def test_rwkv_v7_is_selected(self) -> None:
        """MIDI-RWKV is RWKV-7, and the package needs telling.

        The `rwkv` package's default class detects v4/v5/v6 only; ``RWKV_V7_ON``
        is the sole switch. Without it the weights load and the first call dies
        on ``'types.SimpleNamespace' object has no attribute 'n_head'``. It was
        set in the spike scripts and nowhere in the container.
        """
        text = (ROOT / "services/musician/rwkv-worker/Dockerfile").read_text(encoding="utf-8")
        assert "RWKV_V7_ON=1" in text

    def test_the_default_torch_wheel_is_the_cpu_one(self) -> None:
        # A CPU host must not pull a 2.4 GB CUDA build it cannot use, and for this
        # model the GPU is measurably slower anyway.
        text = (ROOT / "services/musician/rwkv-worker/Dockerfile").read_text(encoding="utf-8")
        assert "download.pytorch.org/whl/cpu" in text


class TestBootstrapNeedsNoSshKey:
    """Deployment must work for someone with no GitHub SSH key.

    MIDI-RWKV's ``.gitmodules`` points at three personal forks over
    ``git@github.com:``. The bootstrap used to rewrite those URLs to HTTPS and
    initialise one of them; on Windows the rewrite did not take and the script
    died with "Host key verification failed" partway through, leaving
    ``vendor/rwkv.cpp`` -- the *upstream* checkout, fetched later in the same
    loop -- missing entirely.

    None of those submodules is needed: the tokenizer inference actually reads is
    in the main tree, and the one submodule that looked useful is a personal fork
    of a repository this project already vendors from upstream.
    """

    @pytest.mark.parametrize("script", VENDOR_BOOTSTRAPS, ids=lambda p: p.name)
    def test_midi_rwkv_is_marked_as_taking_no_submodules(self, script: Path) -> None:
        """Checked by the mode it is given, not by scanning for a command.

        `submodule update --init --recursive` is *correct* for the upstream
        rwkv.cpp entry in the same loop -- its submodules are ordinary HTTPS
        remotes. So a blanket "no submodule init anywhere" rule would forbid the
        one place it belongs. The property that matters is narrower: MIDI-RWKV,
        and only MIDI-RWKV, must take none.
        """
        text = script.read_text(encoding="utf-8")
        entry = next(
            line for line in text.splitlines() if "christianazinn/MIDI-RWKV" in line
        )
        assert "none-by-design" in entry, (
            "MIDI-RWKV is fetching submodules again. Its .gitmodules is three "
            f"personal forks over SSH, and none is needed: {entry.strip()}"
        )

    @pytest.mark.parametrize("script", VENDOR_BOOTSTRAPS, ids=lambda p: p.name)
    def test_the_no_submodule_branch_really_runs_no_git_commands(self, script: Path) -> None:
        """And the branch it selects has to be empty of fetching, not just named that."""
        commands = [
            line
            for line in script.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith(("#", "//"))
        ]
        start = next(i for i, line in enumerate(commands) if "none-by-design" in line and "|" not in line and "Recurse" not in line)
        # Until the branch closes: `;;` in sh, `}` at the same nesting in ps1.
        branch: list[str] = []
        for line in commands[start + 1 :]:
            if line.strip() in (";;", "}"):
                break
            branch.append(line)
        offending = [line for line in branch if "git " in line]
        assert not offending, (
            f"the MIDI-RWKV branch runs git again: {offending}"
        )

    @pytest.mark.parametrize("script", VENDOR_BOOTSTRAPS, ids=lambda p: p.name)
    def test_every_repository_is_fetched_over_https(self, script: Path) -> None:
        commands = [
            line
            for line in script.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith(("#", "//"))
        ]
        assert not [line for line in commands if "git@github.com" in line], (
            "an SSH remote is back in the vendor bootstrap; anonymous clones cannot use one"
        )
        joined = "\n".join(commands)
        assert "https://github.com/RWKV/rwkv.cpp" in joined, (
            "upstream rwkv.cpp is no longer vendored; the deferred GGML path has "
            "nothing to build from"
        )
