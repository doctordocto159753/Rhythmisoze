# Troubleshooting

## The Musician area does not appear

By design, when the feature is not available. The app asks
`/api/musician/status` and renders nothing if the answer is no: a disabled
button would advertise something the deployment cannot provide.

```bash
curl -s localhost:3000/api/musician/status
```

| Response | Meaning |
|---|---|
| `{"enabled":false}` | `MUSICIAN_ENABLED` is not `true`, or `MUSICIAN_API_URL` is unset |
| `{"enabled":true,"reachable":false}` | configured, but the service is not answering |

For the second, check the workers:

```bash
docker compose logs melodyt5-worker rwkv-worker | tail -40
```

The usual cause is missing weights, and the log names the path it looked in.

## A generation fails but the app keeps working

That is the intended behaviour, not a bug being tolerated. Every Musician
failure path leaves Unprocessed, Judge and Teacher playable and offers a retry.

To see why:

```bash
docker compose logs musician-api | grep -i "job finished"
```

Logs carry job ids, phases and timings — never note data, unless
`MUSICIAN_LOG_NOTES=1` is set for a specific debugging session.

## Generation is slow

On CPU it is slow, and this is structural rather than a misconfiguration.
MelodyT5 generates **one bar per model call**, so a 16-bar variation is 16
forward passes, and the pipeline runs four candidates per variant.

If it is slower than you can accept:

- add a GPU and include `compose.gpu.yaml`;
- or lower `candidate_count` in the policy module, accepting a worse pick from a
  smaller pool.

Do not raise `MUSICIAN_MELODY_CONCURRENCY` above the number of loaded weight
copies. It queues work *inside* the worker, where the queue-depth metric cannot
see it, so the service looks idle while requests pile up.

## Out of memory

MelodyT5 is ~1.36 GB of fp32 weights plus activations; the container limit is
8 GB by default. On a smaller machine, run `MUSICIAN_ADAPTERS=fake` for product
work — everything except the two Musician versions behaves identically.

```bash
docker stats --no-stream
```

## curl reports a malformed URL

A carriage return got into the URL. On Windows this means a `.sh` file was
checked out with CRLF endings. `.gitattributes` pins `*.sh` to LF:

```bash
git rm --cached scripts/models/bootstrap.sh
git checkout scripts/models/bootstrap.sh
```

## A checksum mismatch during bootstrap

The download is corrupt or truncated. Delete the file and re-run; it resumes.

The script refuses to continue, deliberately: a checkpoint that loads but is not
the one recorded produces plausible output from the wrong model, which is far
harder to notice than an outright failure.

## Published audio 404s

Check the storage driver matches the deployment:

```bash
docker compose exec web printenv STORAGE_DRIVER
```

`local-disk` serves from the `objects` volume via `/api/objects/...`. If it
reports `vercel-blob` on a self-hosted box, `BLOB_READ_WRITE_TOKEN` is set and
is overriding the default.

## The GPU is not being used

```bash
docker info --format '{{json .Runtimes}}'
```

If `nvidia` is absent, the container runtime cannot see the card. On Linux
install the NVIDIA Container Toolkit; on Windows enable WSL integration in
Docker Desktop. `MUSICIAN_DEVICE=auto` will keep working on CPU meanwhile — it
degrades rather than failing, which is why a missing GPU is never an outage.
