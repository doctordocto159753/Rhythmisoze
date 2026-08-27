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
{"ready":true,"engine":"game","backend":"pytorch","modelTier":"small","modelVersion":"1.0.0","detail":null}
```

Relevant configuration:

```text
GAME_BACKEND=pytorch
GAME_MODEL_TIER=small
GAME_MODEL_VERSION=1.0.0
GAME_RANDOM_SEED=0
TRANSCRIPTION_MODEL_DIR=/models/game
```

The seed fixes GAME's stochastic D3PM sampling so a source/model pair is
reproducible. It does not tune a threshold or modify GAME note events.

## Production target: GAME large 1.0.3 ONNX

The runtime selection boundary exists, but the ONNX runner does not. This is an
explicit deployment blocker—not simulated support. The official graph set needs
a real encoder -> D3PM segmentation -> estimator implementation and parity
evidence before it can become ready.

The intended configuration is executable:

```bash
docker compose -f compose.yaml -f compose.game-large-onnx.yaml up -d transcription
```

Today `/ready` truthfully returns 503 with
`GAME large ONNX runner is not implemented`. Completing the handoff means:

1. load and validate the official 1.0.3 large graph/config files;
2. implement the upstream preprocessing and D3PM sampling semantics;
3. normalize output only at the shared Raw boundary;
4. run standalone-large versus integrated-Raw parity;
5. change ONNX readiness only after real inference passes.

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
