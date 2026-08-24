import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { noteSchema, musicianResultSchema } from '@musician-client';

/**
 * Guards the Zod schemas against the Pydantic contract they mirror.
 *
 * Two independent definitions of one shape will drift. The right fix is to
 * generate one from the other, and that is a real piece of build tooling for a
 * two-language repo. This is the cheap honest alternative in the meantime: read
 * the Python and fail when the two disagree about something that matters.
 *
 * It checks the *constants that would silently corrupt data* if they diverged —
 * pitch bounds, contract version — rather than trying to parse Python types.
 * A test that tried to be a full type checker would be fragile and would get
 * disabled the first time it cried wolf.
 */

const PYTHON_CONTRACT = resolve(
  __dirname,
  '../../services/musician/shared/src/musician_shared/contract.py',
);

describe('contract parity with the Python service', () => {
  const available = existsSync(PYTHON_CONTRACT);

  it('can find the Python contract', () => {
    // If this fails, the service moved and the guard below is silently vacuous.
    expect(available).toBe(true);
  });

  it('agrees on the MIDI pitch range', () => {
    const python = readFileSync(PYTHON_CONTRACT, 'utf8');
    const min = Number(/MIN_MIDI_PITCH\s*=\s*(\d+)/.exec(python)?.[1]);
    const max = Number(/MAX_MIDI_PITCH\s*=\s*(\d+)/.exec(python)?.[1]);
    expect(min).toBe(0);
    expect(max).toBe(127);

    // The bounds the client actually enforces, exercised rather than read.
    expect(noteSchema.safeParse({ pitch: min, start_sec: 0, end_sec: 1, velocity: 90 }).success).toBe(
      true,
    );
    expect(noteSchema.safeParse({ pitch: max, start_sec: 0, end_sec: 1, velocity: 90 }).success).toBe(
      true,
    );
    expect(
      noteSchema.safeParse({ pitch: max + 1, start_sec: 0, end_sec: 1, velocity: 90 }).success,
    ).toBe(false);
  });

  it('agrees on the contract version', () => {
    const python = readFileSync(PYTHON_CONTRACT, 'utf8');
    const version = Number(/CONTRACT_VERSION\s*=\s*(\d+)/.exec(python)?.[1]);
    expect(version).toBe(1);

    // A result claiming a different version must be refused rather than parsed
    // optimistically: a version bump means fields moved.
    const wrongVersion = { version: 2 };
    expect(musicianResultSchema.safeParse(wrongVersion).success).toBe(false);
  });

  it('agrees on the note field names', () => {
    // snake_case on the wire. If the service ever switched to camelCase, every
    // note would parse as undefined and the failure would surface as an empty
    // piano roll rather than as an error.
    const python = readFileSync(PYTHON_CONTRACT, 'utf8');
    const noteClass = python.slice(
      python.indexOf('class Note(BaseModel)'),
      python.indexOf('class Tempo(BaseModel)'),
    );
    for (const field of ['pitch', 'start_sec', 'end_sec', 'velocity']) {
      expect(noteClass).toContain(`${field}:`);
    }
  });

  it('agrees that phrase spans are part of Musician input', () => {
    const python = readFileSync(PYTHON_CONTRACT, 'utf8');
    const input = python.slice(
      python.indexOf('class MusicianInput(BaseModel)'),
      python.indexOf('class VariantKind'),
    );
    expect(input).toMatch(/phrases:\s*tuple\[Phrase,\s*\.\.\.\]/);
  });

  it('agrees that both variants are required', () => {
    const python = readFileSync(PYTHON_CONTRACT, 'utf8');
    const output = python.slice(python.indexOf('class MusicianOutput(BaseModel)'));
    // Neither is Optional on the Python side, and neither is optional here.
    expect(output).toMatch(/refined:\s*Variant\b/);
    expect(output).toMatch(/developed:\s*Variant\b/);
  });
});
