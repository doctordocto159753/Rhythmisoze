# Authoritative transcription service

This service owns Rhythmisoze's initial musical reading of audio.

```text
PCM WAV -> server router -> GAME small (melody) -> canonical Raw
                         -> rhythm extractor     -> canonical Raw
```

There is no optional-witness mode and no browser transcriber fallback. If GAME
cannot run, melodic requests return an explicit 503. Deliberate rhythm is never
sent through GAME.

## Raw contract

Both development and production backends return the same `RawTranscription`
shape: absolute source seconds, discrete and optional continuous pitch,
velocity/confidence where known, duration, immutable provenance and model
identity. The Next.js API builds phrase/rhythm analysis from that value on the
server. Retouch, Teacher and Musician receive copies and cannot replace Raw.

MIDI does not enter this service. `/api/transcription/midi` parses the original
SMF event stream on the Next.js server and preserves pitch, onset/offset in both
ticks and seconds, velocity, source order, original track/channel, PPQ, format,
tempo map and time signatures. Raw MIDI export returns the original Blob rather
than a reconstruction; derived MIDI is written from the canonical metadata.

## Development: GAME small PyTorch

The weights are intentionally outside git and images because they are
CC BY-NC-SA 4.0 while this repository is MIT.

```bash
scripts/models/bootstrap.sh game
docker compose up -d --build transcription web
docker compose exec -T transcription python -c \
  "import urllib.request; print(urllib.request.urlopen('http://localhost:8083/ready').read().decode())"
```

Expected readiness includes:

```json
{"ready":true,"engine":"game","backend":"upstream-cli","modelTier":"large","modelVersion":"1.0.0","detail":null}
```

Relevant configuration:

```text
GAME_BACKEND=upstream-cli
GAME_MODEL_TIER=large
GAME_MODEL_VERSION=1.0.0
GAME_RANDOM_SEED=
TRANSCRIPTION_MODEL_DIR=/models/game-large
```

`GAME_MODEL_TIER` selects nothing in code. It is a label that travels into Raw
provenance, and `TRANSCRIPTION_MODEL_DIR` decides which weights actually run.
Because those two can disagree silently, the service reads the `config.yaml`
upstream ships beside the weights and refuses readiness when the checkpoint is
not the size the deployment claims. Running the small weights is a supported
deployment; it means setting **both** variables.

`GAME_RANDOM_SEED` is empty by default, which is upstream behaviour. Set an
integer only to hold GAME's D3PM sampling still while comparing two builds —
see below.

## There is one inference path, and it is upstream's

`infer.py extract`, run as a subprocess against the checkout pinned in the
Dockerfile. This service provides a WAV, invokes GAME, and parses the CSV it
writes. It does not know how GAME slices audio, samples boundaries, converts
them to durations, or stitches chunk results back together.

That is the result of measurement rather than taste. Two backends that
reimplemented GAME's extraction over the exported ONNX graphs were built and
both were less musical than simply running the command — the second one even
after its slicer was verified byte-identical to upstream's and its note
reconstruction matched upstream's arithmetic exactly. Both are gone; the last
commit containing them is `c49d8d5`.

Two known deviations from a bare standalone run remain, and only two:

| Deviation | Why |
|---|---|
| MKLDNN disabled on CPU hosts | The deployment host takes SIGFPE in oneDNN under GAME's graph. See `game_runner`. Not threading, and the thread count is deliberately left alone. |
| `--output-formats csv --pitch-format number` | Upstream's default writer is MIDI, which rounds every pitch to an integer. Both flags select a writer; neither changes what GAME extracts. |

Everything that decides notes — thresholds, decoding radius, D3PM schedule,
batch size, language — is left unsaid so upstream's defaults apply.

## HTTP boundary

| Endpoint | Contract |
|---|---|
| `GET /health` | process liveness; does not claim model readiness |
| `GET /ready` | backend/tier/version plus 200 ready or explanatory 503 |
| `POST /transcribe` | multipart 16-bit PCM WAV + `mode`; canonical Raw + classification |

The adapter gives upstream GAME a per-request temporary WAV and removes the
whole request directory in a `finally` block. No note value is rounded away:
`continuousPitch` keeps GAME's fractional estimate while `pitchMidi` is the
documented discrete representation used by MIDI consumers.

## CPU launcher

The pinned CPU runtime previously hit a native MKLDNN SIGFPE. The launcher
disables MKLDNN only in the CPU GAME inference child (CUDA is untouched), then
runs upstream's pinned `infer.py`. Tests pin that decision, argument forwarding,
temporary-file cleanup, deterministic seed and Raw normalization.
