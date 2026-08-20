# ADR-004 — Anonymous publishing with a management token

**Status:** Accepted
**Date:** 2026-08-19
**Related:** US-1001, US-1003, US-1007, questionnaire Q-C1, Q-C2, Q-C3

---

## Context

US-1001 requires an ownership model before publishing can be built. The
questionnaire answers it: **Q-C1 selects anonymous publish with a secret
management/delete token**, over the sign-in-at-publish alternative. Q-C2 leaves
the auth provider open ("lowest-friction supported option"), which under Q-C1
means no provider is required at all.

The playbook's constraint is that authentication must never gate local creation,
and that deletion ownership must be defined.

## Decision

**No accounts. A server-issued management token is the sole proof of ownership.**

The flow, and the reason each step exists:

1. `POST /api/publish/prepare` — **the server mints the public id.** A client
   that chooses its own id can aim an upload or a record at one already in use.
   The response carries a signed, ten-minute ticket binding that id.
2. `POST /api/publish/blob` — the upload-token route. It issues a storage token
   only for `sketches/<id>/audio.wav` or `sketches/<id>/sketch.mid`, only for an
   id carried by a valid ticket, with the content type and maximum size fixed.
   The file never passes through a Function, which keeps a 10 MB WAV under
   Vercel's 4.5 MB body limit.
3. `POST /api/publish` — re-verifies the ticket and checks both returned URLs
   live under the authorized prefix by *path*, not by substring, then writes the
   row and returns the management token once.

Token handling:

- 24 random bytes, base64url. Only its SHA-256 hash is stored, so a database
  dump does not hand out delete rights.
- Compared in constant time (`timingSafeEqual`).
- Held in `localStorage` per sketch. The UI says plainly that it is the only way
  to delete later.

Deletion (`DELETE /api/publish/[id]`) returns an identical 404 for a wrong
token, an unknown id and an already-deleted sketch. Distinguishing them would
make the endpoint an oracle for which share links exist.

## Consequences

**Positive**

- Zero friction at the one moment a user is trying to finish.
- No auth provider, no session store, no password reset, no OAuth callback.
- Nothing about a person is stored. The published row has no user column.

**Negative**

- **Losing the token means losing the ability to delete.** For a user who
  publishes on one device and clears storage, the only route is an operational
  one. The UI warns; that does not make it painless.
- No cross-device management, and no "my published sketches" list.
- Q-C3 asked for deleted files to be kept privately for recovery. The object
  store serves public URLs, so during the retention window the raw asset URL
  remains reachable by anyone who already has it. What deletion does immediately
  is tombstone the record, which takes the share page, the OG image and the API
  out of service. See `docs/runbooks/publish-retention.md`.

## Follow-up

Q-F3 records cross-device sync as post-MVP. If it is promoted, the published
schema is extensible: adding a nullable `owner_id` alongside the token hash lets
an account claim existing anonymous sketches without a migration of the public
ids.
