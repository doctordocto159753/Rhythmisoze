# Runbook: the AI Musician locally

How to run the service on your own machine, what each failure looks like, and
what to do about it.

---

## The short version

You do **not** need model weights to work on the pipeline.

```bash
cd services/musician
pip install -e shared -e "api[dev]"
python -m pytest            # 104 tests, no weights, ~20 s
```

```bash
MUSICIAN_ADAPTERS=fake uvicorn musician_api.main:app --port 8080
curl localhost:8080/ready
```

That covers orchestration, the Identity Guard, ranking, span selection, the
contract and the API. Weights are only needed to run the actual models.

---

## With the real models

### 1. Upstream source

```bash
scripts/vendor/bootstrap.sh          # Linux, macOS, Git Bash
pwsh scripts/vendor/bootstrap.ps1    # Windows
```

Clones MelodyT5, MIDI-RWKV and rwkv.cpp at their pinned SHAs into `vendor/`.
Nothing it fetches is committed.

It **announces two deliberate skips**: `MIDIMetrics` (no detected licence, and
an evaluation dependency inference does not need) and `RWKV-PEFT` (training
only). If you see those lines, the script is working correctly.

### 2. Weights — about 1.43 GB

```bash
scripts/models/bootstrap.sh
pwsh scripts/models/bootstrap.ps1
```

Downloads only what is missing, resumes partial transfers, and verifies sha256
against `models/manifest.json`.

**A checksum mismatch is fatal and the script will not continue.** That is
deliberate: a wrong checkpoint that loads is worse than one that does not,
because it produces plausible output from the wrong model.

### 3. Start the stack

```bash
cd services/musician
cp .env.example .env
docker compose up --build
```

CPU by default, on any machine. For an NVIDIA host:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

The GPU override changes no code path — `MUSICIAN_DEVICE=auto` already prefers
CUDA when present. It only lets the container see the GPU and swaps the CPU
torch wheels for CUDA ones.

### 4. Check it

```bash
curl -s localhost:8080/ready | python -m json.tool
```

```json
{
  "ready": true,
  "models": { "melodyT5": true, "midiRwkv": true },
  "queue": { "backend": "redis", "depth": 0 },
  "durable": true
}
```

---

## Submitting a job

```bash
curl -s -X POST localhost:8080/v1/jobs \
  -H 'content-type: application/json' \
  -d '{
    "seed": 42,
    "teacher": {
      "sourceId": "demo",
      "notes": [
        {"pitch": 60, "startSec": 0.0, "endSec": 0.45},
        {"pitch": 62, "startSec": 0.5, "endSec": 0.95},
        {"pitch": 64, "startSec": 1.0, "endSec": 1.45},
        {"pitch": 65, "startSec": 1.5, "endSec": 1.95}
      ],
      "tempo": {"bpm": 120, "confidence": 0.8},
      "meter": {"numerator": 4, "denominator": 4, "confidence": 0.7},
      "key": {"tonic": "C", "mode": "major", "confidence": 0.7},
      "durationSec": 2.5
    }
  }'
```

Returns `202` with a `jobId`. Poll `GET /v1/jobs/{jobId}`; cancel with
`DELETE /v1/jobs/{jobId}`.

---

## Failures, and what they actually mean

### `/ready` returns 503 with `"melodyT5": false`

The worker is up but has no weights. Check `docker compose logs melodyt5-worker`
for the path it looked in, then run the model bootstrap.

This is **correct behaviour**, not a bug: the API deliberately starts and reports
red rather than refusing to boot. A stack that never starts and never says why is
harder to diagnose than one that starts and tells you exactly what is missing.

### `"queue": {"backend": "memory"}, "durable": false`

Redis was unreachable, so the service fell back to an in-process queue and
**queued jobs will not survive a restart**. It says so rather than pretending,
because "jobs vanished after a redeploy" is miserable to debug otherwise.

Fine for local work. Never right in production.

### Jobs stay `pending` forever

The worker loop is not draining. Check the API logs for `failed to claim a job`.
If Redis is up and the queue depth is climbing, the loop thread died — restart
the API container and open an issue with the log.

### `curl: (3) URL rejected: Malformed input to a URL function`

A carriage return got into the URL. On Windows this means `bootstrap.sh` was
checked out with CRLF line endings; `.gitattributes` pins `*.sh` to LF, so
re-checkout the file:

```bash
git rm --cached scripts/models/bootstrap.sh && git checkout scripts/models/bootstrap.sh
```

### `python3 is required` on Windows

Older copies of the script. The current one resolves `python3` or `python`.

### `MUSICIAN_DEVICE=cuda was requested but no GPU is available`

A warning, not an error — the worker continues on CPU. If you expected a GPU:
check `nvidia-smi` on the host, and that you passed the GPU override file.

### Out-of-memory killing `melodyt5-worker`

MelodyT5 is ~1.36 GB of fp32 weights plus activations. The compose limit is 6 GB
by default; raise `MELODYT5_MEMORY_LIMIT` in `.env`. If the host has less than
8 GB, run the API in `MUSICIAN_ADAPTERS=fake` mode for development instead.

---

## Things that are meant to be true

- **The workers are not reachable from outside.** `docker compose ps` should show
  a published port for `musician-api` only. If a worker has one, that is a
  misconfiguration — they have no authentication.
- **Weights are never committed.** `git status` after a bootstrap should be
  clean. `models/` and `vendor/` are gitignored.
- **User note data is not logged.** Logs carry ids, counts and timings.
  `MUSICIAN_LOG_NOTES=1` exists for debugging one specific transcription and
  should not be left on.

---

## Running the real-model tests

```bash
cd services/musician
MUSICIAN_REAL_MODELS=1 python -m pytest tests/test_real_models.py -v
```

Skipped without that variable, and normal CI never runs them. They verify the
weights load, output survives the contract, generation is reproducible from a
seed, and infill stays inside its span — plus that every downloaded artifact
matches its recorded checksum, because a manifest nobody verifies is a comment.
