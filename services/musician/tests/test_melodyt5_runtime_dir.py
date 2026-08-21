"""MelodyT5 must load with its vendored source read-only.

## The regression

The worker wrote upstream's `random_model` constructor scaffold into the vendored
tree. Locally that tree is a writable git checkout, so every test passed and the
real-model verification passed too. In the real topology `compose.yaml` mounts
`./vendor:/vendor:ro` -- correctly, because vendored source pinned at a SHA is an
immutable input -- and the container crash-looped on startup with:

    OSError: [Errno 30] Read-only file system: '/vendor/melodyt5/random_model'

The bug was ownership, not permissions. `random_model` is neither upstream source
nor a model artifact: it is a randomly-initialised GPT-2 that exists only because
`PatchLevelEnDecoder` calls `from_encoder_decoder_pretrained("random_model", ...)`
with a path relative to the working directory, and every parameter in it is
overwritten by the real checkpoint moments later.

## What is asserted here

These tests do not need the 1.36 GB checkpoint, and deliberately so -- the
failure was in *where a file is written*, which is decidable without loading a
model. The opt-in `tests/test_real_models.py` covers loading; this covers the
invariant that made loading impossible in production.
"""

from __future__ import annotations

import os
import stat
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = ROOT / "services" / "musician" / "melodyt5-worker" / "src"
VENDOR_SOURCE = ROOT / "vendor" / "melodyt5"

if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))


def _inference(monkeypatch, runtime_dir: Path):
    """Import the worker with `MUSICIAN_RUNTIME_DIR` pointed at `runtime_dir`.

    Reloaded rather than imported once, because `RUNTIME_DIR` is resolved at
    module scope -- which is the point: the path is fixed by the environment the
    process started in, not chosen per call.
    """
    import importlib

    monkeypatch.setenv("MUSICIAN_RUNTIME_DIR", str(runtime_dir))
    module = importlib.import_module("melodyt5_worker.inference")
    return importlib.reload(module)


class TestTheRuntimeDirectoryIsSeparateFromTheVendoredSource:
    def test_the_runtime_directory_follows_the_environment(self, tmp_path, monkeypatch) -> None:
        inference = _inference(monkeypatch, tmp_path / "runtime")
        assert inference.RUNTIME_DIR == tmp_path / "runtime"

    def test_it_defaults_somewhere_writable_rather_than_into_vendor(self, monkeypatch) -> None:
        """The default has to be safe, because the default is what local runs get.

        A default under the vendored tree would reintroduce the bug for anyone
        who did not set the variable -- which is exactly how it shipped.
        """
        import importlib

        monkeypatch.delenv("MUSICIAN_RUNTIME_DIR", raising=False)
        inference = importlib.reload(importlib.import_module("melodyt5_worker.inference"))
        assert inference.VENDOR_DIR not in inference.RUNTIME_DIR.parents
        assert inference.MODEL_DIR not in inference.RUNTIME_DIR.parents

    def test_an_unwritable_runtime_directory_is_refused_by_name(self, tmp_path, monkeypatch) -> None:
        """A readable refusal, not an Errno 30 from three frames deeper.

        The original failure named `/vendor/melodyt5/random_model` -- a path
        nobody had configured, in a message that pointed at upstream rather than
        at the setting to change.
        """
        blocked = tmp_path / "blocked"
        blocked.mkdir()
        blocked.chmod(stat.S_IRUSR | stat.S_IXUSR)
        inference = _inference(monkeypatch, blocked / "runtime")

        if os.name == "nt" or os.access(blocked, os.W_OK):
            # Windows ignores the mode bits, and root ignores them everywhere.
            # Asserting a permission the platform does not enforce would be
            # asserting nothing, so the message itself is checked instead.
            pytest.skip("this filesystem does not enforce the directory mode")

        with pytest.raises(inference.ModelNotLoaded) as raised:
            inference._ensure_runtime_dir()
        message = str(raised.value)
        assert "MUSICIAN_RUNTIME_DIR" in message
        assert "read-only by design" in message


