"""MelodyT5 inference, using the real upstream architecture.

## The mistake this file exists to correct

An earlier version of this worker loaded the checkpoint with
``AutoTokenizer`` + ``T5ForConditionalGeneration.from_pretrained()``. That is
wrong, and not subtly: **MelodyT5 is not a HuggingFace T5.** Despite the name it
is a bespoke *bar-patching* hierarchical model, and the published `weights.pth`
is a raw ``torch.save`` checkpoint, not a `from_pretrained` directory. The old
path could not have loaded the weights at all, and if it somehow had, it would
have been a different model.

The real architecture, from `sanderwood/melodyt5` at the pinned revision:

* **Patchilizer** — splits an ABC body on barline delimiters, and encodes each
  bar as a fixed 64-byte *patch* of raw character codepoints, bracketed by
  BOS/EOS. Headers (`L:`, `M:`, `K:`, `%%…`) each become their own patch.
* **PatchLevelEnDecoder** — a GPT-2 encoder/decoder over patch embeddings
  (`Linear(PATCH_SIZE * 128, n_embd)` over one-hot bytes), 9 layers, weights
  tied between encoder and decoder.
* **CharLevelDecoder** — a 3-layer GPT-2 that generates the characters *inside*
  one bar, conditioned on the last encoded patch.
* Generation is therefore **two-level and iterative**: one model call produces
  one bar, which is appended to the decoder patches, and the loop repeats.

None of that is reachable through the generic T5 API, which is why this module
imports the upstream classes rather than reimplementing them. Reimplementation
would be a second definition of a model we do not own, and the first time
upstream changed a detail we would be running something subtly different while
believing otherwise.

## The task prompt is a real format, not a convention

Upstream reads a file shaped like::

    %%input
    %%variation
    L:1/8
    M:6/8
    K:D
    |: AFD DFA | ... :|
    %%output
    <optional seed for the decoder>

and derives the task from ``input_abc.split("\\n")[0][2:]`` — the first line of
the input section, minus the leading ``%%``. So the literal string
``%%variation`` is load-bearing: drop it and ``task`` becomes whatever the first
header happens to be.

## Sampling

Upstream defaults are ``top_p=0.8``, ``top_k=8``, ``temperature=2.6``. That
temperature looks extreme only if you assume it scales token logits of a normal
LM — here it is applied to *character* probabilities inside a bar, after top-p
and top-k have already cut the tail. Our policy temperatures are expressed on
this model's own scale for that reason, and are documented where they are set.
"""

from __future__ import annotations

import logging
import os
import re
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

from musician_shared.abc import from_abc, to_abc
from musician_shared.contract import Key, Meter, Mode, Note

logger = logging.getLogger(__name__)

#: GPT-2 causal-mask buffers, which older transformers saved and newer ones do
#: not declare. See `_load_locked` for why dropping them is safe.
_MASK_BUFFER = re.compile(r"\.(attn|crossattention)\.(bias|masked_bias)$")

MODEL_DIR = Path(os.environ.get("MUSICIAN_MODELS_DIR", "/models"))
VENDOR_DIR = Path(os.environ.get("MUSICIAN_VENDOR_DIR", "/vendor"))
MELODYT5_WEIGHTS = MODEL_DIR / "melodyt5" / "weights.pth"


def _default_runtime_dir() -> Path:
    """Where this worker is allowed to write.

    ``tempfile.gettempdir()`` rather than a literal ``/tmp`` so the same code
    runs on a Windows checkout, where the container's path does not exist. The
    Dockerfile sets ``MUSICIAN_RUNTIME_DIR`` explicitly, so the default is what
    local development and the test suite get.
    """
    return Path(tempfile.gettempdir()) / "rhythmisoze-melodyt5"


