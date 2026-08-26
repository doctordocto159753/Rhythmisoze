-- Whether a published sketch's `bpm` is a measurement or an encoding constant.
--
-- Before this, a tempo was always something the user had stated before
-- recording, so every published row's `bpm` was a fact about a setting. The app
-- no longer asks for one: it measures the pulse of the performance, and when a
-- performance has no measurable pulse there simply is no tempo to report.
--
-- A MIDI file still has to declare a tempo and a bar ruler still has to space
-- its lines, so `bpm` keeps holding a number in that case — the constant from
-- `FREE_TIMING_ENCODING_BPM`. This column is what stops the share page
-- presenting that constant as something the app heard.
--
-- Existing rows default to false, which is the truthful reading of what they
-- were published with.

ALTER TABLE published_sketches
  ADD COLUMN IF NOT EXISTS free_timing BOOLEAN NOT NULL DEFAULT FALSE;