class TestTheScaffoldIsWrittenOnlyToTheRuntimeDirectory:
    """Run with stubs, deliberately, so they run *everywhere*.

    The first version of these tests needed real `transformers` and the real
    vendored source, and skipped without them -- which meant the four assertions
    that prove the fix did not execute in CI at all. That is the same shape as
    the bug: an invariant verified only in the one environment where it could not
    fail.

    Nothing about the invariant needs a real model. `_ensure_random_model` decides
    *where* to write; a stub that records the directory it was handed answers that
    completely, and answers it on any machine.
    """

    @pytest.fixture
    def stubbed(self, monkeypatch, tmp_path):
        """A fake upstream tree, a fake `config`, and a fake GPT-2."""
        vendor = tmp_path / "vendor"
        source = vendor / "melodyt5"
        source.mkdir(parents=True)
        (source / "utils.py").write_text("", encoding="utf-8")
        (source / "config.py").write_text(
            "PATCH_NUM_LAYERS = 9\nPATCH_LENGTH = 256\n", encoding="utf-8"
        )
        # A file with content, so a rewrite of the tree changes the fingerprint.
        (source / "README.md").write_text("upstream, pinned\n", encoding="utf-8")

        written: list[Path] = []

        class FakeGPT2Model:
            def __init__(self, _config) -> None:
                pass

            def save_pretrained(self, target: str) -> None:
                path = Path(target)
                path.mkdir(parents=True, exist_ok=True)
                (path / "config.json").write_text("{}", encoding="utf-8")
                written.append(path)

        fake = types.ModuleType("transformers")
        fake.GPT2Config = lambda **kwargs: kwargs
        fake.GPT2Model = FakeGPT2Model
        monkeypatch.setitem(sys.modules, "transformers", fake)

        upstream_config = types.ModuleType("config")
        upstream_config.PATCH_NUM_LAYERS = 9
        upstream_config.PATCH_LENGTH = 256
        monkeypatch.setitem(sys.modules, "config", upstream_config)

        monkeypatch.setenv("MUSICIAN_VENDOR_DIR", str(vendor))
        runtime = tmp_path / "runtime"
        inference = _inference(monkeypatch, runtime)
        inference._ensure_runtime_dir()
        return inference, runtime, source, written

    def _fingerprint(self, tree: Path) -> set[tuple[str, int]]:
        """Every file under `tree`, by relative path and size.

        Enough to catch a file added, removed or rewritten, and cheap enough to
        run over a source checkout.
        """
        return {
            (str(path.relative_to(tree)), path.stat().st_size)
            for path in tree.rglob("*")
            if path.is_file() and ".git" not in path.parts
        }

    def test_the_scaffold_lands_in_the_runtime_directory(self, stubbed) -> None:
        inference, runtime, _source, written = stubbed
        inference._ensure_random_model(runtime)

        assert (runtime / "random_model" / "config.json").exists()
        assert written == [runtime / "random_model"]

    def test_the_vendored_tree_is_not_mutated(self, stubbed) -> None:
        """The invariant the read-only mount encodes, checked without a mount.

        A test that only looked for `random_model` under vendor would miss a
        future write to some other path in the same tree, so this compares the
        whole tree before and after.
        """
        inference, runtime, source, _written = stubbed
        before = self._fingerprint(source)

        inference._ensure_random_model(runtime)

        assert self._fingerprint(source) == before, (
            "the vendored MelodyT5 source was modified; it is mounted read-only "
            "in production and this would crash-loop the container"
        )
        assert not (source / "random_model").exists()

    def test_it_works_when_the_vendored_tree_really_is_read_only(self, stubbed) -> None:
        """The production topology, reproduced rather than reasoned about.

        This is the test that would have caught the original bug. It is also the
        one most likely to be quietly defeated by a permissive filesystem, so it
        verifies that the mode took effect before trusting the result.
        """
        inference, runtime, source, _written = stubbed
        for path in sorted(source.rglob("*"), reverse=True):
            path.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        source.chmod(stat.S_IRUSR | stat.S_IXUSR)
        try:
            if os.access(source, os.W_OK):
                pytest.skip("this filesystem does not enforce the directory mode")
            inference._ensure_random_model(runtime)
            assert (runtime / "random_model" / "config.json").exists()
        finally:
            source.chmod(stat.S_IRWXU)
            for path in source.rglob("*"):
                path.chmod(stat.S_IRUSR | stat.S_IWUSR)

    def test_a_second_load_reuses_the_scaffold_rather_than_rebuilding_it(self, stubbed) -> None:
        """Idempotent, because the worker reloads on every restart.

        Rebuilding would be correct but wasteful; failing on the second call
        would turn a restart into an outage.
        """
        inference, runtime, _source, written = stubbed
        inference._ensure_random_model(runtime)
        inference._ensure_random_model(runtime)
        assert len(written) == 1, "the scaffold was rebuilt unnecessarily"

    def test_the_scaffold_is_recreated_if_it_is_lost(self, stubbed) -> None:
        """`/tmp` is not durable, and the worker must survive losing it."""
        import shutil

        inference, runtime, _source, written = stubbed
        inference._ensure_random_model(runtime)
        shutil.rmtree(runtime / "random_model")
        inference._ensure_random_model(runtime)

        assert (runtime / "random_model" / "config.json").exists()
        assert len(written) == 2


class TestTheDeploymentKeepsTheImmutableMounts:
    """The other half: the code stays out of `/vendor` *and* `/vendor` stays `:ro`.

    Fixing one without the other would leave the invariant one careless edit from
    being lost -- and losing it is silent, because a writable mount makes the old
    code work again.
    """

    def _compose(self) -> dict:
        import yaml

        return yaml.safe_load((ROOT / "compose.yaml").read_text(encoding="utf-8"))["services"]

    @pytest.mark.parametrize("service", ["melodyt5-worker", "rwkv-worker"])
    def test_models_and_vendor_are_mounted_read_only(self, service: str) -> None:
        volumes = self._compose()[service].get("volumes", [])
        mounted = {entry.split(":")[1]: entry for entry in volumes if entry.count(":") >= 2}
        for path in ("/models", "/vendor"):
            if path in mounted:
                assert mounted[path].endswith(":ro"), (
                    f"{service} mounts {path} writable; it is an immutable input"
                )

    def test_the_melodyt5_image_names_a_writable_runtime_directory(self) -> None:
        text = (
            ROOT / "services/musician/melodyt5-worker/Dockerfile"
        ).read_text(encoding="utf-8")
        assert "MUSICIAN_RUNTIME_DIR" in text, (
            "the image does not set a runtime directory, so the worker falls back "
            "to a default that may not be where the deployment expects"
        )
        for immutable in ("MUSICIAN_RUNTIME_DIR=/vendor", "MUSICIAN_RUNTIME_DIR=/models"):
            assert immutable not in text
