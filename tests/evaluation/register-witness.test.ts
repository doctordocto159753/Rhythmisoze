/**
 * Keeps the committed register-witness fixture honest.
 *
 * ## Why there is a fixture at all
 *
 * The evaluation gate has to measure the pipeline the product actually runs,
 * and that pipeline now asks Basic Pitch for a second opinion about register.
 * Running a TensorFlow model over the whole corpus takes forty seconds, which
 * is not a thing to put in `npm test`.
 *
 * So the witness's reading of each corpus case is recorded once and committed.
 * The corpus audio is synthesised deterministically and the model weights are
 * pinned, so the reading is a constant — and a constant that is checked is a
 * fixture, while a constant that is never checked is a guess that ages badly.
 *
 * ## What this test does
 *
 * Opt-in, because it needs the real model: set `WITNESS_LIVE=1`. It re-runs the
 * live model over the corpus and asserts the committed fixture still matches.
 * Set `WITNESS_WRITE=1` to regenerate it, which should happen only when the
 * model or the corpus deliberately changes — and in the same commit as that
 * change, with the diff reviewed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { peakNormalize, resample } from '@/packages/audio-core/normalize';
import { PINNED_CASES, readPinnedWav, synthesisedCases } from '../../evaluation/corpus';
import { WITNESS_FIXTURE_PATH, type WitnessFixture } from '../../evaluation/engines/witness';

const MODEL_FRAME_SEC = 256 / 22050;
const live = process.env.WITNESS_LIVE === '1' || process.env.WITNESS_WRITE === '1';

/**
 * Runs the real Basic Pitch model in Node.
 *
 * The library is written for a browser: it loads its weights through `fetch`
 * and touches `window` while starting TensorFlow. Both are shimmed rather than
 * worked around, so what runs here is the same code path the worker runs.
 */
async function liveWitness(): Promise<WitnessFixture> {
  const realFetch = globalThis.fetch.bind(globalThis);
  const modelDir = join(process.cwd(), 'public', 'models', 'basic-pitch');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const marker = 'public/models/basic-pitch/';
    if (url.startsWith('file://') && url.includes(marker)) {
      const name = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
      return new Response(new Uint8Array(readFileSync(join(modelDir, name))), { status: 200 });
    }
    return realFetch(input as Parameters<typeof realFetch>[0], init);
  }) as typeof fetch;

  const scope = globalThis as Record<string, unknown>;
  if (scope.window === undefined) scope.window = globalThis;
  const { BasicPitch, outputToNotesPoly, noteFramesToTime } = await import('@spotify/basic-pitch');
  const instance = new BasicPitch(`file://${modelDir.replace(/\\/g, '/')}/model.json`);

  // The pinned real takes are graded through the same path as the synthesised
  // ones, so the witness has to cover them too. Their audio is committed and
  // license-clean; the witness's reading of it is as deterministic as the
  // corpus's.
  const targets: Array<{ id: string; audio: ReturnType<typeof readPinnedWav> }> = [
    ...synthesisedCases()
      .filter((c) => c.category === 'voice-melody' || c.category === 'difficult')
      .map((c) => ({ id: c.id, audio: c.audio })),
    ...PINNED_CASES.map((pinned) => ({ id: pinned.id, audio: readPinnedWav(pinned.wavPath) })),
  ];

  const out: WitnessFixture = {};
  for (const corpusCase of targets) {
    const prepared = peakNormalize(resample(corpusCase.audio, 22050));
    const frames: number[][] = [];
    const onsets: number[][] = [];
    const contours: number[][] = [];
    await instance.evaluateModel(
      prepared.samples,
      (f, o, c) => {
        frames.push(...f);
        onsets.push(...o);
        contours.push(...c);
      },
      () => {},
    );
    const timed = noteFramesToTime(
      outputToNotesPoly(
        frames,
        onsets,
        0.5,
        0.3,
        Math.max(1, Math.round(0.05 / MODEL_FRAME_SEC)),
        true,
        null,
        null,
        false,
      ),
    );
    out[corpusCase.id] = timed
      .map((note) => ({
        startSec: Number(note.startTimeSeconds.toFixed(3)),
        endSec: Number((note.startTimeSeconds + note.durationSeconds).toFixed(3)),
        pitch: Number(note.pitchMidi.toFixed(2)),
      }))
      .sort((a, b) => a.startSec - b.startSec);
  }
  return out;
}

describe.skipIf(!live)('the committed register witness', () => {
  it('still matches what the live model says', async () => {
    const fresh = await liveWitness();

    if (process.env.WITNESS_WRITE === '1') {
      writeFileSync(WITNESS_FIXTURE_PATH, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
      return;
    }

    expect(existsSync(WITNESS_FIXTURE_PATH)).toBe(true);
    const committed = JSON.parse(readFileSync(WITNESS_FIXTURE_PATH, 'utf8')) as WitnessFixture;
    expect(Object.keys(fresh).sort()).toEqual(Object.keys(committed).sort());
    for (const [id, notes] of Object.entries(fresh)) {
      expect({ id, notes }).toEqual({ id, notes: committed[id] });
    }
  }, 600_000);
});
