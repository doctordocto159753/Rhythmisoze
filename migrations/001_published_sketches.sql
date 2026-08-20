-- US-1002 / US-1004 - published sketch metadata.
--
-- One table. A published sketch is a small immutable record plus a play
-- counter; there is nothing here that wants a second table yet, and inventing
-- one now would be schema written for a feature that does not exist.
--
-- Deliberately absent: any column that could hold audio, note data or a user's
-- original recording. The objects live in blob storage and are referenced by
-- key, and the raw microphone capture never reaches the server at all
-- (Playbook 13: "do not store raw unpublished microphone recordings").

CREATE TABLE IF NOT EXISTS published_sketches (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT '',
  bpm               INTEGER NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('melody', 'rhythm')),
  key_root          TEXT,
  key_mode          TEXT CHECK (key_mode IS NULL OR key_mode IN ('major', 'minor')),
  instrument_id     TEXT NOT NULL,

  audio_key         TEXT NOT NULL,
  audio_url         TEXT NOT NULL,
  midi_key          TEXT NOT NULL,
  midi_url          TEXT NOT NULL,

  duration_sec      REAL NOT NULL CHECK (duration_sec > 0 AND duration_sec <= 60),
  locale            TEXT NOT NULL DEFAULT 'fa',

  -- Q-C1: anonymous publish with a secret management token. Only the SHA-256
  -- hash is stored, so a database dump does not hand out delete rights.
  manage_token_hash TEXT NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- US-1007: tombstone. The share page and the API filter on this immediately;
  -- the objects are removed later by the purge job (Q-C3 retention).
  deleted_at        TIMESTAMPTZ,
  play_count        INTEGER NOT NULL DEFAULT 0,
  schema_version    INTEGER NOT NULL DEFAULT 1
);

-- The share page's lookup: by id, alive only.
CREATE INDEX IF NOT EXISTS published_sketches_alive_idx
  ON published_sketches (id) WHERE deleted_at IS NULL;

-- The purge job's scan.
CREATE INDEX IF NOT EXISTS published_sketches_deleted_idx
  ON published_sketches (deleted_at) WHERE deleted_at IS NOT NULL;
