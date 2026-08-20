# Abuse and moderation

**US-1008, questionnaire Q-C4.**

## The decision

Q-C4 selects **no public report action; internal operational process only**.
There is no report button on the share page.

That is defensible for the current shape of the product — links are unguessable
and there is no discovery surface, so content does not spread except by someone
deliberately sharing it. It stops being defensible if an explore page is ever
added, and this document should be revisited at that point.

## Technical controls in place

| Control | Value | Where |
|---|---|---|
| Prepare rate limit | 6 / minute / client | `api/publish/prepare` |
| Publish rate limit | 6 / minute / client | `api/publish` |
| Delete rate limit | 20 / minute / client | `api/publish/[id]` |
| Play-count rate limit | 30 / minute / client | `api/share/[id]/played` |
| Max duration | 60 s, enforced server-side | `MAX_PUBLISH_DURATION_SEC` |
| Max audio size | 16 MB | `MAX_AUDIO_BYTES` |
| Max MIDI size | 512 KB | `MAX_MIDI_BYTES` |
| Allowed content types | `audio/wav` and `audio/midi` only | `api/publish/blob` |
| Allowed object paths | `sketches/<id>/{audio.wav,sketch.mid}` only | `api/publish/blob` |
| Title sanitisation | bidi and control characters stripped, 80 chars | `sanitizeTitle` |

The content-type and path restrictions matter beyond abuse: they stop the object
store being used to host an HTML page or an executable under the site's domain.

### The rate limiter's honest limitation

It is an in-memory fixed window, so it is **per serverless instance** and resets
on cold start. The effective limit across a scaled deployment is higher than the
numbers above. It stops the case it needs to stop — one client looping the
endpoint — at zero infrastructure cost. A deployment that needs a real global
limit should put one in front of the route (Vercel Firewall, or a Redis
counter); the code interface does not change.

## Operational process

Receiving a complaint (no public path exists; expect email or a direct message):

1. Get the share URL. The id is the last path segment.
2. Open it and assess.
3. To take it down:
   ```sql
   UPDATE published_sketches SET deleted_at = NOW() WHERE id = '<id>';
   ```
   The share page, the OG image and the API stop serving immediately. The
   objects follow the retention window.
4. Record the id, the date and the reason in an operational log. Not in this
   file, and not with any content from the sketch.
5. Repeat offenders cannot be identified — publishing is anonymous by design
   (ADR-004). The lever available is the rate limit, not a ban.

## What is deliberately not done

- **No scanning of unpublished audio.** US-1008 is explicit about this, and it
  would break the product's central promise.
- **No automated content classification.** It would require the audio
  server-side, which the architecture does not have.
- **No account bans.** There are no accounts.

## If a discovery surface is added

Everything above assumes obscurity is doing part of the work. An explore page
removes that, and would need at minimum: a public report action, a moderation
queue, and a decision about pre- or post-moderation. That is a product decision
rather than an implementation detail, and it belongs in a new questionnaire
round.
