/**
 * Phase C — produce the frozen baseline by driving the real product.
 *
 * Not a test. A capture harness that happens to be easiest to write as one,
 * because the transcription path this benchmark is measuring lives in a browser
 * worker and the only faithful way to run it is a browser.
 *
 * It uploads each frozen source through the ordinary upload path, waits for the
 * review screen, exports the complete package, and writes the package's own
 * MIDI out beside the source. The result is whatever the product produced. It
 * is never adjusted, and any case that fails to transcribe is recorded as a
 * failure rather than retried until it looks better.
 *
 * Run against a server already serving the baseline build:
 *
 *     E2E_BASE_URL=http://127.0.0.1:3311 npx playwright test \
 *       --project=capture tests/e2e/benchmark-capture.spec.ts --workers=1
 *
 * Skipped unless `BENCHMARK_CASES` points at the corpus, so it never runs as
 * part of the ordinary suite.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const CORPUS = process.env.BENCHMARK_CASES;
const BASELINE_COMMIT = process.env.BENCHMARK_COMMIT ?? 'unknown';

/**
 * Long, because these are real thirty-second takes on a machine also running a
 * browser, and a timeout here would be recorded as a product failure when it is
 * only impatience.
 */
const PROCESS_TIMEOUT_MS = 240_000;

const CASE_IDS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];

/** Minimal stored-zip reader; the export writes without compression. */
function readStoredZip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const size = buffer.readUInt32LE(offset + 18);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, buffer.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}

test.describe.configure({ mode: 'serial' });

test.skip(!CORPUS, 'Set BENCHMARK_CASES to the corpus directory to capture a baseline.');

for (const caseId of CASE_IDS) {
  test(`capture ${caseId}`, async ({ page }) => {
    test.setTimeout(PROCESS_TIMEOUT_MS + 120_000);

    const caseDir = join(CORPUS as string, caseId);
    const source = join(caseDir, 'source.wav');
    expect(existsSync(source), `missing ${source}`).toBe(true);

    await page.goto('/en');
    await page.getByLabel('Choose a recording to upload').setInputFiles(source);
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: PROCESS_TIMEOUT_MS,
    });

    await page.getByRole('button', { name: /Take it with you/i }).click();
    await expect(page.getByRole('heading', { name: /Complete package/i })).toBeVisible({
      timeout: PROCESS_TIMEOUT_MS,
    });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download complete package/i }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).toBeTruthy();

    const entries = readStoredZip(readFileSync(path as string));
    const names = [...entries.keys()];

    // The canonical reading is the Judge's — the app's own default selection and
    // the one the product presents as "what you played". A rhythm take has no
    // Judge stage, so it is captured from `notes.mid` and flagged, rather than
    // being quietly absent from the corpus.
    const canonicalName = entries.has('judge.mid') ? 'judge.mid' : 'notes.mid';
    const canonical = entries.get(canonicalName);
    expect(canonical, `no canonical MIDI in package for ${caseId}: ${names.join(', ')}`).toBeTruthy();

    const outDir = join(caseDir, 'baseline');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(caseDir, `baseline_${BASELINE_COMMIT.slice(0, 7)}.mid`), canonical as Buffer);

    // Everything else the package produced, kept whole. A later question about
    // why a number looks wrong is usually answered by a file nobody thought to
    // keep, and the package is small.
    for (const [name, data] of entries) {
      if (name === 'rendered.wav' || name.startsWith('source/')) continue;
      writeFileSync(join(outDir, name.replace(/[\\/]/g, '_')), data);
    }

    const manifest = entries.get('manifest.json');
    writeFileSync(
      join(outDir, 'capture.json'),
      `${JSON.stringify(
        {
          case: caseId,
          baselineCommit: BASELINE_COMMIT,
          canonicalFrom: canonicalName,
          packageEntries: names,
          capturedAt: new Date().toISOString(),
          manifest: manifest ? JSON.parse(manifest.toString('utf8')) : null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  });
}
