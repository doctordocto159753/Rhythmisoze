# services/transcription — the register witness

A second opinion about **which octave a note is in**, and nothing else.

The browser transcribes the take and is better at it than this service is at
most of the job — note boundaries especially. What it cannot do is hear an
octave leap: the YIN-derived tracker locks onto a subharmonic and is then
completely confident. On `diff-octave-leap`, a C4→C5→C4 phrase with exact
ground truth, it reports C4→C4→C4 with 32.6% octave error and 98.9% chroma
accuracy. That is not a tuning problem; the information is not in its output.

This service wraps [GAME](https://github.com/openvpi/GAME) so the arbitration in
`src/packages/evidence` has a second, independent measurement to work with.

## It is off by default, for two separate reasons

**It sends the recording off the device.** Rhythmisoze's standing promise is
that your recording is processed on your device and only note data ever leaves
it. Enabling this makes that false — the audio goes to the transcription
container. The landing copy switches to a sentence that says so, and the service
deletes each take as soon as it has read it. Changing a promise on a user's
behalf is not something to inherit from a config file nobody read, so the
default is the one that needs no explanation.

**The weights are not under this project's licence.**

| | licence |
|---|---|
| GAME's source code | MIT |
| GAME's pretrained weights | **CC BY-NC-SA 4.0** |
| Rhythmisoze | MIT |

Non-commercial, attribution, share-alike. The weights are never committed here
and never baked into the image; `models/manifest.json` records the split and the
bootstrap prints the licence before it downloads anything. **A deployment that
enables this service is a non-commercial one.**

## What you get, and what you give up

Measured on the evaluation corpus, which has exact ground truth
(`evaluation/reports/latest.md` and `latest-full.md`):

| | without this service | with it |
|---|---|---|
| `diff-octave-leap` delivered octave error | 32.6% | **0.0%** |
| `diff-octave-leap` note F1 | 0.67 | **1.00** |
| `diff-octave-leap` interval direction agreement | 0% | **100%** |
| every other corpus case | unchanged | unchanged |

Without it the product is complete: a register correction requires two agreeing
engines, so with only the browser's own engine the disagreement is **reported
and not acted on**. That is strictly more information than the pipeline had
before, and no note moves on evidence that has not been corroborated.

Cost: about **7 seconds** per ten-second take on a CPU-only machine, most of it
process start and model load, and roughly 700 MB of PyTorch in the image.

## Running it

```bash
scripts/models/bootstrap.sh game     # prints the licence, then fetches ~47 MB
TRANSCRIPTION_ENABLED=true docker compose up --build
```

The container is always built and started. Until the weights are present it
answers `/ready` with 503 and `/witness` with 503, which the app reads as "no
second opinion available" — not as an error, because it is not one.

| endpoint | |
|---|---|
| `GET /health` | liveness; never touches the model, so a slow inference cannot cause a restart loop |
| `GET /ready` | 200 with weights, 503 without |
| `POST /witness` | multipart `audio` (WAV) → `{ engine, elapsedMs, notes: [{ startSec, endSec, pitch }] }` |

Pitch is fractional MIDI: GAME reports continuous pitch and rounding it at this
boundary would discard a measurement in favour of a convention.

It is never published outside the internal compose network, for the same reason
the model workers are not: it holds weights, it has no authentication, and its
request shape is an implementation detail.

## The MKLDNN workaround

On the CPU-only deployment host every real `POST /witness` returned 502, and the
inference underneath died with `Floating point exception (core dumped)` — SIGFPE
from native code, which no Python handler can catch.

Isolated on that host (Python 3.12.14, torch 2.13.0+cpu, x86_64/AVX2, no CUDA):

| | result |
|---|---|
| plain torch CPU `scaled_dot_product_attention` | finite output, exit 0 |
| GAME, MKLDNN on, 4 threads | Floating point exception |
| GAME, MKLDNN on, 1 thread | Floating point exception |
| GAME, MKLDNN off, 1 thread | success |
| GAME, MKLDNN off, 4 threads | success |

So the fault is the oneDNN/MKLDNN CPU path under GAME's graph, and it is **not**
threading. `game_runner.py` disables that one backend in the inference child
process only — not for Rhythmisoze generally, not for MelodyT5 or MIDI-RWKV
(separate containers, unaffected), and not when CUDA is available. Thread count,
model, weights and the rest of PyTorch are untouched: pinning the child to one
thread would also have hidden the symptom, while costing every request most of
its speed and leaving the cause unexplained.

The torch version in the Dockerfile is pinned for the same reason. Both the
crash and the workaround are properties of a specific build, so an unpinned
rebuild could silently install a torch that the recorded evidence does not
describe.

## Why it shells out to `infer.py`

GAME is a research repository, not a library. Its entry point is a Click command
that assembles a Lightning predictor around a config file; calling that machinery
directly would mean importing half of it and reconstructing the wiring the CLI
already does. That copy would drift from upstream silently, and drift in a
transcription engine looks like a quality regression rather than a bug.

The revision is pinned (`GAME_REVISION`). A transcription engine that changes
underneath a committed evaluation fixture turns a model update into an
unexplained quality change.

## Not adopted

**ONNX.** GAME v1.0.3 publishes ONNX exports that would remove PyTorch from this
image entirely — a large win for a CPU-only VPS. This project has measured the
v1.0.0 PyTorch model and has *not* measured the ONNX one, and an unmeasured
substitution inside a transcription engine is exactly the change that surfaces
later as a quality regression nobody can explain. It is the obvious next
improvement, and it needs a measurement first.

**Dynamic HumTrans.** Evaluated and rejected as a runtime engine: the published
checkpoint is not reproducibly obtainable and the repository states no licence.
Documented rather than worked around.
