# MIDI-RWKV worker. INTERNAL ONLY -- never published to a host port.
#
# Python 3.11 to match MIDI-RWKV's published experiments.
#
# ## The V1 runtime is the Python `rwkv` package
#
# Settled and verified against the real 35.09M-parameter checkpoint -- see
# docs/architecture/musician-runtime-adr.md. rwkv.cpp is a **deferred
# optimisation**: `inference.py` reaches for it only when a converted GGML weight
# (`midi_rwkv.bin`) is present, and falls through to this runtime when it is not.
# No GGML weight is produced by `scripts/models/bootstrap`, so on every supported
# V1 deployment the pip runtime is the one that runs.
#
# This image therefore builds no C++ at all. It previously did:
#
#     COPY vendor/rwkv.cpp /opt/rwkv.cpp
#
# which could never work -- compose builds this service with
# `context: ./services/musician`, and `vendor/` is at the repository root, so
# Docker failed with `"/vendor/rwkv.cpp": not found` before the CMake step was
# ever reached. Worse, the image did not install `rwkv`, `torch` or `tokenizers`,
# so even a successful build could not have loaded the model. The build step was
# mandatory, dead, and outside its own context.
#
# rwkv.cpp remains available without any of that: compose mounts the repository's
# `./vendor` read-only at `/vendor`, so a future GGML path can be enabled by
# producing the weight and the bindings, not by rebuilding this image.
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# CPU wheels by default, exactly as the MelodyT5 image does. A CPU VPS must never
# pull a CUDA build it cannot use (AC-13) -- and for this model that is not only
# a size argument: measured on an RTX 4060, MIDI-RWKV infill is *slower* on the
# GPU than on the CPU (6.08 s against 4.41 s), because a 35M-parameter recurrent
# step per token is dominated by launch overhead. See
# docs/architecture/musician-expanded.md.
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

COPY shared/pyproject.toml /app/shared/pyproject.toml
COPY shared/src /app/shared/src
COPY rwkv-worker/pyproject.toml /app/worker/pyproject.toml
COPY rwkv-worker/src /app/worker/src

# `[pip]` is the runtime extra: rwkv, torch, tokenizers and the miditok MMM
# representation. Installing only the lower-level tokenizer packages produces
# an image that starts and answers /health but cannot load the saved MIDI
# tokenizer, so every infill request fails at runtime.
RUN pip install --no-cache-dir ./shared && \
    pip install --no-cache-dir --index-url "${TORCH_INDEX_URL}" torch && \
    pip install --no-cache-dir "./worker[pip]"

RUN useradd --create-home --uid 10003 worker
USER worker

# Weights are mounted, not baked in.
ENV MUSICIAN_MODELS_DIR=/models \
    MUSICIAN_VENDOR_DIR=/vendor \
    MUSICIAN_DEVICE=auto \
    MIDI_RWKV_WEIGHT=midi_rwkv.pth

# Load-bearing, and set nowhere else. MIDI-RWKV is RWKV-7 "Goose", and the `rwkv`
# package selects its v7 implementation from this variable alone -- its default
# class detects only v4/v5/v6. Without it the model loads and then dies on the
# first call with `'types.SimpleNamespace' object has no attribute 'n_head'`.
# Only the spike scripts had it; the container did not.
ENV RWKV_V7_ON=1 \
    RWKV_JIT_ON=1

EXPOSE 8082

CMD ["uvicorn", "rwkv_worker.main:app", "--host", "0.0.0.0", "--port", "8082"]
