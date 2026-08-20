'use client';

import { useMemo } from 'react';
import type { DrumEvent, NoteEvent } from '@contracts';
import { pitchName } from '@retouch';
import { Text, VisuallyHidden } from '@/components/Text';
import { formatDuration } from '@/i18n';
import { useMessages } from '@/i18n/provider';
import styles from './PianoRoll.module.css';

export interface PianoRollProps {
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  /** The untouched transcription, drawn behind for comparison. */
  rawNotes?: readonly NoteEvent[];
  durationSec: number;
  bpm: number;
  beatsPerBar: number;
  /** 0..1 through the clip, or null when nothing is playing. */
  playhead: number | null;
  showRaw?: boolean;
}

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const PADDING = 10;
/** Enough vertical room that a two-octave phrase does not become hairlines. */
const MIN_PITCH_SPAN = 14;

/**
 * US-0701 / D-0403 - the note view.
 *
 * SVG rather than canvas: the whole picture is a few hundred rectangles, and
 * SVG scales to any width without a redraw, stays crisp on a high-DPI phone,
 * and can carry `<title>` elements. Canvas would buy nothing here and would
 * make the accessible fallback harder rather than easier.
 *
 * Two things it deliberately shows:
 *  - the *raw* transcription behind the cleaned one, at low opacity, so moving
 *    the cleanup slider visibly moves notes rather than just changing a number
 *    (D-0402: the continuum must be perceptible);
 *  - a playhead driven from the audio clock by the caller.
 */
export function PianoRoll({
  notes,
  drums,
  rawNotes,
  durationSec,
  bpm,
  beatsPerBar,
  playhead,
  showRaw = true,
}: PianoRollProps) {
  const t = useMessages();
  const isRhythm = drums.length > 0 && notes.length === 0;

  const geometry = useMemo(() => {
    const span = Math.max(durationSec, 1);
    const pitches = notes.map((note) => note.pitch);
    const low = pitches.length > 0 ? Math.min(...pitches) : 60;
    const high = pitches.length > 0 ? Math.max(...pitches) : 72;
    // Pad the range so the top and bottom notes are not flush against the frame.
    const centre = (low + high) / 2;
    const half = Math.max(MIN_PITCH_SPAN / 2, (high - low) / 2 + 2);
    return {
      span,
      lowPitch: Math.floor(centre - half),
      highPitch: Math.ceil(centre + half),
    };
  }, [notes, durationSec]);

  const xOf = (seconds: number): number =>
    PADDING + (seconds / geometry.span) * (VIEW_WIDTH - PADDING * 2);

  const yOf = (pitch: number): number => {
    const range = geometry.highPitch - geometry.lowPitch || 1;
    const fromTop = (geometry.highPitch - pitch) / range;
    return PADDING + fromTop * (VIEW_HEIGHT - PADDING * 2);
  };

  const noteHeight = Math.max(
    4,
    (VIEW_HEIGHT - PADDING * 2) / (geometry.highPitch - geometry.lowPitch || 1) - 1.5,
  );

  const secondsPerBeat = 60 / bpm;
  const beatCount = Math.ceil(geometry.span / secondsPerBeat);

  const drumRows: Array<DrumEvent['drum']> = ['hat', 'snare', 'kick'];

  if (notes.length === 0 && drums.length === 0) {
    return (
      <div className={styles.frame}>
        <div className={styles.empty}>
          <Text variant="heading" as="p">
            {t.review.empty}
          </Text>
          <Text variant="micro" muted>
            {t.review.emptyHelp}
          </Text>
        </div>
      </div>
    );
  }

  const summary = isRhythm
    ? t.pianoRoll.drumSummary(drums.length, formatDuration(durationSec, { precise: true }))
    : t.pianoRoll.summary(
        notes.length,
        pitchName(geometry.lowPitch),
        pitchName(geometry.highPitch),
        formatDuration(durationSec, { precise: true }),
      );

  return (
    <div className={styles.frame}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        {/* Octave bands, drawn first so everything sits on top of them. */}
        {!isRhythm
          ? Array.from({ length: geometry.highPitch - geometry.lowPitch + 1 }, (_, index) => {
              const pitch = geometry.lowPitch + index;
              if (Math.floor(pitch / 12) % 2 !== 0) return null;
              return (
                <rect
                  key={`band-${pitch}`}
                  className={styles.octaveBand}
                  x={0}
                  y={yOf(pitch)}
                  width={VIEW_WIDTH}
                  height={noteHeight + 1.5}
                />
              );
            })
          : null}

        {/* Beat and bar lines. */}
        {Array.from({ length: beatCount + 1 }, (_, beat) => {
          const x = xOf(beat * secondsPerBeat);
          const isBar = beat % beatsPerBar === 0;
          return (
            <line
              key={`beat-${beat}`}
              className={isBar ? styles.barLine : styles.beatLine}
              x1={x}
              y1={PADDING / 2}
              x2={x}
              y2={VIEW_HEIGHT - PADDING / 2}
            />
          );
        })}

        {/* The raw transcription, behind. */}
        {showRaw && !isRhythm && rawNotes
          ? rawNotes.map((note, index) => (
              <rect
                key={`raw-${index}`}
                className={styles.noteRaw}
                x={xOf(note.startSec)}
                y={yOf(note.pitch)}
                width={Math.max(2, xOf(note.endSec) - xOf(note.startSec))}
                height={noteHeight}
              />
            ))
          : null}

        {/* The current result. */}
        {notes.map((note, index) => (
          <rect
            key={`note-${index}`}
            className={styles.note}
            x={xOf(note.startSec)}
            y={yOf(note.pitch)}
            width={Math.max(2, xOf(note.endSec) - xOf(note.startSec))}
            height={noteHeight}
            opacity={0.45 + (note.velocity / 127) * 0.55}
          >
            <title>
              {t.pianoRoll.noteAt(pitchName(note.pitch), formatDuration(note.startSec, { precise: true }))}
            </title>
          </rect>
        ))}

        {/* Rhythm: three fixed rows rather than a pitch axis, because a drum
            pattern has no register to read. */}
        {isRhythm
          ? drums.map((hit, index) => {
              const row = drumRows.indexOf(hit.drum === 'unknown' ? 'hat' : hit.drum);
              const rowHeight = (VIEW_HEIGHT - PADDING * 2) / drumRows.length;
              return (
                <rect
                  key={`drum-${index}`}
                  className={styles.drum}
                  x={xOf(hit.timeSec)}
                  y={PADDING + row * rowHeight + rowHeight * 0.25}
                  width={6}
                  height={rowHeight * 0.5}
                  opacity={hit.drum === 'unknown' ? 0.4 : 0.5 + (hit.velocity / 127) * 0.5}
                />
              );
            })
          : null}

        {playhead !== null ? (
          <line
            className={styles.playhead}
            x1={xOf(playhead * geometry.span)}
            y1={0}
            x2={xOf(playhead * geometry.span)}
            y2={VIEW_HEIGHT}
          />
        ) : null}
      </svg>

      {/* The semantic equivalent the accessibility skill requires for a
          visual-only pitch view. */}
      <VisuallyHidden>{summary}</VisuallyHidden>
    </div>
  );
}
