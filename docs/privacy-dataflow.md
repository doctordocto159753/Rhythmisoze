# Privacy: what data exists, and where it goes

**Status:** current as of the GAME-first edition, 2026-08-27.

**In this edition you run the server.** Everything below still describes what
crosses a network boundary, but the party on the other side is you rather than a
third party. That does not make the boundary disappear: audio crosses it for
transcription and symbolic note data crosses it for Musician generation.

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
| Your recording | goes to the configured transcription service; never to the Musician |
| Note data | returns from transcription and goes to the Musician only when requested |
| Everything else | leaves only if you publish |

The original source remains the Raw export artifact. The PCM transport copy is
read by the transcription service; GAME's temporary request directory is
deleted after inference. The Musician request still has no audio field.

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

### Transcription and canonical Raw

| | |
|---|---|
| Data generated | PCM WAV transport, Raw notes/drums, route and tempo/rhythm analysis |
| Crosses network | **Yes** for audio; MIDI source is uploaded to the app API for canonical parsing |
| Received by | The app's `/api/transcription/*` routes and the internal transcription service |
| Persistence | IndexedDB, on the device |
| Retention | Until the user deletes the sketch |

GAME receives melodic PCM and deletes its per-request temporary WAV in a
`finally` path. Deliberately rhythmic material stays in the server rhythm route
and never enters GAME. The browser has no model fallback. The source Blob is
stored locally for exact Raw export; the service does not persist it.

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

This does not disable transcription. Audio still crosses the transcription
boundary; only the later symbolic Musician request is absent.

---

## Configuration that affects this

| Variable | Effect on data |
|---|---|
| `TRANSCRIPTION_ENABLED` | `false` makes audio transcription explicitly unavailable; it does not select a browser fallback |
| `TRANSCRIPTION_API_URL` | Internal destination for PCM transcription requests |
| `TRANSCRIPTION_REQUEST_TIMEOUT_MS` | Maximum lifetime of the app-to-transcriber request |
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