#: The one writable directory this worker owns.
#:
#: ## Why this exists
#:
#: `/vendor` and `/models` are mounted read-only, deliberately: vendored upstream
#: source pinned at a SHA and a 1.36 GB checkpoint are both immutable inputs, and
#: a worker that can rewrite either of them can silently stop running the thing
#: it claims to run.
#:
#: But loading MelodyT5 requires writing something. `PatchLevelEnDecoder` calls
#: ``EncoderDecoderModel.from_encoder_decoder_pretrained("random_model", ...)``
#: -- a *relative* path -- so a randomly-initialised GPT-2 has to exist on disk
#: before construction. We were creating it inside the vendored tree, which
#: worked in a writable local checkout and failed in the real topology with
#: ``OSError: [Errno 30] Read-only file system: '/vendor/melodyt5/random_model'``,
#: restart-looping the container.
#:
#: The scaffold is neither vendored source nor a model artifact: every parameter
#: in it is overwritten by the checkpoint moments later. It is constructor
#: scaffolding, so it belongs where runtime state belongs.
RUNTIME_DIR = Path(os.environ.get("MUSICIAN_RUNTIME_DIR", "")) or _default_runtime_dir()

#: Upstream's own defaults, from `inference.py`. Kept as the neutral centre that
#: the Refined and Developed policies move away from.
DEFAULT_TOP_P = 0.8
DEFAULT_TOP_K = 8
DEFAULT_TEMPERATURE = 2.6

#: Generation stops at this many bars. Upstream's default is 128 patches for a
#: whole tune; our inputs are short phrases, and letting a variation run to 128
#: bars would produce something no identity guard could relate to the original.
DEFAULT_MAX_PATCH = 64


class ModelNotLoaded(RuntimeError):
    pass


@dataclass
class RuntimeInfo:
    revision: str
    torch_version: str
    transformers_version: str
    device: str
    python_version: str
    architecture: str


def _ensure_upstream_importable() -> Path:
    """Put the vendored upstream tree on `sys.path`.

    The upstream modules do `from config import *` and `from utils import *`,
    i.e. flat top-level imports. They therefore have to be imported with their
    own directory *on* the path rather than as a package, which is why this is a
    path manipulation and not an ordinary import.
    """
    candidates = [
        VENDOR_DIR / "melodyt5",
        Path(__file__).resolve().parents[4] / "vendor" / "melodyt5",
        Path.cwd() / "vendor" / "melodyt5",
    ]
    for candidate in candidates:
        if (candidate / "utils.py").exists() and (candidate / "config.py").exists():
            if str(candidate) not in sys.path:
                sys.path.insert(0, str(candidate))
            return candidate
    raise ModelNotLoaded(
        "the MelodyT5 upstream source is not vendored. Run scripts/vendor/bootstrap.sh "
        f"(looked in: {', '.join(str(c) for c in candidates)})"
    )


def _patch_samplings_for_modern_numpy() -> None:
    """Renormalise before `np.random.choice`, which modern numpy requires.

    Upstream samples through the `samplings` package, whose `random_sampling`
    ends in `np.random.choice(p=probs)`. numpy checks `abs(sum(p) - 1) < ~1e-8`,
    and after top-p, top-k and temperature have each rescaled a float32 vector
    the sum lands a few ULPs off -- so generation dies with "probabilities do
    not sum to 1" on the first bar.

    The distribution is correct; only its float32 sum is not exactly 1. Casting
    to float64 and dividing by the sum changes no sampling semantics, it is the
    normalisation the maths already assumes. Patched here rather than by editing
    the vendored package, so upstream stays pristine and the deviation lives in
    our source.
    """
    import numpy as np  # noqa: PLC0415
    import samplings  # noqa: PLC0415

    if getattr(samplings, "_rhythmisoze_patched", False):
        return

    def safe_random_sampling(probs, seed=None):
        array = np.asarray(probs, dtype=np.float64)
        total = array.sum()
        array = np.ones_like(array) / array.size if total <= 0 else array / total
        if seed is not None:
            np.random.seed(seed)
        return int(np.random.choice(array.size, p=array))

    samplings.random_sampling = safe_random_sampling
    samplings._rhythmisoze_patched = True
    logger.info("patched samplings.random_sampling for modern numpy strictness")


def _ensure_runtime_dir() -> Path:
    """The writable directory, created on demand and checked rather than assumed.

    Failing here with a readable message beats failing three frames deeper inside
    ``save_pretrained`` with an ``Errno 30`` that names a path nobody chose.
    """
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        probe = RUNTIME_DIR / ".writable"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
    except OSError as error:
        raise ModelNotLoaded(
            f"the MelodyT5 runtime directory {RUNTIME_DIR} is not writable ({error}). "
            f"It holds constructor scaffolding, not model data -- set "
            f"MUSICIAN_RUNTIME_DIR to a writable path. Do not point it at /vendor "
            f"or /models, which are read-only by design."
        ) from error
    return RUNTIME_DIR


