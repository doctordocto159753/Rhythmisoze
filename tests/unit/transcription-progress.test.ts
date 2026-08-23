import { describe, expect, it } from 'vitest';
import { mapMonotonicProgress } from '@/workers/transcription-progress';

describe('transcription progress', () => {
  it('never goes backwards when a second mixed sub-engine starts', () => {
    const pitchedDone = mapMonotonicProgress(0.7, 1, { start: 0, span: 0.75 });
    const rhythmStart = mapMonotonicProgress(pitchedDone, 0.08, { start: 0.75, span: 0.25 });
    expect(pitchedDone).toBe(0.75);
    expect(rhythmStart).toBeGreaterThanOrEqual(pitchedDone);
  });

  it('clamps malformed engine percentages to the request range', () => {
    expect(mapMonotonicProgress(0, -2, { start: 0.2, span: 0.5 })).toBe(0.2);
    expect(mapMonotonicProgress(0, 4, { start: 0.2, span: 0.5 })).toBe(0.7);
  });
});
