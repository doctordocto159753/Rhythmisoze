"""Launch upstream GAME with the CPU backend that is stable on this deployment.

## The crash

On the CPU-only VPS this service is deployed to, every real ``POST /witness``
returned 502 and the underlying inference died with:

    Floating point exception (core dumped)

SIGFPE from native code, so nothing Python could catch — the adapter saw a
child that exited on a signal and correctly reported that it had no answer.

## What was actually at fault

Isolated experimentally on the deployment host (Python 3.12.14, torch
2.13.0+cpu, x86_64/AVX2, CUDA unavailable, MKLDNN enabled, 4 threads):

    plain torch CPU scaled_dot_product_attention   finite output, exit 0
    GAME, MKLDNN on,  4 threads                    Floating point exception
    GAME, MKLDNN on,  1 thread                     Floating point exception
    GAME, MKLDNN off, 1 thread                     success
    GAME, MKLDNN off, 4 threads                    success

Two things follow, and the second is the one worth writing down. The fault is
the oneDNN/MKLDNN CPU path under GAME's graph on this host, and it is **not**
threading — so this deliberately does not pin the child to one thread. Forcing
single-threaded inference would have made the symptom go away in testing while
costing every real request most of its speed, and would have left the actual
cause unexplained and unfixed.

## Why a launcher rather than a flag

The setting has to be applied inside the process that runs the model, before
its first operator dispatch, and it must apply to *that process only*:

- not to Rhythmisoze generally — nothing else here runs torch;
- not to MelodyT5 or MIDI-RWKV, which are separate containers with their own
  runtimes and are not affected;
- not when CUDA is available, where the CPU path is not what executes and
  disabling it would be a change with no evidence behind it.

An environment variable in the compose file would have hit the whole container;
a patch to upstream's ``infer.py`` would have forked a pinned checkout. A
launcher that sets one flag and then hands over is the smallest thing that is
true only where it needs to be.

Nothing about the model, the weights, the thread count or the rest of PyTorch
changes.
"""

from __future__ import annotations

import runpy

import torch

#: Upstream's entry point, resolved against the working directory.
#:
#: ``game_adapter`` starts this module with ``cwd`` set to the pinned GAME
#: checkout and passes the ``infer.py`` CLI arguments through unchanged, so the
#: relative path is the checkout's own script and ``sys.argv[1:]`` is already
#: what upstream's Click command expects to parse.
UPSTREAM_ENTRY_POINT = "infer.py"


def should_disable_mkldnn(*, cuda_available: bool) -> bool:
    """Whether this process should turn the MKLDNN CPU path off.

    Split out from `main` so the decision can be asserted without a GPU, without
    the model and without running inference. The rule is the whole of the fix:
    disable it exactly when the CPU path is the one that will execute.
    """
    return not cuda_available


def main() -> None:
    if should_disable_mkldnn(cuda_available=torch.cuda.is_available()):
        torch.backends.mkldnn.enabled = False

    runpy.run_path(UPSTREAM_ENTRY_POINT, run_name="__main__")


if __name__ == "__main__":
    main()
