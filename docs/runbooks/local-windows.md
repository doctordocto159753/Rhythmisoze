# Running Rhythmisoze locally on Windows

Everything runs in Docker. **You do not need Python, Conda, or any model
tooling on your machine** — the containers own those dependencies.

---

## Once

1. **Docker Desktop**, with the WSL2 backend. Start it and wait for the whale
   icon to go steady.
2. Clone the repository and run:

```powershell
./scripts/bootstrap.ps1
```

That fetches the pinned upstream model source, downloads ~1.4 GB of weights
(verifying every byte against `models/manifest.json`), and writes a `.env` with
fresh secrets.

It takes a while and it prints what it is doing. If it stops, it stops with a
reason.

---

## Every time

```powershell
./scripts/start-local.ps1
```

Then open **http://localhost:3000**.

The script detects an NVIDIA GPU and uses the GPU profile when Docker can see
the NVIDIA runtime. It falls back to CPU otherwise, and **CPU is the supported
baseline** — nothing is missing without a GPU except speed.

To stop:

```powershell
docker compose down
```

Your work is in Docker volumes and survives that. `docker compose down -v`
deletes the volumes; that is the one command that throws work away.

---

## Working without the models

The whole product except the two Musician versions works with no weights at all:

```powershell
$env:MUSICIAN_ADAPTERS = "fake"
./scripts/start-local.ps1
```

Deterministic stand-ins replace both models. Useful when you are working on the
UI and do not want 1.4 GB or a warm-up wait.

To turn the Musician off entirely, set `MUSICIAN_ENABLED=false` in `.env`. The
Musician area then does not render at all, and the app behaves exactly as it did
before the feature existed.

---

## Checking the real models actually work

```powershell
./scripts/verify-real-stack.ps1
```

This is the gate that matters. It verifies the weights against their checksums,
builds and starts the stack, waits for readiness, prints the model revisions the
service actually loaded, and runs a real Refined and a real Developed
generation.

Green fake tests do not imply this passes. That is the whole reason it exists.

---

## When something is wrong

| Symptom | What it means |
|---|---|
| `Musician versions are not available` in the UI | weights missing, or a worker did not start. `docker compose logs melodyt5-worker` |
| `bootstrap.ps1` reports a checksum mismatch | a corrupt or truncated download. Delete the file and re-run; it resumes. |
| the GPU is not used | Docker Desktop → Settings → Resources → WSL Integration, then restart Docker |
| port 3000 is busy | set `WEB_PORT=3001` in `.env` |
| a generation takes minutes on CPU | expected. See `docs/runbooks/troubleshooting.md` for measured figures. |

More in [`troubleshooting.md`](troubleshooting.md).
