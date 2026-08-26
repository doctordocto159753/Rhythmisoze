/**
 * The production quality gate.
 *
 * Runs the whole evaluation corpus and holds two lines:
 *
 * 1. **Regression floors** from `expected/baseline.json`. The baseline is
 *    measured behaviour of the current pipeline, padded with a small tolerance;
 *    an improvement moves the floor up when the baseline is regenerated, a
 *    regression fails here before it can ship. Regenerate deliberately with
 *    `EVAL_WRITE_BASELINE=1` after reviewing a diff — never to make a test pass.
 *
 * 2. **Structural invariants** that no baseline may soften: route decisions on
 *    pinned recordings, and zero judge-stage octave changes (the
 *    single-octave-authority rule, asserted as data rather than prose).
 *
 * Every run also writes `evaluation/reports/latest.json` plus a human-readable
 * `latest.md`, so benchmark numbers are inspectable without re-running.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PINNED_CASES, synthesisedCases } from '../../evaluation/corpus';
import { evaluateAll, type EvaluationReport } from '../../evaluation/runner';

const REPORTS_DIR = join(process.cwd(), 'evaluation', 'reports');
const BASELINE_PATH = join(process.cwd(), 'evaluation', 'expected', 'baseline.json');

/** Slack per metric kind: absolute floors would make normal jitter fail CI. */
const FLOOR_SLACK: Record<string, number> = {
  rawPitchAccuracy: 0.03,
  rawChromaAccuracy: 0.03,
  voicingRecall: 0.05,
  'delivered.rawPitchAccuracy': 0.03,
  'delivered.rawChromaAccuracy': 0.03,
  'notes.f1': 0.08,
  intervalDirectionAgreement: 0.1,
};
const CEILING_SLACK: Record<string, number> = {
  octaveErrorRate: 0.02,
  grossErrorRate: 0.02,
  'delivered.octaveErrorRate': 0.02,
  medianAbsoluteErrorCents: 15,
  'notes.medianOnsetErrorMs': 25,
};

interface CaseBounds {
  [metric: string]: number;
}

interface Baseline {
  note: string;
  cases: Record<string, CaseBounds>;
}

/**
 * Two families of metric, kept apart on purpose.
 *
 * The bare names grade the frame tracker: what YIN measured, never revised. The
 * `delivered.*` names grade what the product hands the user, sampled from the
 * notes it actually produces. They used to be the same number because there was
 * nothing between the tracker and the result; the register arbitration is now
 * between them, and collapsing the two would mean either hiding a real
 * improvement or quietly restating the tracker's accuracy as the product's.
 */
function flatten(report: EvaluationReport['voice'][number]): Record<string, number> {
  return {
    rawPitchAccuracy: report.pitch.rawPitchAccuracy,
    rawChromaAccuracy: report.pitch.rawChromaAccuracy,
    voicingRecall: report.pitch.voicingRecall,
    octaveErrorRate: report.pitch.octaveErrorRate,
    grossErrorRate: report.pitch.grossErrorRate,
    medianAbsoluteErrorCents: report.pitch.medianAbsoluteErrorCents,
    'delivered.rawPitchAccuracy': report.delivered.rawPitchAccuracy,
    'delivered.rawChromaAccuracy': report.delivered.rawChromaAccuracy,
    'delivered.octaveErrorRate': report.delivered.octaveErrorRate,
    'notes.f1': report.notes.f1,
    'notes.precision': report.notes.precision,
    'notes.recall': report.notes.recall,
    'notes.medianOnsetErrorMs': report.notes.medianOnsetErrorMs,
    intervalDirectionAgreement: report.notes.intervalDirectionAgreement,
  };
}

