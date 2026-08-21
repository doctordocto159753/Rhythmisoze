# The self-hosted edition

**Branch:** `deploy/selfhosted-ai-musician-v1`
**Date:** 2026-08-21

This branch is the complete Rhythmisoze: the three local versions, the AI
Musician, and everything needed to run the whole thing on one Linux server you
own. `main` remains the Vercel prototype and is not affected by anything here.

---

## Why it is a separate branch

Two reasons, and the second is the one that forced it.

**The deployment target is different.** `main` is Vercel-shaped: serverless
functions, blob storage, a 4.5 MB request-body limit that publishing works
around with client-side direct upload. This edition assumes one box with Docker,
where the app can simply receive a file and a GPU can be attached.

**The feature branches carry a model weight in their history.** `midi_rwkv.pth`,
70,224,852 bytes, was committed to the repository root when a download's `cd`
silently failed and the directory-scoped ignore rules did not reach it. Removing
it in a later commit would leave it in history and in every clone forever. So
this branch was cut from `main` and the *tree* of the feature branches was
imported, without their history.

---

## The five versions

```text
        audio / MIDI
             │
   extraction + intent routing
             │
      UNPROCESSED  ─── direct extraction
             │
       MUSICAL JUDGE
             │
         JUDGE      ─── closest reconstruction
             │
       MUSIC TEACHER
             │
        TEACHER     ─── conservative musical correction
             │
        AI MUSICIAN
        ┌────┴────┐
   REFINED    DEVELOPED
```

Each layer answers a different question, and the boundaries are not
housekeeping — they are what keeps the first half measurable:

| Version | Question | May |
|---|---|---|
| Unprocessed | what came out of extraction? | nothing |
| Judge | did we understand the human? | repair harmonics, octaves, fragmentation, durations |
| Teacher | what would a conservative teacher fix? | move existing notes, deterministically, with reasons |
| Musician — Refined | how would a musician polish *this* idea? | reshape, within a high identity floor |
| Musician — Developed | where could this idea go, one step further? | develop, within a lower but real floor |

The Judge has ground truth — the audio — so it can be benchmarked. The moment it
is allowed to make things *nicer*, that property is gone. Musician
responsibilities therefore never move backwards into the Judge or the Teacher.

All five render through the **same instrument engine**, which is what makes an
A/B comparison a comparison of the music rather than of two synthesisers.

---

## Runtime topology

```text
                        Internet
                           │
                       Caddy  (the only public service, terminates TLS)
                           │
                     Next.js web
                           │  /api/musician/*  — server-side proxy
                     musician-api
                           │
                  ┌────────┴────────┐
          melodyt5-worker      rwkv-worker        Redis      Postgres
        (global variation)   (local infill)      (queue)     (published)
```

Three interpreters, deliberately. MelodyT5's published stack is an old
Python/PyTorch line; MIDI-RWKV's is 3.11 with rwkv.cpp. Resolving both against
each other produces an environment nobody can reproduce or upgrade.

**The browser never learns the service URL.** It talks to the app's own origin;
the proxy holds the address. Publishing it would turn an internal service with
no authentication into a public inference endpoint.

---

## What changed for self-hosting

| Concern | On `main` | Here |
|---|---|---|
| Published objects | Vercel Blob | `StorageDriver` seam, `local-disk` by default |
| Upload path | scoped token, direct to store | `POST /api/publish/upload`, same ticket checks |
| Database | hosted Postgres | Postgres container, same `postgres` client |
| Web runtime | Vercel functions | `output: standalone` image |
| Queue | none | Redis, `appendonly`, bounded, `noeviction` |

The storage seam is two questions, not a wrapper around a vendor API: *how does
a client get bytes in?* and *what URL are they readable at?* Vercel answers the
first with a token, local disk with an ordinary POST. Neither is emulated in
terms of the other, because emulating direct-upload on disk would mean inventing
a token system nobody needs.

An S3 driver is a third file. It is not written speculatively — an untested
adapter for a service nobody has configured is a liability, not an abstraction.

---

## What is verified, and what is not

This distinction is the point of the document.

**Verified**

- the git properties: `main` untouched, no weight tracked, largest blob in the
  branch's unique history is a 43 KB source file;
- only Caddy is published in the production overlay — asserted in CI, not
  reviewed;
- all three compose configurations parse;
- the MelodyT5 prompt against the **real upstream Patchilizer**: task parses as
  `variation`, 12 notes → 9 patches × 64 bytes, lossless round-trip;
- the MIDI-RWKV infill layout against the **real 663-token vocabulary**:
  `Infill_Bar`=3, `FillBar_Start`=5, `FillBar_End`=6, and a 4-bar stream with
  bars 1–2 masked produces exactly the documented sequence;
- the model bootstrap on the real 70 MB artifact, across all four paths;
- 574 web unit tests, 153 E2E, 104 service tests.

**Not verified**

- **the real models have not been run.** See
  [`melodyt5-runtime-decision.md`](melodyt5-runtime-decision.md) for exactly
  where that stands and what will settle it;
- consequently, no benchmark figures are claimed;
- the GPU profile is configured and validated but has not been exercised against
  a loaded model;
- backup and restore scripts are written and syntax-checked but have not been
  round-tripped against a populated database.

`scripts/verify-real-stack.sh` is the gate for the first two. Until it has run
green, this branch is not production-ready, and saying otherwise because the
test suites are green would be exactly the substitution this document exists to
prevent.
