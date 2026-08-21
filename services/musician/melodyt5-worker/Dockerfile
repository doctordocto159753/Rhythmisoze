# MelodyT5 worker. INTERNAL ONLY -- never published to a host port.
#
# Python 3.12. The compatibility spike has been run against the real weights and
# the maintained runtime is adopted -- see
# docs/architecture/melodyt5-runtime-decision.md.
#
# The evidence, briefly: load_state_dict reports **zero missing keys** against
# the published checkpoint, and the 60 unexpected ones are all GPT-2 causal-mask
# buffers that older transformers persisted and newer ones do not declare. The
# worker verifies that rather than assuming it, and refuses to load if anything
# outside that pattern appears.
#
# This container still exists as its own image: MelodyT5 needs transformers 4.40
# (tokenizers <0.20) and MIDI-RWKV needs tokenizers >=0.21, so the two genuinely
# cannot share an environment.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# CPU wheels by default. The GPU compose override swaps in a CUDA base; a CPU
# VPS must never pull a CUDA build it cannot use (AC-13).
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

COPY shared/pyproject.toml /app/shared/pyproject.toml
COPY shared/src /app/shared/src
COPY melodyt5-worker/pyproject.toml /app/worker/pyproject.toml
COPY melodyt5-worker/src /app/worker/src

RUN pip install --no-cache-dir ./shared && \
    pip install --no-cache-dir --index-url "${TORCH_INDEX_URL}" torch && \
    pip install --no-cache-dir ./worker

RUN useradd --create-home --uid 10002 worker
USER worker

# Weights are mounted, not baked in: ~1.36 GB in an image makes every pull and
# every redeploy pay for a file that changes far less often than the code.
ENV MUSICIAN_MODELS_DIR=/models \
    MUSICIAN_DEVICE=auto

EXPOSE 8081

CMD ["uvicorn", "melodyt5_worker.main:app", "--host", "0.0.0.0", "--port", "8081"]