describe('production evaluation gate', () => {
  it(
    'measures the corpus against the committed baseline',
    async () => {
      const report = await evaluateAll(synthesisedCases(), PINNED_CASES);

      mkdirSync(REPORTS_DIR, { recursive: true });
      writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));

      if (process.env.EVAL_WRITE_BASELINE === '1') {
        const baseline: Baseline = {
          note: 'Measured behaviour of the current pipeline with slack applied. Floors are lower bounds for higher-is-better metrics, ceilings upper bounds for error metrics. Regenerate only with EVAL_WRITE_BASELINE=1 after reviewing the underlying change.',
          cases: {},
        };
        for (const voiceCase of report.voice) {
          const values = flatten(voiceCase);
          const bounds: CaseBounds = {};
          for (const [metric, value] of Object.entries(values)) {
            if (metric in FLOOR_SLACK) bounds[metric] = Math.max(0, value - FLOOR_SLACK[metric]!);
            else if (metric in CEILING_SLACK) bounds[metric] = value + CEILING_SLACK[metric]!;
          }
          baseline.cases[voiceCase.id] = bounds;
        }
        for (const rhythmCase of report.rhythm) {
          baseline.cases[rhythmCase.id] = {
            onsetF1: Math.max(0, rhythmCase.onsets.f1 - 0.05),
            medianDeviationMs: rhythmCase.onsets.medianDeviationMs + 20,
          };
        }
        for (const pinnedCase of report.pinned) {
          baseline.cases[pinnedCase.id] = {
            noteCountFloor: pinnedCase.noteCount === 0 ? 0 : Math.max(0, pinnedCase.noteCount - Math.max(2, pinnedCase.noteCount * 0.25)),
            noteCountCeiling: pinnedCase.noteCount + Math.max(4, pinnedCase.noteCount * 0.35),
          };
        }
        writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
        // eslint-disable-next-line no-console
        console.log('baseline rewritten; review the git diff of expected/baseline.json');
      }

      expect(existsSync(BASELINE_PATH)).toBe(true);
      const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;

      const problems: string[] = [];
      for (const voiceCase of report.voice) {
        const bounds = baseline.cases[voiceCase.id];
        expect(bounds, `baseline entry missing for ${voiceCase.id}`).toBeDefined();
        const values = flatten(voiceCase);
        for (const [metric, value] of Object.entries(values)) {
          const bound = bounds![metric];
          if (bound === undefined || Number.isNaN(value)) continue;
          if (metric in FLOOR_SLACK && value < bound - 1e-9) {
            problems.push(`${voiceCase.id}.${metric}: ${value.toFixed(3)} below floor ${bound.toFixed(3)}`);
          }
          if (metric in CEILING_SLACK && value > bound + 1e-9) {
            problems.push(`${voiceCase.id}.${metric}: ${value.toFixed(3)} above ceiling ${bound.toFixed(3)}`);
          }
        }
        /**
         * Structural: which stages are allowed to change a register.
         *
         * This used to be "none of them", and that was right for as long as no
         * stage had any evidence about register beyond the contour engine's own
         * reading. The Judge and the phrase interpretation are still in exactly
         * that position — they see the candidate and the frames underneath it,
         * both of which come from the engine whose register is in question — so
         * for them the rule is unchanged and absolute.
         *
         * `register` is the one stage that exists to answer the question, using
         * an independent model's measurement. Forbidding it to move an octave
         * would forbid it to do anything, so the assertion for it is a
         * different and stricter one, applied below: it may move a note only by
         * a whole octave, only with a witness, and the case-level octave-error
         * ceiling still has to hold afterwards.
         */
        for (const [stage, count] of Object.entries(voiceCase.preservation.octaveChangesByStage)) {
          if (stage === 'register') continue;
          expect(count, `${voiceCase.id}: ${stage} introduced an octave change`).toBe(0);
        }
        const registerMoves = voiceCase.preservation.octaveChangesByStage['register'] ?? 0;
        if (registerMoves > 0) {
          expect(
            voiceCase.register.witnessed,
            `${voiceCase.id}: register moved ${registerMoves} notes with no witness`,
          ).toBe(true);
          expect(
            voiceCase.register.corrected,
            `${voiceCase.id}: register moved ${registerMoves} notes but recorded ${voiceCase.register.corrected} corrections`,
          ).toBe(registerMoves);
        }
        // A stage that changes registers must leave the register more correct
        // than it found it, which is the only justification it has. Measured on
        // the delivered notes: the tracker's own frames are not revised, so its
        // octave error rate cannot move and asserting on it would prove nothing.
        if (registerMoves > 0) {
          expect(
            voiceCase.delivered.octaveErrorRate,
            `${voiceCase.id}: register moved ${registerMoves} notes without improving the delivered register`,
          ).toBeLessThan(voiceCase.pitch.octaveErrorRate);
        }
        // The default configuration has one witness, and a correction needs
        // corroboration, so nothing may move in it. Stated as an assertion
        // rather than left implicit: "a deployment without the optional service
        // transcribes exactly as it did before" is a promise, and an untested
        // promise about a configuration most users are on is not one.
        expect(
          voiceCase.register.corrected,
          `${voiceCase.id}: an uncorroborated witness moved a note`,
        ).toBe(0);
      }
      for (const rhythmCase of report.rhythm) {
        const bounds = baseline.cases[rhythmCase.id];
        expect(bounds, `baseline entry missing for ${rhythmCase.id}`).toBeDefined();
        expect(rhythmCase.onsets.f1).toBeGreaterThanOrEqual((bounds!.onsetF1 ?? 0) - 1e-9);
        expect(rhythmCase.onsets.medianDeviationMs).toBeLessThanOrEqual((bounds!.medianDeviationMs ?? 0) + 1e-9);
      }

      writeFileSync(join(REPORTS_DIR, 'latest.md'), renderMarkdown(report));
      expect(problems, `\n${problems.join('\n')}`).toEqual([]);
    },
    240_000,
  );

  /**
   * The configuration with the optional transcription service deployed.
   *
   * Graded separately rather than folded into the baseline, because it is a
   * different product: the service is optional, and a floor raised by evidence
   * only half the deployments have would fail the other half. What is asserted
   * here is the *relationship* — the extra witness may only make the delivered
   * register better, never worse — which is the claim that justifies running it
   * at all.
   */
  it('is never made worse by adding the second register witness', async () => {
    const base = await evaluateAll(synthesisedCases(), PINNED_CASES, 'default');
    const full = await evaluateAll(synthesisedCases(), PINNED_CASES, 'full');

    const byId = new Map(base.voice.map((voiceCase) => [voiceCase.id, voiceCase]));
    let improved = 0;
    for (const voiceCase of full.voice) {
      const before = byId.get(voiceCase.id);
      expect(before, `no default-tier result for ${voiceCase.id}`).toBeDefined();

      expect(
        voiceCase.delivered.octaveErrorRate,
        `${voiceCase.id}: the second witness worsened the delivered register`,
      ).toBeLessThanOrEqual(before!.delivered.octaveErrorRate + 1e-9);
      expect(
        voiceCase.notes.f1,
        `${voiceCase.id}: the second witness worsened note F1`,
      ).toBeGreaterThanOrEqual(before!.notes.f1 - 1e-9);

      if (voiceCase.register.corrected > 0) improved += 1;
    }

    // The whole justification for the optional service, as an assertion: it has
    // to actually fix the case the default configuration cannot.
    const leap = full.voice.find((voiceCase) => voiceCase.id === 'diff-octave-leap');
    expect(leap, 'diff-octave-leap missing from the full-tier report').toBeDefined();
    expect(leap!.register.corrected, 'the second witness did not fix the octave leap').toBe(1);
    expect(leap!.delivered.octaveErrorRate).toBeLessThan(0.05);
    expect(leap!.notes.f1).toBeGreaterThan(0.9);
    expect(improved).toBeGreaterThan(0);

    writeFileSync(join(REPORTS_DIR, 'latest-full.md'), renderMarkdown(full));
  }, 240_000);

  it('holds pinned real-take behaviour', async () => {
    const report = await evaluateAll(synthesisedCases(), PINNED_CASES);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;

    for (const pinned of report.pinned) {
      expect(pinned.routeMatches, `${pinned.id}: routed ${pinned.route}, expected ${pinned.routeExpected}`).toBe(true);
      const bounds = baseline.cases[pinned.id];
      expect(bounds, `baseline entry missing for ${pinned.id}`).toBeDefined();
      expect(pinned.noteCount).toBeGreaterThanOrEqual(bounds!.noteCountFloor ?? 0);
      expect(pinned.noteCount).toBeLessThanOrEqual(bounds!.noteCountCeiling ?? Number.MAX_SAFE_INTEGER);
      expect(pinned.distinctPitches).toBeGreaterThanOrEqual(pinned.noteCount > 3 ? 2 : 0);
    }
  }, 240_000);
});

