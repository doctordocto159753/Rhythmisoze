# AI Musician service

Generative symbolic layer after the Teacher. Two variants, one API.

- **Pipeline and design:** [`docs/architecture/musician-pipeline.md`](../../docs/architecture/musician-pipeline.md)
- **Runtime decisions:** [`docs/architecture/musician-runtime-adr.md`](../../docs/architecture/musician-runtime-adr.md)
- **Running it:** [`docs/runbooks/musician-local.md`](../../docs/runbooks/musician-local.md)

## Layout

```
api/              orchestrator, the only product-facing service  (Python 3.12)
shared/           canonical contract, Identity Guard, pipeline   (no heavy deps)
melodyt5-worker/  global variation, INTERNAL ONLY                (Python 3.10)
rwkv-worker/      local infill, INTERNAL ONLY                    (Python 3.11)
tests/            104 tests, none of which need model weights
```

Three interpreters is not an accident. MelodyT5's published stack is an old
Python/PyTorch line and MIDI-RWKV's is 3.11 with rwkv.cpp; resolving both against
each other produces an environment nobody can reproduce or upgrade.

## Working on it without weights

```bash
pip install -e shared -e "api[dev]"
python -m pytest          # ~20 s
```

Both models sit behind adapters with deterministic fakes, so orchestration, the
Identity Guard, ranking, span selection, the contract and the API are all
exercised with nothing downloaded.

## Running it for real

See the runbook. In short: `scripts/vendor/bootstrap.sh`, then
`scripts/models/bootstrap.sh` (~1.43 GB), then `docker compose up --build`.

CPU is the baseline and works on any machine. GPU is optional:
`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up`.
