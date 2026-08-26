/**
 * Compares an external transcription engine with the in-repo pipeline on the
 * synthetic corpus, where the ground truth is exact.
 *
 * Opt-in: point `EXTERNAL_ENGINE_DIR` at a directory of `<caseId>.csv` files
 * and `EXTERNAL_ENGINE_NAME` at a label. Without them the test skips, because
 * the external engine is not a dependency of this repository and must not
 * become one by way of a test that fails when it is absent.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractHumanMelody } from '@/packages/melody-extraction';
import { judgeAndRepair, judgeFeaturesFromFrames } from '@musical-judge';
import { detectOnsets } from '@/packages/audio-core/onsets';
import { synthesisedCases } from '../../evaluation/corpus';
import {
  asExternalNotes,
  parseNoteCsv,
  scoreExternalNotes,
  type ExternalEngineReport,
} from '../../evaluation/engines/external';

const dir = process.env.EXTERNAL_ENGINE_DIR;
const engine = process.env.EXTERNAL_ENGINE_NAME ?? 'external';

describe.skipIf(!dir || !existsSync(dir))('external engine comparison', () => {
  it('scores the external notes and the current pipeline on identical truth', () => {
    const available = new Set(
      readdirSync(dir as string)
        .filter((name) => name.toLowerCase().endsWith('.csv'))
        .map((name) => name.slice(0, -4)),
    );

    const rows: Array<{ external: ExternalEngineReport; current: ExternalEngineReport }> = [];
    for (const corpusCase of synthesisedCases()) {
      if (corpusCase.referenceNotes.length === 0) continue;
      if (!available.has(corpusCase.id)) continue;

      const externalNotes = parseNoteCsv(
        readFileSync(join(dir as string, `${corpusCase.id}.csv`), 'utf8'),
      );

      // The current pipeline, run exactly as the worker runs it, so the two
      // columns describe the same decision rather than two different ones.
      const extraction = extractHumanMelody(corpusCase.audio);
      const onsets = detectOnsets(corpusCase.audio.samples, corpusCase.audio.sampleRate)
        .onsets.map((onset) => onset.timeSec);
      const features = judgeFeaturesFromFrames(
        extraction.frames,
        corpusCase.audio.durationSec,
        onsets,
      );
      const verdict = judgeAndRepair(extraction.notes, features, {
        repair: { respectCandidateRegister: true },
      });

      rows.push({
        external: scoreExternalNotes(
          corpusCase.id,
          engine,
          externalNotes,
          corpusCase.referenceFrames,
          corpusCase.referenceNotes,
        ),
        current: scoreExternalNotes(
          corpusCase.id,
          'current',
          asExternalNotes(verdict.judgedNotes),
          corpusCase.referenceFrames,
          corpusCase.referenceNotes,
        ),
      });
    }

    expect(rows.length).toBeGreaterThan(0);

    const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
    const lines = [
      `| case | engine | RPA | RCA | octave err | note F1 | notes | onset ms |`,
      `|---|---|---|---|---|---|---|---|`,
    ];
    for (const row of rows) {
      for (const report of [row.current, row.external]) {
        lines.push(
          `| ${report.caseId} | ${report.engine} | ${pct(report.pitch.rawPitchAccuracy)} | ` +
            `${pct(report.pitch.rawChromaAccuracy)} | ${pct(report.pitch.octaveErrorRate)} | ` +
            `${report.notes.f1.toFixed(2)} | ${report.notes.estimatedNotes} | ` +
            `${report.notes.medianOnsetErrorMs.toFixed(0)} |`,
        );
      }
    }
    const out = process.env.EXTERNAL_ENGINE_REPORT;
    if (out) writeFileSync(out, lines.join(String.fromCharCode(10)), 'utf8');
    // eslint-disable-next-line no-console -- the report is the output of this test.
    console.log(`\n${lines.join('\n')}\n`);
  });
});
