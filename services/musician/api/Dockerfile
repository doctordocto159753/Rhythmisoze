# The orchestrator. Modern runtime, no model weights, no torch.
#
# Kept separate from the workers because their dependency stacks cannot coexist
# -- MelodyT5 is on an old Python/PyTorch line, MIDI-RWKV on 3.11 with rwkv.cpp.
# Forcing all three into one image to make "microservice" mean "one container"
# is the dependency graveyard the brief warns about.
FROM python:3.12-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Copy the dependency metadata first so a source edit does not invalidate the
# install layer.
COPY shared/pyproject.toml /app/shared/pyproject.toml
COPY api/pyproject.toml /app/api/pyproject.toml
COPY shared/src /app/shared/src
COPY api/src /app/api/src

RUN pip install --no-cache-dir ./shared && \
    pip install --no-cache-dir "./api[real]"

# Runs unprivileged. The orchestrator is the only container reachable from
# outside, so it is the one that has to be least interesting to compromise.
RUN useradd --create-home --uid 10001 musician
USER musician

ENV MUSICIAN_DEVICE=auto \
    MUSICIAN_ADAPTERS=real \
    MUSICIAN_LOG_LEVEL=INFO

EXPOSE 8080

# The liveness probe deliberately does not touch a model: restarting because
# inference is slow is worst precisely when inference is slow.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "musician_api.main:app", "--host", "0.0.0.0", "--port", "8080"]
