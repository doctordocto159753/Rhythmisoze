# MIDI-RWKV worker. INTERNAL ONLY -- never published to a host port.
#
# Python 3.11 to match MIDI-RWKV's published experiments. rwkv.cpp is built from
# UPSTREAM RWKV/rwkv.cpp, not the personal fork MIDI-RWKV pins -- see
# third_party/MANIFEST.md for that decision and its cost.
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install --no-install-recommends -y \
        build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY shared/pyproject.toml /app/shared/pyproject.toml
COPY shared/src /app/shared/src
COPY rwkv-worker/pyproject.toml /app/worker/pyproject.toml
COPY rwkv-worker/src /app/worker/src

RUN pip install --no-cache-dir ./shared && pip install --no-cache-dir ./worker

# rwkv.cpp is vendored at a pinned SHA by scripts/vendor/bootstrap.sh and built
# here. The CPU build is the baseline and needs no torch at all.
ARG RWKV_CPP_REVISION=14663c83b6aba4885a47c1fba91204efc74a49d3
COPY vendor/rwkv.cpp /opt/rwkv.cpp
RUN if [ -d /opt/rwkv.cpp/CMakeLists.txt ] || [ -f /opt/rwkv.cpp/CMakeLists.txt ]; then \
      cmake -S /opt/rwkv.cpp -B /opt/rwkv.cpp/build -DCMAKE_BUILD_TYPE=Release && \
      cmake --build /opt/rwkv.cpp/build --config Release -j"$(nproc)" && \
      cp /opt/rwkv.cpp/python/rwkv_cpp_model.py /opt/rwkv.cpp/python/rwkv_cpp_shared_library.py \
         /usr/local/lib/python3.11/site-packages/ 2>/dev/null || true ; \
    else \
      echo "vendor/rwkv.cpp is empty: run scripts/vendor/bootstrap.sh before building" >&2 ; \
    fi

RUN useradd --create-home --uid 10003 worker
USER worker

ENV MUSICIAN_MODELS_DIR=/models \
    MUSICIAN_DEVICE=auto \
    MIDI_RWKV_WEIGHT=midi_rwkv.pth

EXPOSE 8082

CMD ["uvicorn", "rwkv_worker.main:app", "--host", "0.0.0.0", "--port", "8082"]
