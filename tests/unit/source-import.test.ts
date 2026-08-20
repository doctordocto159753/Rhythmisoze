import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { importMidi } from '@midi';
import { createExportArchive } from '@/packages/export/archive';
import { INITIAL_CONTEXT, run } from '@/features/state/machine';

describe('MIDI source import', () => {
  it('imports tempo, meter, melody and channel-ten drums', () => {
    const midi = new Midi();
    midi.header.setTempo(126);
    midi.header.timeSignatures.push({ ticks: 0, timeSignature: [3, 4] });
    const melody = midi.addTrack();
    melody.channel = 0;
    melody.addNote({ midi: 61, time: 0.25, duration: 0.5, velocity: 0.75 });
    const drums = midi.addTrack();
    drums.channel = 9;
    drums.addNote({ midi: 36, time: 0.5, duration: 0.1, velocity: 0.8 });
    drums.addNote({ midi: 42, time: 1, duration: 0.1, velocity: 0.6 });

    const imported = importMidi(midi.toArray());

    expect(imported.bpm).toBe(126);
    expect(imported.meter).toEqual({ beatsPerBar: 3, beatUnit: 4 });
    expect(imported.notes).toHaveLength(1);
    expect(imported.notes[0]?.pitch).toBe(61);
    expect(imported.notes[0]?.startSec).toBeCloseTo(0.25, 4);
    expect(imported.notes[0]?.endSec).toBeCloseTo(0.75, 4);
    expect(imported.drums.map((event) => event.drum)).toEqual(['kick', 'hat']);
    expect(imported.durationSec).toBeGreaterThanOrEqual(1.1);
  });

  it('rejects malformed and empty MIDI data with typed errors', () => {
    expect(() => importMidi(new Uint8Array([1, 2, 3]))).toThrow(/midi_invalid/);
    expect(() => importMidi(new Midi().toArray())).toThrow(/midi_empty/);
  });

  it('lets MIDI enter review without pretending it was a restored sketch', () => {
    expect(run(['MIDI_IMPORTED'], INITIAL_CONTEXT).state).toBe('review');
    expect(run(['TEMPO_SET', 'MIDI_IMPORTED'], INITIAL_CONTEXT).state).toBe('review');
    expect(run(['TEMPO_SET', 'AUDIO_IMPORTED', 'PROCESS'], INITIAL_CONTEXT).state).toBe(
      'processing',
    );
  });
});

describe('complete export archive', () => {
  it('stores rendered audio, notes, manifest and the untouched source', async () => {
    const source = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const archive = await createExportArchive([
      { name: 'rendered.wav', data: new Uint8Array([1, 2, 3]) },
      { name: 'notes.mid', data: new Uint8Array([4, 5]) },
      { name: 'source/../original.wav', data: source },
      { name: 'manifest.json', data: '{"schemaVersion":1}' },
    ]);
    const entries = readStoredZip(new Uint8Array(await archive.arrayBuffer()));

    expect(archive.type).toBe('application/zip');
    expect([...entries.keys()]).toEqual([
      'rendered.wav',
      'notes.mid',
      'source/original.wav',
      'manifest.json',
    ]);
    expect(entries.get('source/original.wav')).toEqual(source);
    expect(new TextDecoder().decode(entries.get('manifest.json'))).toBe('{"schemaVersion":1}');
  });
});

function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressed = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + compressed));
    offset = dataStart + compressed;
  }
  return entries;
}