function renderMarkdown(report: EvaluationReport): string {
  const lines: string[] = [
    `# Evaluation report — ${report.generatedAt}`,
    '',
    'Two accuracy columns per case. **tracker** is what the frame tracker',
    'measured and is never revised; **delivered** is what the product hands the',
    'user, after the register arbitration. They differ exactly where a second',
    'engine corrected an octave the tracker could not hear.',
    '',
    '| case | category | tracker RPA | tracker octave err | delivered RPA | delivered octave err | note F1 | interval agree | register |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const voiceCase of report.voice) {
    const register = voiceCase.register.witnessed
      ? `${voiceCase.register.corrected} fixed, ${voiceCase.register.unresolved} open`
      : 'no witness';
    lines.push(
      `| ${voiceCase.id} | ${voiceCase.category} | ${(voiceCase.pitch.rawPitchAccuracy * 100).toFixed(1)}% | ${(voiceCase.pitch.octaveErrorRate * 100).toFixed(1)}% | ${(voiceCase.delivered.rawPitchAccuracy * 100).toFixed(1)}% | ${(voiceCase.delivered.octaveErrorRate * 100).toFixed(1)}% | ${voiceCase.notes.f1.toFixed(2)} | ${(voiceCase.notes.intervalDirectionAgreement * 100).toFixed(0)}% | ${register} |`,
    );
  }
  lines.push('', '| rhythm case | route | onsets F1 | median dev ms |', '|---|---|---|---|');
  for (const rhythmCase of report.rhythm) {
    lines.push(
      `| ${rhythmCase.id} | ${rhythmCase.route}${rhythmCase.routeMatches ? '' : ' (expected ' + rhythmCase.routeExpected + ')'} | ${rhythmCase.onsets.f1.toFixed(2)} | ${rhythmCase.onsets.medianDeviationMs.toFixed(0)} |`,
    );
  }
  lines.push('', '| pinned take | route | notes | distinct pitches | matches |', '|---|---|---|---|---|');
  for (const pinned of report.pinned) {
    lines.push(`| ${pinned.id} | ${pinned.route} | ${pinned.noteCount} | ${pinned.distinctPitches} | ${pinned.routeMatches ? 'yes' : 'NO'} |`);
  }
  return lines.join('\n');
}
