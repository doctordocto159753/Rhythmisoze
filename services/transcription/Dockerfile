# Authoritative GAME transcription. Upstream's own inference code, at a pinned
# revision, with the weights left outside.
#
# The split matters. GAME's *code* is MIT, so it can be built into an image.
# GAME's *pretrained weights* are CC BY-NC-SA 4.0 — non-commercial, share-alike
# — and this project is MIT. Baking them in would silently attach that licence
# to every image built from this repository, which is precisely the thing
# `third_party/MANIFEST.md` rule 5 exists to prevent. So the image can be built,
# started and probed by anyone, and it reports 503 until an operator has fetched
# the weights themselves and accepted the terms that come with them.
FROM python:3.12-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# `git` for the pinned clone; `libsndfile1` and `ffmpeg` because upstream's
# audio loading reaches for them. Removed from the layer they were used in.
RUN apt-get update \
    && apt-get install --no-install-recommends -y git libsndfile1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# CPU wheels explicitly. The default index resolves to the CUDA build, which is
# gigabytes of driver payload on a machine that has no GPU — the design target
# for this stage is a CPU-only VPS.
#
# Pinned, and the pin is load-bearing. This service works around a SIGFPE in the
# oneDNN/MKLDNN CPU path (see `game_runner`), and both the crash and the
# workaround are properties of a specific PyTorch build. Leaving the version
# open meant a rebuild months later could silently install a different torch —
# one where the workaround is unnecessary, or where it is insufficient — and the
# evidence recorded against 2.13.0+cpu would then describe nothing that was
# installed. `third_party/MANIFEST.md` rule 1 already says this about upstream
# code; the runtime is no different.
#
# These are the exact versions the crash was isolated on and the fix validated
# against. Overridable at build time for a host that needs a different pair.
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
ARG TORCH_VERSION=2.13.0
ARG TORCHAUDIO_VERSION=2.11.0
RUN pip install --no-cache-dir --index-url ${TORCH_INDEX} \
    "torch==${TORCH_VERSION}" "torchaudio==${TORCHAUDIO_VERSION}"

# Pinned, not tracked. A transcription engine that changes underneath a
# committed evaluation fixture turns a model update into an unexplained quality
# regression.
ARG GAME_REVISION=4ad815c90dfe2442730f3fdc866fd23e737cbc97
RUN git clone --filter=blob:none https://github.com/openvpi/GAME.git /opt/game \
    && git -C /opt/game checkout ${GAME_REVISION} \
    && rm -rf /opt/game/.git \
    && pip install --no-cache-dir -r /opt/game/requirements.txt

WORKDIR /app
COPY pyproject.toml /app/pyproject.toml
COPY src /app/src
RUN pip install --no-cache-dir .

# Runs unprivileged, and owns only the scratch directory it writes takes into.
RUN useradd --create-home --uid 10002 transcription \
    && mkdir -p /tmp/transcription \
    && chown transcription:transcription /tmp/transcription
USER transcription

ENV TRANSCRIPTION_MODEL_DIR=/models/game \
    TRANSCRIPTION_GAME_DIR=/opt/game \
    TRANSCRIPTION_WORK_DIR=/tmp/transcription \
    TRANSCRIPTION_LOG_LEVEL=INFO

EXPOSE 8083

# Liveness only. `/ready` is what reports a missing model, and a container that
# restarts because the operator has not downloaded the weights would never stay
# up long enough to say so.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8083/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "transcription_service.main:app", "--host", "0.0.0.0", "--port", "8083"]
