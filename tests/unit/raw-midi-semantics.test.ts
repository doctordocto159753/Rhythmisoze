import { describe, expect, it } from 'vitest';
import { parseMidi as parseSmf, writeMidi, type MidiEvent } from 'midi-file';
import { importMidi, melodyToMidi } from '@midi';
import {
  exactRawMidiArtifact,
  freezeRawTranscription,
  rawNotesForProcessing,
} from '@raw-transcription';

function sourceMidi(): Uint8Array {
  const tracks: MidiEvent[][] = [
    [
      { deltaTime: 0, type: 'setTempo', meta: true, microsecondsPerBeat: 500_000 },
      { deltaTime: 0, type: 'timeSignature', meta: true, numerator: 7, denominator: 8, metronome: 24, thirtyseconds: 8 },
      { deltaTime: 480, type: 'setTempo', meta: true, microsecondsPerBeat: 666_667 },
      { deltaTime: 0, type: 'endOfTrack', meta: true },
    ],
    [
      { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 73 },
      { deltaTime: 240, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 4 },
      { deltaTime: 0, type: 'noteOn', channel: 2, noteNumber: 64, velocity: 101 },
      { deltaTime: 240, type: 'noteOff', channel: 2, noteNumber: 64, velocity: 5 },
      { deltaTime: 0, type: 'endOfTrack', meta: true },
    ],
    [
      { deltaTime: 120, type: 'noteOn', channel: 9, noteNumber: 38, velocity: 88 },
      { deltaTime: 60, type: 'noteOff', channel: 9, noteNumber: 38, velocity: 0 },
      { deltaTime: 0, type: 'endOfTrack', meta: true },
    ],
  ];
  return Uint8Array.from(writeMidi({
    header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480 },
    tracks,
  }));
}

describe('canonical Raw MIDI semantics', () => {
  it('retains original tracks, channels, ticks, velocity and the complete tempo map', () => {
    const imported = importMidi(sourceMidi());
    const raw = imported.rawTranscription;
    expect(raw.midi).toMatchObject({ format: 1, ppq: 480, trackCount: 3 });
    expect(raw.midi?.tempos.map(({ ticks, bpm, sourceTrack }) => ({ ticks, bpm: Math.round(bpm), sourceTrack })))
      .toEqual([
        { ticks: 0, bpm: 120, sourceTrack: 0 },
        { ticks: 480, bpm: 90, sourceTrack: 0 },
      ]);
    expect(raw.midi?.timeSignatures[0]?.timeSignature).toEqual([7, 8]);
    expect(raw.notes.map((note) => ({
      pitch: note.pitchMidi,
      velocity: note.velocity,
      track: note.sourceTrack,
      channel: note.sourceChannel,
      start: note.sourceStartTicks,
      end: note.sourceEndTicks,
    }))).toEqual([
      { pitch: 60, velocity: 73, track: 1, channel: 0, start: 0, end: 240 },
      { pitch: 64, velocity: 101, track: 1, channel: 2, start: 240, end: 480 },
      { pitch: 38, velocity: 88, track: 2, channel: 9, start: 120, end: 180 },
    ]);
  });

  it('writes derived melody from canonical metadata without flattening channels or tempo events', () => {
    const imported = importMidi(sourceMidi());
    const bytes = melodyToMidi(imported.notes, {
      bpm: imported.bpm,
      meter: imported.meter,
      title: 'semantic roundtrip',
      program: 0,
      rawMidiMetadata: imported.rawTranscription.midi,
    });
    const parsed = parseSmf(bytes);
    const tempos = parsed.tracks.flat().filter((event) => event.type === 'setTempo');
    const channels = parsed.tracks.flat()
      .filter((event) => event.type === 'noteOn' && event.velocity > 0)
      .map((event) => event.type === 'noteOn' ? event.channel : -1);
    expect(parsed.header).toMatchObject({ format: 1, numTracks: 3, ticksPerBeat: 480 });
    expect(tempos).toHaveLength(2);
    expect(channels).toEqual([0, 2]);
  });

  it('returns the immutable source artifact for Raw export and freezes canonical evidence', async () => {
    const bytes = sourceMidi();
    const imported = importMidi(bytes);
    const source = {
      kind: 'midi-upload' as const,
      filename: 'source.mid',
      mimeType: 'audio/midi',
      blob: new Blob([bytes.buffer as ArrayBuffer]),
    };
    const raw = freezeRawTranscription(imported.rawTranscription);
    const artifact = exactRawMidiArtifact(source, raw);
    expect(new Uint8Array(await artifact!.arrayBuffer())).toEqual(bytes);
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen(raw.notes)).toBe(true);
    expect(Object.isFrozen(raw.midi?.tempos)).toBe(true);
  });

  it('keeps Judge and Musician working copies unable to mutate canonical Raw', () => {
    const raw = freezeRawTranscription(importMidi(sourceMidi()).rawTranscription);
    const before = JSON.stringify(raw);
    const judgeCopy = rawNotesForProcessing(raw);
    judgeCopy[0]!.pitch = 12;
    judgeCopy[0]!.startSec = 9;
    const musicianCopy = judgeCopy.map((note) => ({ ...note }));
    musicianCopy[0]!.velocity = 1;
    expect(JSON.stringify(raw)).toBe(before);
    expect(raw.notes[0]).toMatchObject({ pitchMidi: 60, startSec: 0, velocity: 73 });
  });
});
