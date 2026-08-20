# Deployment

**US-1302.** What a clean production deploy needs, and in what order.

The important property to keep in mind while reading: **the whole local creation
experience works with none of this configured.** Record, transcribe, retouch,
choose an instrument, render, download WAV and MIDI — all of it runs with an
empty `.env`. Everything below exists only to add publishing.

## 1. Application

Vercel, or any host that runs a Next.js App Router build.

```bash
npm ci
npm run build
npm run start
```

Node 20.9 or newer.

## 1a. The microphone needs a secure context

The single most common way to see a broken-looking Rhythmisoze is to open it
over plain HTTP from something that is not `localhost` — a LAN address like
`http://192.168.1.20:3000`, or a domain without a certificate.

Browsers gate `getUserMedia`, the Cache API and service workers on a **secure
context**. On an insecure origin `navigator.mediaDevices` is simply not there,
so the app cannot record no matter how modern the browser is. The app detects
this specifically and says so — "this page needs a secure connection" rather
than "update your browser" — but it cannot work around it, because nothing can.

What counts as secure:

| Origin | Secure | Microphone |
|---|---|---|
| `https://anything` | yes | yes |
| `http://localhost:3000` | yes | yes |
| `http://127.0.0.1:3000` | yes | yes |
| `http://192.168.1.20:3000` | **no** | **no** |
| `http://some-host:3000` | **no** | **no** |

To test on a phone on the same network, one of:

- an HTTPS tunnel — `npx localtunnel --port 3000`, `cloudflared tunnel`, or
  `ngrok http 3000`; all of them terminate TLS for you;
- a local certificate — `mkcert` plus a reverse proxy in front of `next start`;
- a preview deployment, which is HTTPS by default.

Chrome can also be told to trust one insecure origin, which is useful for a
quick check and must not be how anyone else reaches the app:
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

## 2. Object storage

Vercel Blob. Create a store and take its read-write token.

```
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
```

Objects are written to `sketches/<id>/audio.wav` and `sketches/<id>/sketch.mid`
by direct client upload — the file never passes through a Function, which is what
keeps a 10 MB WAV under the 4.5 MB body limit.

**CORS:** Vercel Blob handles this for client uploads issued through
`handleUpload`. A different S3-compatible store needs `PUT` allowed from the
site origin, with `content-type` in the allowed headers.

This token also derives the publish ticket signing secret, so rotating it
invalidates any ticket currently in flight. That is a ten-minute window; rotate
it whenever you like.

## 3. Database

PostgreSQL. Neon through the Vercel Marketplace is the default recommendation —
Vercel Postgres is no longer a standalone product.

```
DATABASE_URL=postgres://user:pass@host/db?sslmode=require
```

Then:

```bash
npm run db:migrate
```

Idempotent, records what it applied in `schema_migrations`, safe to re-run and
safe to run against a database that is already current. Run it **before**
promoting a build that expects a new column.

## 4. Site URL

```
NEXT_PUBLIC_SITE_URL=https://rhythmisoze.behsazangame.info
```

Share links and the absolute OG image URL are built from this. A relative OG
image is silently dropped by most platforms, so getting this wrong shows up as
"the link preview is blank" rather than as an error.

## 5. Optional

```
NEXT_PUBLIC_ANALYTICS_ENDPOINT=   # empty = collect nothing at all
MAINTENANCE_TOKEN=                # required to enable the retention purge
PURGE_DELETED_AFTER_DAYS=30
NEXT_PUBLIC_BASIC_PITCH_MODEL_URL= # override the self-hosted model path
```

## 6. Scheduled job

If `MAINTENANCE_TOKEN` is set, call the purge daily:

```
POST /api/maintenance/purge
Authorization: Bearer $MAINTENANCE_TOKEN
```

On Vercel, a cron entry in `vercel.json`. Without the token the route refuses to
run rather than defaulting to open.

## Verification after a deploy

1. `/` redirects to a locale.
2. `/fa` renders right-to-left, `/en` left-to-right.
3. `/fa/design` renders every catalog section.
4. Tap four times, confirm a BPM appears.
5. Record something short. Confirm the review screen appears and the cleanup
   slider visibly moves notes.
6. Download the WAV and the MIDI. Open the MIDI in two different tools.
7. If publishing is configured: publish, open the share link in a private
   window, check the OG image at `/api/og?id=...`, then delete it and confirm the
   share page 404s.

## Environment matrix

| Variable | Preview | Production | Consequence if missing |
|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | preview URL | production URL | Share links and OG images point at localhost |
| `BLOB_READ_WRITE_TOKEN` | separate store | production store | Publishing hidden in the UI |
| `DATABASE_URL` | separate branch | production | Publishing hidden in the UI |
| `MAINTENANCE_TOKEN` | unset | set | Purge disabled |

**Preview deployments must not share the production store or database**
(US-1301). Neon database branching and a second Blob store are the intended
shape.
