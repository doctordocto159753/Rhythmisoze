# Backup and restore

## What is backed up, and what is not

| | Backed up | Why |
|---|---|---|
| Postgres | **yes** | published sketches and manage tokens; not reproducible |
| Published objects | **yes** | users' audio and MIDI; not reproducible |
| Model weights | no | ~1.43 GB, reproducibly downloadable, sha256-verified |
| Redis queue | no | transient by design |
| TLS certificates | no | Caddy reissues them automatically |

Backing up the weights would duplicate 1.4 GB with no recovery value: a restore
would run `scripts/models/bootstrap.sh` and get byte-identical files back.

## Taking a backup

```bash
./scripts/backup.sh                 # -> ./backups/<UTC timestamp>/
./scripts/backup.sh /mnt/external   # somewhere else
```

Produces:

```
database.dump     custom-format pg_dump
objects.tar.gz    the published-object volume
manifest.json     commit, branch, timestamp
```

`manifest.json` records which commit the backup came from, because restoring
into a schema that has moved on is the failure that actually happens.

The app keeps running throughout.

## Restoring

```bash
./scripts/restore.sh ./backups/20260821T120000Z
```

It prints the manifest and requires you to type `restore`. It is destructive:
`pg_restore --clean` drops objects before recreating them, so it is a
replacement rather than a merge that half-fails on conflicts.

## Automating it

```cron
15 3 * * * cd /srv/rhythmisoze && ./scripts/backup.sh >> /var/log/rhythmisoze-backup.log 2>&1
```

Keep the backups off the machine. A backup on the disk you are protecting
against is not a backup.

## Test the restore before you need it

Against a scratch project, not production:

```bash
docker compose -p rhythmisoze-restoretest -f compose.yaml up -d postgres
# point restore.sh at that project, then compare row counts against the source
```

An untested restore is a hope, not a backup. The scratch project shares no
volumes with the real one, so a mistake during the test cannot reach live data.
