# Privacy: what data exists, and where it goes

**Status:** current as of the self-hosted edition, 2026-08-21.

**In this edition you run the server.** Everything below still describes what
crosses a network boundary, but the party on the other side is you rather than a
third party. That does not make the boundary disappear -- symbolic note data
still leaves the browser -- and this document does not soften its language on
that basis.

This document exists because the product used to say *"nothing is uploaded"* and
that stopped being universally true. It is a per-operation account rather than a
policy statement, so that any claim in the UI can be checked against it.

**Rule for changing this file:** if an operation starts sending something it did
not send before, this table changes in the same commit as the code. A dataflow
document that lags the code is worse than none, because people rely on it.

---

## Summary

| | |
|---|---|
| Your recording | **never leaves your device**, in any operation, including the Musician |
| Note data | leaves only if you ask the Musician for extra versions |
| Everything else | leaves only if you publish |

The one thing that changed: **symbolic note data now goes to a server** when the
user asks for Musician versions. Audio does not, and there is no code path by
which it could — the request type has no field that can carry it.

---

## Per operation

### Recording

| | |
|---|---|
| Data generated | Microphone audio (`Blob`), decoded PCM in memory |
| Crosses network | **No** |
| Received by | Nothing. `MediaRecorder` and Web Audio, in the browser |
| Persistence | IndexedDB, on the device, as the sketch's source asset |
| Retention | Until the user deletes the sketch. Evicted first under storage pressure |

### Transcription (Unprocessed, Judge, Teacher)

| | |
|---|---|
| Data generated | Note events, drum events, pitch contour, tempo/meter/key analysis |
| Crosses network | **No** |
| Received by | A Web Worker in the browser. Basic Pitch runs locally via TensorFlow.js |
| Persistence | IndexedDB, on the device |
| Retention | Until the user deletes the sketch |

The Judge and Teacher are deterministic local code. No model weights are fetched
from anywhere but the app's own origin, and no audio is transmitted.

### Musician versions (Refined, Developed) — **the network operation**

Only when the user presses "Create musician versions".

| | |
|---|---|
| Data generated | Teacher note events, tempo, meter, key, a sketch id, a seed |
| Crosses network | **Yes** |
| Received by | The app's own `/api/musician/*` route, which forwards to the Musician service |
| Persistence | Server-side: the job and its result, in Redis, keyed by job id |
| Retention | `MUSICIAN_JOB_TTL_SEC`, **1 hour by default**, then discarded |

**What is sent:** pitch, start time, end time and velocity per note; BPM; time
signature; detected key; an opaque sketch id; an integer seed.

**What is not sent, and cannot be:**

- the recording, or any audio at all;
- the sketch title;
- the rendered WAV;
- any account, email or device identifier — there are none in the product;
- an IP-linked profile: the service stores no request log tied to a user.

The sketch id is a locally generated random id. It identifies the sketch to
match a result back to it; it is not linked to a person, and the service never
sees anything else that could be.

**Enforced by:** `MusicianRequest` in
[`src/packages/musician-client/client.ts`](../src/packages/musician-client/client.ts)
has no field that accepts a `Blob`, and the proxy route rejects any request that
is not JSON under 1 MB. Both are covered by tests.

### Instrument rendering

| | |
|---|---|
| Data generated | Rendered WAV |
| Crosses network | **No** |
| Received by | `OfflineAudioContext` in the browser |
| Persistence | IndexedDB, dropped first under storage pressure |
| Retention | Until the user deletes the sketch or storage reclaims it |

Sample packs are static assets served from the app's own origin. Fetching them
reveals which instrument was chosen to whoever serves the app, in the same way
any image request does.

### Export

| | |
|---|---|
| Data generated | A zip: rendered WAV, MIDI per available version, the original source file, a manifest |
| Crosses network | **No** |
| Received by | The user's own filesystem |
| Persistence | Wherever the user saves it |
| Retention | Theirs |

The manifest includes model revisions and seeds for Musician versions, so an
exported package is self-describing.

### Publish

| | |
|---|---|
| Data generated | Rendered WAV, MIDI of the selected version, title, tempo, key, instrument |
| Crosses network | **Yes** |
| Received by | The app's publish endpoint |
| Persistence | Server-side, until deleted with the manage token |
| Retention | Until the user deletes it |

**Publishing does not include the original recording.** `PublishedSketch` has no
field for it, deliberately.

Publishing sends the **selected version only** — the minimal change, per the
brief. The selected version id is recorded in the metadata so a listener knows
which reading they are hearing.

**The Musician's existence does not change this.** The service now provides
server infrastructure, and that is not a reason to start uploading source audio.
Any future change here needs its own decision and its own consent, not an
inference from "we have servers now".

---

## When the Musician is disabled

`MUSICIAN_ENABLED=false`, or no `MUSICIAN_API_URL`, and the network operation in
this document does not exist. The product runs its three local versions with no
outbound traffic beyond loading the app and publishing.

This is not a degraded mode. It is the default, and everything except the two
Musician versions works identically.

---

## Configuration that affects this

| Variable | Effect on data |
|---|---|
| `MUSICIAN_ENABLED` | `false` means no note data leaves the device, ever |
| `MUSICIAN_API_URL` | Where note data goes. **Server-side only** — never exposed to the browser |
| `MUSICIAN_REQUEST_TIMEOUT_MS` | How long a request may live before it is abandoned |
| `MUSICIAN_JOB_TTL_SEC` | How long the service keeps a job and its result |
| `MUSICIAN_MAX_QUEUE_DEPTH` | How many jobs may wait before the service refuses. A refused job holds no note data at all |
| `STORAGE_DRIVER` | `local-disk` keeps published audio on your own volume; `vercel-blob` sends it to Vercel |

The service URL is deliberately never sent to the client. The browser talks only
to the app's own origin; a status endpoint answers "is this available" with a
boolean and nothing else.

---

## What is not claimed

- **No claim that the service forgets immediately.** It holds the job for its
  TTL, an hour by default. That is a real retention window and it is stated.
- **No claim about the hosting provider.** Whoever runs the service can see the
  traffic reaching it; that is true of any hosted service and is not something
  this app can promise away. In the self-hosted edition that party is the
  operator, which is better for a user who trusts the operator and no different
  for one who does not.
- **No claim that self-hosting makes the network operation disappear.** It moves
  where the data goes, not whether it goes.
- **No claim of anonymity beyond what is structural.** There are no accounts and
  no identifiers, so there is nothing to link requests to a person — but a
  server can always see an IP address, and this document will not pretend
  otherwise.
