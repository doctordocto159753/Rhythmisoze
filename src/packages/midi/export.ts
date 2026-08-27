/** Standard MIDI export with source timing/channel/track semantics retained. */

import { Midi } from '@tonejs/midi';
import { writeMidi, type MidiEvent } from 'midi-file';
import {
  GM_DRUM_MAP,
  GM_DRUM_CHANNEL,
  UNKNOWN_DRUM_FALLBACK,
  type DrumEvent,
  type Meter,
  type NoteEvent,
  type RawMidiMetadata,
} from '@contracts';

export interface MidiExportOptions {
  bpm: number;
  meter: Meter;
  title: string;
  program: number;
  instrumentName?: string;
  /** Source clock and event map for MIDI-derived versions. */
  rawMidiMetadata?: Readonly<RawMidiMetadata>;
}

interface AbsoluteEvent {
  ticks: number;
  priority: number;
  event: { type: string; [key: string]: unknown };
}

export function melodyToMidi(notes: readonly NoteEvent[], options: MidiExportOptions): Uint8Array {
  const metadata = options.rawMidiMetadata;
  const trackCount = outputTrackCount(
    metadata,
    notes.map((note) => note.sourceTrack),
  );
  const tracks: AbsoluteEvent[][] = Array.from({ length: trackCount }, () => []);
  addHeaderEvents(tracks, options);

  const programmed = new Set<string>();
  for (const note of [...notes].sort(sourceOrder)) {
    const trackIndex = resolveTrack(note.sourceTrack, trackCount);
    const channel = clampChannel(note.sourceChannel ?? 0);
    const programKey = `${trackIndex}:${channel}`;
    if (!programmed.has(programKey)) {
      programmed.add(programKey);
      tracks[trackIndex]?.push({
        ticks: 0,
        priority: 2,
        event: { type: 'programChange', channel, programNumber: clampProgram(options.program) },
      });
    }
    const start = eventTicks(note.startSec, note.sourceStartTicks, metadata);
    const end = Math.max(start + 1, eventTicks(note.endSec, note.sourceEndTicks, metadata));
    tracks[trackIndex]?.push(
      {
        ticks: start,
        priority: 4,
        event: {
          type: 'noteOn', channel, noteNumber: clampPitch(note.pitch),
          velocity: clampVelocity(note.velocity),
        },
      },
      {
        ticks: end,
        priority: 3,
        event: { type: 'noteOff', channel, noteNumber: clampPitch(note.pitch), velocity: 0 },
      },
    );
  }
  return encodeTracks(tracks, options, metadata);
}

export function rhythmToMidi(drums: readonly DrumEvent[], options: MidiExportOptions): Uint8Array {
  const metadata = options.rawMidiMetadata;
  const trackCount = outputTrackCount(
    metadata,
    drums.map((event) => event.sourceTrack),
  );
  const tracks: AbsoluteEvent[][] = Array.from({ length: trackCount }, () => []);
  addHeaderEvents(tracks, options);
  for (const hit of [...drums].sort(sourceOrder)) {
    const trackIndex = resolveTrack(hit.sourceTrack, trackCount);
    const channel = clampChannel(hit.sourceChannel ?? GM_DRUM_CHANNEL);
    const pitch = hit.sourcePitch === undefined ? drumToGmNote(hit.drum) : clampPitch(hit.sourcePitch);
    const start = eventTicks(hit.timeSec, hit.sourceStartTicks, metadata);
    const endSec = hit.sourceEndSec ?? hit.timeSec + 0.125;
    const end = Math.max(start + 1, eventTicks(endSec, hit.sourceEndTicks, metadata));
    tracks[trackIndex]?.push(
      {
        ticks: start,
        priority: 4,
        event: { type: 'noteOn', channel, noteNumber: pitch, velocity: clampVelocity(hit.velocity) },
      },
      {
        ticks: end,
        priority: 3,
        event: { type: 'noteOff', channel, noteNumber: pitch, velocity: 0 },
      },
    );
  }
  return encodeTracks(tracks, options, metadata);
}

function addHeaderEvents(tracks: AbsoluteEvent[][], options: MidiExportOptions): void {
  const metadata = options.rawMidiMetadata;
  const tempos = metadata?.tempos.length
    ? metadata.tempos
    : [{ ticks: 0, bpm: options.bpm, timeSec: 0, sourceTrack: 0 }];
  for (const tempo of tempos) {
    const track = resolveTrack(tempo.sourceTrack, tracks.length);
    tracks[track]?.push({
      ticks: tempo.ticks,
      priority: 0,
      event: { type: 'setTempo', meta: true, microsecondsPerBeat: Math.round(60_000_000 / tempo.bpm) },
    });
  }
  const signatures = metadata?.timeSignatures.length
    ? metadata.timeSignatures
    : [{ ticks: 0, timeSignature: [options.meter.beatsPerBar, options.meter.beatUnit] as const, sourceTrack: 0 }];
  for (const signature of signatures) {
    const track = resolveTrack(signature.sourceTrack, tracks.length);
    tracks[track]?.push({
      ticks: signature.ticks,
      priority: 1,
      event: {
        type: 'timeSignature', meta: true,
        numerator: signature.timeSignature[0], denominator: signature.timeSignature[1],
        metronome: 24, thirtyseconds: 8,
      },
    });
  }
}

