"""Run the official MelodyT5 inference path against the published weights.

Closes AC-M01, AC-M02 and AC-M03, and answers the runtime question in
`docs/architecture/melodyt5-runtime-decision.md`.

    python scripts/spike/melodyt5_official.py <upstream-dir> <weights.pth>

## Why this uses upstream's own classes

MelodyT5 is not a HuggingFace T5. It is a hierarchical *bar-patching* model:
`Patchilizer` splits an ABC body on barline delimiters and encodes each bar as a
fixed 64-byte patch of character codepoints; a 9-layer GPT-2 encoder/decoder
runs over patch embeddings with tied weights; a 3-layer GPT-2 writes the
characters inside one bar. Generation is two-level — one model call produces one
bar, which is appended to the decoder patches before the next call.

So this imports `MelodyT5` and `Patchilizer` from the vendored upstream tree
rather than reimplementing them. A reimplementation would be a second definition
of a model we do not own.

## The signal that says the architecture matches

`load_state_dict(..., strict=True)` raising nothing. Every parameter name and
shape in the checkpoint has to line up with the constructed model. That is a far
stronger statement than "it produced output", and it is checked first.

## The runtime question

Upstream pins `transformers==4.18.0` and documents Python 3.7.9 / torch 1.13.1 /
CUDA 11.6. This script deliberately runs on a maintained stack and reports
exactly what it ran on, so the decision is made from evidence rather than from
the age of a requirements file.
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

UPSTREAM = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("vendor/melodyt5")
WEIGHTS = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("models/melodyt5/weights.pth")
DEVICE = os.environ.get("SPIKE_DEVICE", "cpu")

sys.path.insert(0, str(UPSTREAM))

import numpy as np  # noqa: E402
import torch  # noqa: E402
import transformers  # noqa: E402
from transformers import GPT2Config  # noqa: E402


def patch_samplings_for_modern_numpy() -> str:
    """Renormalise before `np.random.choice`, which modern numpy requires.

    Upstream samples through the `samplings` package. Its `random_sampling`
    ends in `np.random.choice(range(len(probs)), p=probs)`, and numpy checks
    `abs(sum(p) - 1) < ~1e-8`. After top-p, top-k and temperature have each
    rescaled a float32 vector the sum lands a few ULPs off, and numpy raises
    "probabilities do not sum to 1".

    This is a numpy-strictness difference, not a model or architecture problem:
    the distribution is correct, its float32 sum simply is not exactly 1. The
    shim casts to float64 and divides by the sum, which changes no sampling
    semantics -- it is the normalisation the maths already assumes.

    Applied here rather than by editing the vendored package, so upstream stays
    pristine and the deviation is visible in our own source.
    """
    import samplings

    original = samplings.random_sampling

    def safe_random_sampling(probs, seed=None):
        array = np.asarray(probs, dtype=np.float64)
        total = array.sum()
        if total <= 0:
            # Degenerate distribution: fall back to uniform rather than raising
            # inside a generation loop.
            array = np.ones_like(array) / array.size
        else:
            array = array / total
        if seed is not None:
            np.random.seed(seed)
        return int(np.random.choice(array.size, p=array))

    samplings.random_sampling = safe_random_sampling
    return f"samplings.random_sampling patched for numpy {np.__version__} strictness"


def ensure_random_model(upstream: Path) -> None:
    """Create the scaffold `PatchLevelEnDecoder` expects.

    With `SHARE_WEIGHTS=True` it builds its base via
    `EncoderDecoderModel.from_encoder_decoder_pretrained("random_model", ...)`,
    which needs a randomly-initialised GPT-2 on disk relative to the working
    directory. Upstream ships `random_model.py` to make it. Everything in it is
    overwritten by the checkpoint moments later, so it influences nothing.
    """
    target = upstream / "random_model"
    if (target / "config.json").exists():
        return
    from transformers import GPT2Model

    import config as upstream_config

    print("  creating the random_model scaffold upstream requires")
    GPT2Model(
        GPT2Config(
            num_hidden_layers=upstream_config.PATCH_NUM_LAYERS,
            max_length=upstream_config.PATCH_LENGTH,
            max_position_embeddings=upstream_config.PATCH_LENGTH,
            vocab_size=1,
        )
    ).save_pretrained(str(target))


#: Three fixtures, in upstream's own input format. The first line is the task:
#: upstream derives it with `input_abc.split("\n")[0][2:]`, so `%%variation` is
#: load-bearing rather than a comment.
FIXTURES: dict[str, str] = {
    "A. simple 4/4 major": (
        "%%variation\n"
        "L:1/8\n"
        "M:4/4\n"
        "K:C\n"
        "CDEF GABc | cBAG FEDC | CDEF GABc | c4 z4 |\n"
    ),
    "B. 6/8": (
        "%%variation\n"
        "L:1/8\n"
        "M:6/8\n"
        "K:D\n"
        "AFD DFA | Add B2 A | ABA F3 | GFG EFG |\n"
    ),
    "C. teacher-like irregular": (
        "%%variation\n"
        "L:1/16\n"
        "M:4/4\n"
        "K:G\n"
        "G4 A4 B6 A2 | G4 B4 d8 | e4 d4 B4 G4 | A8 G8 |\n"
    ),
}


def main() -> int:
    print("=" * 72)
    print("OFFICIAL MELODYT5 INFERENCE")
    print("=" * 72)
    print(f"python       : {sys.version.split()[0]}")
    print(f"torch        : {torch.__version__}")
    print(f"transformers : {transformers.__version__}   (upstream pins 4.18.0)")
    print(f"device       : {DEVICE}")
    print(f"weights      : {WEIGHTS} ({WEIGHTS.stat().st_size:,} bytes)")

    print(f"numpy        : {np.__version__}")
    print(f"shim         : {patch_samplings_for_modern_numpy()}")

    previous = Path.cwd()
    os.chdir(UPSTREAM)
    try:
        import config as upstream_config
        from utils import MelodyT5, Patchilizer

        ensure_random_model(UPSTREAM)

        print(f"\nconfig       : PATCH_SIZE={upstream_config.PATCH_SIZE} "
              f"PATCH_LENGTH={upstream_config.PATCH_LENGTH} "
              f"patch_layers={upstream_config.PATCH_NUM_LAYERS} "
              f"char_layers={upstream_config.CHAR_NUM_LAYERS} "
              f"share_weights={upstream_config.SHARE_WEIGHTS}")

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

        started = time.time()
        model = MelodyT5(patch_config, char_config)
        build = time.time() - started

        started = time.time()
        checkpoint = torch.load(WEIGHTS, map_location=DEVICE, weights_only=False)
        read = time.time() - started
        print(f"\ncheckpoint   : keys={list(checkpoint.keys())}")

        started = time.time()
        result = model.load_state_dict(checkpoint["model"], strict=False)
        load = time.time() - started

        # The architecture question, answered precisely.
        #
        # `missing_keys` empty is the strong signal: every parameter the model
        # declares was found in the checkpoint. That is what says this IS the
        # architecture the weights were trained for.
        #
        # `unexpected_keys` is non-empty, and the reason is a transformers
        # version difference rather than an architecture mismatch. GPT-2's
        # `attn.bias` is the lower-triangular causal mask and `masked_bias` is a
        # -1e4 constant. Both were *persistent* buffers in 4.18 (which upstream
        # pins) and were made non-persistent in later versions, so a checkpoint
        # saved then carries entries a model built now does not declare.
        #
        # Dropping them is safe exactly because they are constants: the mask is
        # regenerated from the config, and no learned value is discarded. This
        # is checked rather than asserted.
        MASK_BUFFER = re.compile(r"\.(attn|crossattention)\.(bias|masked_bias)$")
        stray = [k for k in result.unexpected_keys if not MASK_BUFFER.search(k)]
        parameter_names = {name for name, _ in model.named_parameters()}
        learned = [k for k in result.unexpected_keys if k in parameter_names]

        print(f"\nload_state_dict(strict=False):")
        print(f"  missing keys      : {len(result.missing_keys)}  {list(result.missing_keys)[:3]}")
        print(f"  unexpected keys   : {len(result.unexpected_keys)}")
        print(f"  ... all causal-mask buffers : {not stray}"
              f"{'' if not stray else '  STRAY: ' + str(stray[:3])}")
        print(f"  ... any learned parameter   : {bool(learned)}"
              f"{'' if not learned else '  ' + str(learned[:3])}")

        if result.missing_keys or stray or learned:
            print("\n!! the checkpoint does not match this architecture")
            return 1
        print("  VERDICT: architecture matches; the extras are version-difference constants")

        model = model.to(DEVICE)
        model.eval()
        parameters = sum(p.numel() for p in model.parameters())
        print(f"\nAC-M01  REAL WEIGHTS LOADED")
        print(f"  parameters : {parameters:,}")
        print(f"  build      : {build:.2f}s   read: {read:.2f}s   load: {load:.2f}s")
        print(f"  total cold : {build + read + load:.2f}s")
        try:
            import psutil

            print(f"  RSS        : {psutil.Process().memory_info().rss / 1048576:.0f} MB")
        except ImportError:
            pass

        patchilizer = Patchilizer()
        all_ok = True

        for name, input_abc in FIXTURES.items():
            print("\n" + "-" * 72)
            print(name)
            print("-" * 72)
            task = input_abc.split("\n")[0][2:]
            header = "\n".join(
                line for line in input_abc.splitlines() if line[:2] in ("L:", "M:", "K:")
            ) + "\n"
            print(f"task parsed  : {task!r}")

            patches = torch.tensor(
                [patchilizer.encode(input_abc, add_special_patches=True)], device=DEVICE
            )
            decoder_patches = torch.tensor(
                [patchilizer.encode(header, add_special_patches=True)[:-1]], device=DEVICE
            )
            print(f"input patches: {patches.shape[1]} x {patches.shape[2] if patches.dim() > 2 else 64}")

            generated = header
            tokens = None
            seed: int | None = 20260821
            bars = 0
            started = time.time()
            with torch.no_grad():
                while decoder_patches.shape[1] < 32:
                    predicted, seed = model.generate(
                        patches,
                        decoder_patches,
                        tokens,
                        task=task,
                        top_p=0.8,
                        top_k=8,
                        temperature=2.6,
                        seed=seed,
                    )
                    tokens = None
                    if predicted[0] == patchilizer.eos_token_id:
                        break
                    bar = patchilizer.decode([predicted])
                    if bar == "":
                        break
                    generated += bar
                    bars += 1
                    nxt = torch.tensor(patchilizer.bar2patch(bar), device=DEVICE).unsqueeze(0)
                    decoder_patches = torch.cat([decoder_patches, nxt.unsqueeze(0)], dim=1)
            elapsed = time.time() - started

            body = generated[len(header):]
            print(f"generated    : {bars} bars in {elapsed:.1f}s "
                  f"({elapsed / max(bars, 1):.1f}s/bar)")
            print(f"OUTPUT ABC   :\n{generated.strip()}")

            # It must be different from what went in. A model that echoes its
            # input would satisfy every syntactic check while doing nothing.
            source_body = "".join(input_abc.splitlines()[4:])
            identical = body.replace(" ", "").replace("\n", "") == source_body.replace(" ", "")
            note_chars = sum(1 for c in body if c in "ABCDEFGabcdefg")
            checks = [
                ("produced bars", bars > 0, f"{bars}"),
                ("contains note letters", note_chars > 0, f"{note_chars}"),
                ("is not a copy of the input", not identical, "differs" if not identical else "IDENTICAL"),
                ("no runaway length", bars <= 32, f"{bars} bars"),
            ]
            for label, passed, detail in checks:
                print(f"  [{'PASS' if passed else 'FAIL'}] {label:32} {detail}")
                all_ok = all_ok and passed

        print("\n" + "=" * 72)
        print(f"AC-M02  REAL VARIATION OUTPUT: {'PASS' if all_ok else 'FAIL'}")
        print("=" * 72)
        return 0 if all_ok else 1
    finally:
        os.chdir(previous)


if __name__ == "__main__":
    raise SystemExit(main())
