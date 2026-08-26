/**
 * The register witness, as the evaluation harness sees it.
 *
 * The production voice path asks Basic Pitch for a second opinion about which
 * octave each note is in. The gate has to grade that path rather than the one
 * that existed before it, and running a TensorFlow model over the whole corpus
 * costs forty seconds — too slow for a suite that runs on every change.
 *
 * The corpus is synthesised deterministically and the model weights are pinned,
 * so the witness's reading of each case is a constant. It is recorded once,
 * committed, and checked against the live model by
 * `tests/evaluation/register-witness.test.ts`. That keeps the gate fast without
 * letting it grade a fiction: if the model or the corpus moves, the check fails
 * and the fixture has to be regenerated deliberately.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceNote, EvidenceSource } from '@evidence';

/** Case id → the witness's notes, in absolute source seconds. */
export type WitnessFixture = Record<string, EvidenceNote[]>;

/**
 * The two configurations the product actually ships in.
 *
 * `default` is a deployment with no transcription service: the browser's own
 * Basic Pitch is the only register witness, and since a correction needs
 * corroboration, nothing moves — disagreements are reported instead.
 *
 * `full` adds the optional GAME service. Both are graded, because both are real
 * and a report on only one of them would describe a product half the users do
 * not have.
 */
export type WitnessTier = 'default' | 'full';

export const WITNESS_FIXTURE_PATH = join(
  process.cwd(),
  'evaluation',
  'expected',
  'register-witness.json',
);

/**
 * GAME's reading of the same material.
 *
 * Produced out of repo, by the upstream project's own inference script against
 * its published small model, and committed as data for the same reason the
 * Basic Pitch fixture is: so the gate can grade the configuration without the
 * repository depending on a PyTorch runtime to run its tests.
 */
export const GAME_FIXTURE_PATH = join(
  process.cwd(),
  'evaluation',
  'expected',
  'register-witness-game.json',
);

const cache = new Map<string, WitnessFixture>();

function fixture(path: string): WitnessFixture {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const loaded = JSON.parse(readFileSync(path, 'utf8')) as WitnessFixture;
  cache.set(path, loaded);
  return loaded;
}

/**
 * The witness sources for one corpus case, at one deployment tier.
 *
 * An empty array when no fixture has an entry, which is the same thing the
 * worker does when a model is unavailable: the arbitration becomes a no-op and
 * the candidate keeps its own register.
 */
export function witnessesFor(caseId: string, tier: WitnessTier = 'default'): EvidenceSource[] {
  const sources: EvidenceSource[] = [];
  const local = fixture(WITNESS_FIXTURE_PATH)[caseId];
  if (local !== undefined && local.length > 0) {
    sources.push({ engineId: 'basic-pitch', view: 'original', notes: local });
  }
  if (tier === 'full') {
    const game = fixture(GAME_FIXTURE_PATH)[caseId];
    if (game !== undefined && game.length > 0) {
      sources.push({ engineId: 'game', view: 'original', notes: game });
    }
  }
  return sources;
}