function encodeTracks(
  tracks: AbsoluteEvent[][],
  options: MidiExportOptions,
  metadata: Readonly<RawMidiMetadata> | undefined,
): Uint8Array {
  const encoded = tracks.map((events, trackIndex) => {
    if (trackIndex === 0) {
      events.push({ ticks: 0, priority: -1, event: { type: 'trackName', meta: true, text: options.title } });
    }
    events.sort((a, b) => a.ticks - b.ticks || a.priority - b.priority);
    let previous = 0;
    const relative = events.map(({ ticks, event }) => {
      const deltaTime = Math.max(0, ticks - previous);
      previous = ticks;
      return { ...event, deltaTime } as MidiEvent;
    });
    relative.push({ type: 'endOfTrack', meta: true, deltaTime: 0 });
    return relative;
  });
  return Uint8Array.from(writeMidi({
    header: {
      format: (metadata?.format ?? (tracks.length > 1 ? 1 : 0)) as 0 | 1 | 2,
      numTracks: encoded.length,
      ticksPerBeat: metadata?.ppq ?? 480,
    },
    tracks: encoded,
  }));
}

function eventTicks(
  seconds: number,
  sourceTicks: number | undefined,
  metadata: Readonly<RawMidiMetadata> | undefined,
): number {
  if (metadata && sourceTicks !== undefined) {
    const originalSec = ticksToSeconds(sourceTicks, metadata);
    if (Math.abs(originalSec - seconds) <= 1e-6) return sourceTicks;
  }
  return secondsToTicks(Math.max(0, seconds), metadata);
}

function secondsToTicks(seconds: number, metadata: Readonly<RawMidiMetadata> | undefined): number {
  const ppq = metadata?.ppq ?? 480;
  const tempos = metadata?.tempos.length
    ? [...metadata.tempos].sort((a, b) => a.timeSec - b.timeSec)
    : [{ timeSec: 0, ticks: 0, bpm: 120 }];
  let active = tempos[0] as { timeSec: number; ticks: number; bpm: number };
  for (const tempo of tempos) {
    if (tempo.timeSec > seconds) break;
    active = tempo;
  }
  return Math.max(0, Math.round(active.ticks + (seconds - active.timeSec) * ppq * active.bpm / 60));
}

function ticksToSeconds(ticks: number, metadata: Readonly<RawMidiMetadata>): number {
  const tempos = metadata.tempos.length
    ? [...metadata.tempos].sort((a, b) => a.ticks - b.ticks)
    : [{ ticks: 0, bpm: 120, timeSec: 0 }];
  let active = tempos[0] as { timeSec: number; ticks: number; bpm: number };
  for (const tempo of tempos) {
    if (tempo.ticks > ticks) break;
    active = tempo;
  }
  return active.timeSec + ((ticks - active.ticks) * 60) / (metadata.ppq * active.bpm);
}

function outputTrackCount(
  metadata: Readonly<RawMidiMetadata> | undefined,
  sourceTracks: readonly (number | undefined)[],
): number {
  return Math.max(1, metadata?.trackCount ?? 0, ...sourceTracks.map((track) => (track ?? 0) + 1));
}

function resolveTrack(track: number | undefined, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(track ?? 0)));
}

function sourceOrder(a: { sourceOrder?: number; startSec?: number; timeSec?: number }, b: { sourceOrder?: number; startSec?: number; timeSec?: number }): number {
  return (a.sourceOrder ?? Number.MAX_SAFE_INTEGER) - (b.sourceOrder ?? Number.MAX_SAFE_INTEGER) ||
    (a.startSec ?? a.timeSec ?? 0) - (b.startSec ?? b.timeSec ?? 0);
}

export function drumToGmNote(drum: DrumEvent['drum']): number {
  const resolved = drum === 'unknown' ? UNKNOWN_DRUM_FALLBACK : drum;
  return GM_DRUM_MAP[resolved as Exclude<DrumEvent['drum'], 'unknown'>];
}

function clampProgram(program: number): number {
  return Math.max(0, Math.min(127, Math.round(program)));
}
function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}
function clampChannel(channel: number): number {
  return Math.max(0, Math.min(15, Math.round(channel)));
}
function clampVelocity(velocity: number): number {
  return Math.max(1, Math.min(127, Math.round(velocity)));
}

/** Reads a file back. Used by export tests to prove what was written. */
export function parseMidi(data: Uint8Array): Midi {
  return new Midi(data);
}
