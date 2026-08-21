# Self-hosting Rhythmisoze on one Linux server

One machine, Docker Compose, a domain name. No Kubernetes, no Terraform, no
cloud account.

---

## What you need

| | |
|---|---|
| Server | 4 vCPU, **16 GB RAM**, 40 GB disk. 8 GB works if you run `MUSICIAN_ADAPTERS=fake`. |
| OS | any current Linux with Docker Engine and Compose v2 |
| Domain | an A/AAAA record already pointing at the server |
| GPU | **optional.** CPU is the supported baseline. |

The RAM figure is driven by MelodyT5: ~1.36 GB of fp32 weights plus activations,
with a container limit of 8 GB by default.

---

## Deploy

```bash
git clone https://github.com/doctordocto159753/Rhythmisoze.git
cd Rhythmisoze
git checkout deploy/selfhosted-ai-musician-v1

cp .env.production.example .env
$EDITOR .env                 # set SITE_DOMAIN and ACME_EMAIL

./scripts/bootstrap.sh       # upstream source + ~1.4 GB of weights + secrets
./scripts/deploy.sh
```

`deploy.sh` runs:

```bash
docker compose -f compose.yaml -f compose.production.yaml up -d --build
```

Caddy obtains a TLS certificate for `SITE_DOMAIN` automatically. That is most of
why it is the proxy here: a single-server deployment should not involve certbot
cron jobs.

---

## What is exposed

**Only Caddy.** Ports 80, 443 and 443/udp.

Everything else — the web app, the Musician API, both model workers, Redis and
Postgres — is on the internal network with no published port. The workers in
particular hold gigabytes of weights and have no authentication, because they
were designed on the assumption that only the app can reach them.

You can check this on your own machine:

```bash
docker compose -f compose.yaml -f compose.production.yaml config \
  | grep -A2 'ports:'
```

---

## What persists

| Volume | Contents | Backed up |
|---|---|---|
| `postgres` | published sketches, manage tokens | **yes** |
| `objects` | published audio and MIDI | **yes** |
| `redis` | the generation queue | no — transient by design |
| `caddy-data` | TLS certificates | no — reissued automatically |
| `./models` | model weights | no — reproducibly downloadable, sha256-verified |

Container recreation does not touch any of them. `docker compose down -v` does.

---

## Updating

```bash
git pull
./scripts/deploy.sh
```

Rebuilds and restarts in place. Weights are not re-downloaded: the bootstrap
verifies what is present and skips it.

See [`update.md`](update.md).

---

## Backups

```bash
./scripts/backup.sh                    # -> ./backups/<timestamp>/
./scripts/restore.sh ./backups/<stamp>
```

See [`backup-restore.md`](backup-restore.md). Test the restore before you need
it.

---

## Bounds worth knowing

- **Queue** — Redis with `maxmemory 256mb` and `noeviction`, so a flood is
  rejected rather than silently dropping jobs.
- **Model concurrency** — one worker per model by default. Raising it beyond the
  number of loaded weight copies queues work *inside* the worker, where it is
  invisible.
- **Generation timeout** — 300 s, after which the job is cancelled server-side.
- **Request body** — 24 MB at the proxy, plus the app's own per-file caps.