def _ensure_random_model(runtime_dir: Path) -> None:
    """Create the `random_model` directory upstream expects.

    `PatchLevelEnDecoder` builds its base with
    ``EncoderDecoderModel.from_encoder_decoder_pretrained("random_model", ...)``,
    which needs a randomly-initialised GPT-2 on disk *relative to the working
    directory*. Upstream ships `random_model.py` to create it and raises a
    readable error if you forget.

    The weights it contains are overwritten wholesale by the checkpoint a moment
    later, so this is scaffolding for the constructor rather than anything that
    influences output.

    **It is written to the runtime directory, never to the vendored tree.** It
    used to go into `source_dir`, which is `/vendor/melodyt5` in the real
    topology and read-only there -- so the container crash-looped on startup with
    ``Errno 30`` while every local test passed, because a local checkout is
    writable. Ownership, not permissions, was the bug: this is runtime state and
    was living in an immutable input.
    """
    target = runtime_dir / "random_model"
    if (target / "config.json").exists():
        return

    from transformers import GPT2Config, GPT2Model  # noqa: PLC0415

    import config as upstream_config  # noqa: PLC0415

    logger.info("creating the random_model scaffold upstream requires")
    patch_config = GPT2Config(
        num_hidden_layers=upstream_config.PATCH_NUM_LAYERS,
        max_length=upstream_config.PATCH_LENGTH,
        max_position_embeddings=upstream_config.PATCH_LENGTH,
        vocab_size=1,
    )
    GPT2Model(patch_config).save_pretrained(str(target))


def build_prompt(
    notes: tuple[Note, ...],
    *,
    meter: Meter,
    tempo_bpm: float,
    key: Key | None,
    task: str = "variation",
) -> tuple[str, str]:
    """Build the upstream `%%input` / `%%output` prompt.

    Returns ``(input_abc, decoder_prompt)``. The decoder prompt carries the
    headers only: giving the model the metre and key it must write in, and
    letting it choose every note, is what "variation" means. Seeding it with
    notes would make it a continuation of our own material instead.
    """
    document = to_abc(notes, meter=meter, tempo_bpm=tempo_bpm, key=key)
    header_lines = [
        line
        for line in document.text.splitlines()
        # X: and T: are catalogue metadata, not musical information, and upstream
        # prompts do not carry them into the input section.
        if line[:2] in ("L:", "M:", "K:")
    ]
    body = document.text.splitlines()[-1]

    input_abc = "\n".join([f"%%{task}", *header_lines, body]) + "\n"
    decoder_prompt = "\n".join(header_lines) + "\n"
    return input_abc, decoder_prompt


