# Publish retention and deletion

**US-1007, questionnaire Q-C3.**

## What the owner asked for

Q-C3 selects "keep files privately for recovery" over immediate purge.

## What actually happens, and where it falls short

`DELETE /api/publish/[id]` with a valid management token:

1. sets `deleted_at` on the row;
2. every read path filters on `deleted_at IS NULL`, so the share page, the OG
   image and the metadata API stop serving immediately;
3. the audio and MIDI objects are **left in place** for
   `PURGE_DELETED_AFTER_DAYS` (default 30);
4. the purge job then deletes them and blanks the URLs, keeping the tombstone.

**The gap, stated plainly:** the object store serves *public* URLs. During the
retention window the raw asset URL remains reachable by anyone who already has
it — a crawler, a chat app's link preview cache, a recipient who saved it.
"Privately" is not achievable with a public-access store; what deletion gives
immediately is that the sketch is no longer *discoverable or presented* anywhere
by the product.

If genuinely private retention is required, it needs a store with signed reads,
and the deletion path would copy the objects to a private prefix before removing
the public ones. That is a real change, not a configuration flag.

## Running the purge

```
POST /api/maintenance/purge
Authorization: Bearer $MAINTENANCE_TOKEN
```

Processes up to 100 rows per call, deletes both objects together — a
half-purged sketch would leave the audio reachable while the MIDI was gone —
and reports `{ scanned, purged, failures, retentionDays }`. A failure is
recorded and skipped, and retried on the next run.

Without `MAINTENANCE_TOKEN` the route returns 503. With a wrong token it returns
404, not 403, so its existence is not confirmed to a prober.

## Operational recovery

While a sketch is inside the window, restoring it is a one-line update:

```sql
UPDATE published_sketches SET deleted_at = NULL WHERE id = '<id>';
```

The objects are still there, so the share page works again immediately. After
the purge the row survives as a tombstone but the audio is gone; recovery then
means the creator re-publishing from their local copy, which is why the local
workspace keeps note data even under storage pressure.

## Retention policy summary

| Event | Metadata | Objects | Public page |
|---|---|---|---|
| Published | live | live | live |
| Deleted by creator | tombstoned | retained | 404 immediately |
| After the window | tombstoned | deleted | 404 |
| Local sketch deleted | untouched | untouched | untouched |

That last row matters: deleting a sketch from the local workspace does **not**
unpublish it. The workspace copy says so, because the alternative — a delete
that silently reaches out to the network — would break the local-first promise.
