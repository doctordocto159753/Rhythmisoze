# Updating a deployment

```bash
git pull
./scripts/deploy.sh
```

That is the whole procedure. It rebuilds changed images and restarts in place.

## What is and is not touched

| | |
|---|---|
| Database | migrated in place, never dropped |
| Published objects | untouched |
| Model weights | re-verified, not re-downloaded |
| Redis queue | flushed on restart, so jobs in flight are lost |

A generation in flight during a deploy is lost. That is acceptable and by
design: the user still has Unprocessed, Judge and Teacher, and can ask again.
Nothing already generated is affected, because completed Musician versions live
in the user's workspace rather than in the queue.

## Before updating anything that touches data

```bash
./scripts/backup.sh
```

## If an update goes wrong

```bash
git checkout <previous-sha>
./scripts/deploy.sh
```

Images rebuild from that commit. If the database schema moved forward and the
old code cannot read it, restore the backup you took first — which is why you
took it.

## Checking what you are running

```bash
docker compose ps
curl -s https://$SITE_DOMAIN/api/musician/status
```

Every Musician result also carries its own provenance — service version, both
model revisions, seed, sampling parameters, elapsed time — so a result can be
explained months later without guessing which build produced it.

## Updating the models themselves

Pinned deliberately. Changing a model revision means editing both
`models/manifest.json` and `third_party/MANIFEST.md`, then re-running the
bootstrap, which will download the new artifact and verify its new checksum.

Old results keep the revision they were generated with in their provenance, so a
model change never silently rewrites the history of what a user already heard.