class MelodyT5Runtime:
    """Loads the real checkpoint once and keeps it warm.

    Guarded by a lock rather than assumed single-threaded: uvicorn will run two
    requests concurrently, and the upstream generate loop seeds a module-level
    `random` and mutates its own token state.
    """

    def __init__(self, *, device_preference: str = "auto") -> None:
        self._lock = threading.Lock()
        self._model = None
        self._patchilizer = None
        self._device = "cpu"
        self._device_preference = device_preference
        self._revision = os.environ.get("MELODYT5_REVISION", "unknown")
        self._torch_version = "not-loaded"
        self._transformers_version = "not-loaded"
        self._load_error: str | None = None

    def resolve_device(self) -> str:
        """Never fail because CUDA is absent (AC-M09).

        `auto` means "use a GPU if there is one", not "require one".
        """
        if self._device_preference == "cpu":
            return "cpu"
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                return "cuda"
        except Exception as error:
            logger.info("no CUDA available, using CPU: %s", error)
        if self._device_preference == "cuda":
            logger.warning("MUSICIAN_DEVICE=cuda requested but no GPU is available; using CPU")
        return "cpu"

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return

            # Read from the vendored tree, write to the runtime directory. The
            # two are separated deliberately -- see RUNTIME_DIR.
            _ensure_upstream_importable()
            runtime_dir = _ensure_runtime_dir()

            previous_cwd = Path.cwd()
            try:
                # Upstream resolves `random_model` relative to the *working
                # directory*, and that is the only runtime-relative lookup on the
                # inference path -- checked against the pinned source, where
                # `utils.py:96` is the sole occurrence and the remaining relative
                # paths in `config.py` (`total_data_*.jsonl`, `logs.txt`,
                # `weights.pth`) are training-only and never read by this worker.
                #
                # So the load runs from the runtime directory rather than from
                # the vendored one. `import config` and `from utils import ...`
                # still resolve, because they go through `sys.path`, which points
                # at the immutable vendored source.
                os.chdir(runtime_dir)
                self._load_locked(runtime_dir)
            finally:
                os.chdir(previous_cwd)

    def _load_locked(self, runtime_dir: Path) -> None:
        try:
            import torch  # noqa: PLC0415
            import transformers  # noqa: PLC0415
            from transformers import GPT2Config  # noqa: PLC0415
        except ImportError as error:
            self._load_error = f"inference dependencies missing: {error}"
            raise ModelNotLoaded(self._load_error) from error

        if not MELODYT5_WEIGHTS.exists():
            self._load_error = (
                f"{MELODYT5_WEIGHTS} does not exist. Weights are never committed; "
                f"run scripts/models/bootstrap.sh (or .ps1) to fetch them."
            )
            raise ModelNotLoaded(self._load_error)

        _ensure_random_model(runtime_dir)
        _patch_samplings_for_modern_numpy()

        import config as upstream_config  # noqa: PLC0415
        from utils import MelodyT5, Patchilizer  # noqa: PLC0415

        self._device = self.resolve_device()
        self._torch_version = torch.__version__
        self._transformers_version = transformers.__version__

        # Exactly upstream's `inference.py`. The vocab sizes are not arbitrary:
        # the patch level has vocab_size=1 because it never embeds tokens (it
        # embeds one-hot *bytes* through a Linear), and the char level has 128
        # because it generates raw ASCII codepoints.
        patch_config = GPT2Config(
            num_hidden_layers=upstream_config.PATCH_NUM_LAYERS,
            max_length=upstream_config.PATCH_LENGTH,
            max_position_embeddings=upstream_config.PATCH_LENGTH,
            vocab_size=1,
        )
        char_config = GPT2Config(
            num_hidden_layers=upstream_config.CHAR_NUM_LAYERS,
            max_length=upstream_config.PATCH_SIZE,
            max_position_embeddings=upstream_config.PATCH_SIZE,
            vocab_size=128,
        )

        logger.info(
            "loading MelodyT5",
            extra={
                "weights": str(MELODYT5_WEIGHTS),
                "device": self._device,
                "torch": self._torch_version,
                "transformers": self._transformers_version,
            },
        )

        model = MelodyT5(patch_config, char_config)
        checkpoint = torch.load(MELODYT5_WEIGHTS, map_location=self._device, weights_only=False)

        # The checkpoint nests the state dict under "model"; loading the raw
        # object would silently mismatch every key.
        result = model.load_state_dict(checkpoint["model"], strict=False)

        # `strict=False` here is a *narrow* allowance, verified rather than
        # assumed, and the verification is the point.
        #
        # `missing_keys` must be empty: every parameter the model declares has
        # to exist in the checkpoint. That is what says this is the architecture
        # these weights were trained for.
        #
        # `unexpected_keys` is non-empty for a version reason. GPT-2's
        # `attn.bias` is the lower-triangular causal mask and `masked_bias` a
        # -1e4 constant; both were persistent buffers in the transformers 4.18
        # upstream pins and became non-persistent later, so a checkpoint saved
        # then carries entries a model built now does not declare. Dropping them
        # discards no learned value -- the mask is regenerated from config.
        #
        # Anything outside that pattern, or anything that is an actual
        # parameter, is a real mismatch and refuses to load.
        stray = [key for key in result.unexpected_keys if not _MASK_BUFFER.search(key)]
        parameter_names = {name for name, _ in model.named_parameters()}
        learned = [key for key in result.unexpected_keys if key in parameter_names]
        if result.missing_keys or stray or learned:
            self._load_error = (
                f"checkpoint does not match this architecture: "
                f"{len(result.missing_keys)} missing, {len(stray)} unexpected non-buffer keys, "
                f"{len(learned)} unexpected learned parameters"
            )
            raise ModelNotLoaded(self._load_error)
        logger.info(
            "checkpoint matches the architecture",
            extra={
                "missing": len(result.missing_keys),
                "maskBuffersDropped": len(result.unexpected_keys),
            },
        )
        model = model.to(self._device)
        model.eval()

        self._model = model
        self._patchilizer = Patchilizer()
        self._load_error = None
        logger.info(
            "MelodyT5 ready",
            extra={"parameters": sum(p.numel() for p in model.parameters())},
        )

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def info(self) -> RuntimeInfo:
        return RuntimeInfo(
            revision=self._revision,
            torch_version=self._torch_version,
            transformers_version=self._transformers_version,
            device=self._device,
            python_version=sys.version.split()[0],
            architecture="melodyt5-bar-patching",
        )

    def generate(
        self,
        *,
        notes: tuple[Note, ...],
        meter: Meter,
        tempo_bpm: float,
        key: Key | None,
        temperature: float = DEFAULT_TEMPERATURE,
        top_k: int = DEFAULT_TOP_K,
        top_p: float = DEFAULT_TOP_P,
        seed: int = 0,
        task: str = "variation",
        max_patch: int = DEFAULT_MAX_PATCH,
    ) -> tuple[tuple[Note, ...], str]:
        """One variation, generated bar by bar.

        Mirrors upstream's loop: encode the input once, then repeatedly ask for
        the next bar and append it to the decoder patches until the model emits
        EOS or the bar budget runs out.
        """
        if self._model is None or self._patchilizer is None:
            raise ModelNotLoaded(self._load_error or "model not loaded")

        import torch  # noqa: PLC0415

        input_abc, decoder_prompt = build_prompt(
            notes, meter=meter, tempo_bpm=tempo_bpm, key=key, task=task
        )

        with self._lock:
            patchilizer = self._patchilizer
            model = self._model

            patches = torch.tensor(
                [patchilizer.encode(input_abc, add_special_patches=True)], device=self._device
            )
            decoder_patches = torch.tensor(
                [patchilizer.encode(decoder_prompt, add_special_patches=True)[:-1]],
                device=self._device,
            )

            generated = decoder_prompt
            tokens = None
            current_seed: int | None = seed

            # `max_patch` arrives as a count of *bars of music*, but
            # `decoder_patches` already holds the header patches (L:, M:, K:).
            # Comparing against the raw budget would spend most of it on
            # headers, and a short phrase would get one bar of content.
            budget = decoder_patches.shape[1] + max_patch

            with torch.no_grad():
                while decoder_patches.shape[1] < budget:
                    predicted_patch, current_seed = model.generate(
                        patches,
                        decoder_patches,
                        tokens,
                        task=task,
                        top_p=top_p,
                        top_k=top_k,
                        temperature=temperature,
                        seed=current_seed,
                    )
                    tokens = None
                    if predicted_patch[0] == patchilizer.eos_token_id:
                        break

                    next_bar = patchilizer.decode([predicted_patch])
                    if next_bar == "":
                        break
                    generated += next_bar

                    predicted_tensor = torch.tensor(
                        patchilizer.bar2patch(next_bar), device=self._device
                    ).unsqueeze(0)
                    decoder_patches = torch.cat(
                        [decoder_patches, predicted_tensor.unsqueeze(0)], dim=1
                    )

        # Unparseable output is an ordinary outcome, not a server fault: the
        # orchestrator rejects the candidate and tries the next seed.
        parsed = from_abc(generated, tempo_bpm=tempo_bpm, start_sec=notes[0].start_sec)
        return parsed, generated


def key_from_payload(payload: str | None) -> Key | None:
    if not payload:
        return None
    parts = payload.split()
    if not parts:
        return None
    mode = Mode.MINOR if len(parts) > 1 and parts[1].lower().startswith("min") else Mode.MAJOR
    return Key(tonic=parts[0], mode=mode, confidence=1.0)
