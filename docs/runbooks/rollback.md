# Rollback and recovery

**US-1304.** Containing a bad release quickly.

## Ownership

| Role | Responsibility |
|---|---|
| Release owner | Decides to roll back. Does not need permission to. |
| Platform owner | Database and object storage access |
| On call | First responder |

Fill in names before the first production release. An unassigned runbook is a
document, not a plan.

## Frontend rollback

The fast path, and the one that covers most incidents.

1. Vercel dashboard → Deployments → the last known-good build → **Promote to
   Production**.
2. Verify: `/` redirects, `/fa` renders RTL, `/fa/design` loads, an existing
   share link still plays.

Under a minute, and it is safe because **published objects and their URLs are
independent of the frontend build**. A share link that worked before the bad
deploy works during it and after the rollback. Nothing the frontend does can
orphan a published sketch.

## Database rollback

Harder, and worth avoiding by design.

Migrations are additive by policy: new nullable columns, new tables, new
indexes. No migration drops or renames a column in the same release that stops
using it. That means **the previous build can always read the current schema**,
which is what makes a frontend rollback safe on its own.

If a migration must genuinely be reverted:

1. Confirm the previous build cannot read the current schema. Usually it can,
   and no revert is needed.
2. Write a forward migration that undoes it. Do not hand-edit
   `schema_migrations`.
3. Take a backup first — Neon's point-in-time restore covers this.

## Object storage

Objects are never mutated, only created and deleted. There is nothing to roll
back. A deleted object inside the retention window is recovered by clearing the
tombstone — see `publish-retention.md`.

## Local user data

Cannot be rolled back and does not need to be: IndexedDB lives on the user's
device and is untouched by a deploy. A schema change to `LocalSketch` must
therefore be forward-compatible — `schemaVersion` is on every row so a migration
can decide per record, and Dexie's version chain handles the store itself.

**A release that would make old local sketches unreadable is not shippable.** It
would destroy work the user has no other copy of, which is a P0 by the
playbook's own definition.

## Incident checklist

1. **Assess.** Is local creation broken, or only publishing? Local is the
   product; publishing is an add-on. A publishing outage is a P2; a broken
   record button is a P0.
2. **Contain.** Promote the last good deployment.
3. **Verify.** Run the checks at the end of `deployment.md`.
4. **Communicate.** If sketches were lost, say so plainly and say what was lost.
5. **Diagnose** afterwards, not during.
6. **Record.** What broke, what the signal was, and what would have caught it.

## Kill switches

Neither requires a deploy:

| To stop | Do |
|---|---|
| All publishing | Unset `BLOB_READ_WRITE_TOKEN`. The UI hides the action rather than failing at upload. |
| The retention purge | Unset `MAINTENANCE_TOKEN`. The route returns 503. |

Local creation has no kill switch, on purpose. There is no server-side way to
break it, which is the point of the architecture.
