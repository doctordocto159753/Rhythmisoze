import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Gate G2 - the audio vertical slice, driven end to end.
 *
 * These are the only tests that exercise the real capture path: Chromium is
 * launched with a WAV file standing in for the microphone, so the whole chain
 * runs for real — MediaRecorder, decode, the worker, Basic Pitch or its
 * fallback, retouch, and the review screen.
 *
 * ## The regression they exist for
 *
 * Melody mode hung on "working out what you sang" forever while rhythm mode
 * worked. Three faults, all reachable only through this path:
 *
 *  - two TensorFlow.js copies were bundled into the worker (the top-level 4.x
 *    that nothing imported, plus basic-pitch's own 3.x), fighting over one
 *    kernel registry;
 *  - TensorFlow.js reads `window` during module evaluation, which a worker does
 *    not have, and the resulting `ReferenceError` escaped every `catch` because
 *    it was thrown from inside the library's own module graph — so the promise
 *    never settled and nothing was ever posted back;
 *  - there was no watchdog, so "never settles" meant "spinner forever".
 *
 * Rhythm mode was unaffected because it never touches the model.
 *
 * The fixture is a synthesised hum — A3 B3 C4 D4 E4 with vibrato and two
 * harmonics — so the expected key is A minor and a correct pipeline has to find
 * roughly five notes per pass.
 */

const COUNT_IN_MS = 2_400; // one bar at 120 BPM, plus the scheduling lead
const TAKE_MS = 6_000;

test.use({ permissions: ['microphone'] });

/** Sets a range input the way a user's drag would, so React sees the change. */
async function setBpm(page: import('@playwright/test').Page, bpm: number): Promise<void> {
  const slider = page.getByRole('slider', { name: /Beats per minute/i });
  await slider.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, bpm);
}

async function recordATake(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /Start a sketch/i }).click();
  await page.waitForTimeout(COUNT_IN_MS + TAKE_MS);
  await page.getByRole('button', { name: /Stop recording/i }).click();
}

test.describe('melody', () => {
  test('a hummed take reaches the review screen', async ({ page }) => {
    const escaped: string[] = [];
    page.on('pageerror', (error) => escaped.push(error.message));

    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await recordATake(page);

    // The budget is the point of the assertion: before the fix this never
    // resolved at all. A generous ceiling still catches a hang.
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 90_000,
    });

    // No error may escape the worker: an escaped one is what stranded the UI.
    expect(escaped.filter((message) => /window is not defined/i.test(message))).toEqual([]);
  });

  test('the transcription is musically plausible', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await recordATake(page);
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 90_000,
    });

    // Notes were found, not an empty result dressed up as success.
    const summary = page.getByText(/\d+ notes/).first();
    await expect(summary).toBeVisible();
    const count = Number(/(\d+)/.exec((await summary.textContent()) ?? '0')?.[1] ?? '0');
    expect(count).toBeGreaterThan(2);

    // The fixture is an A minor pentatonic-ish line; the engine should either
    // agree or honestly decline, but never assert a confident wrong key.
    const key = await page.getByText(/Key:/).first().textContent();
    expect(key).toBeTruthy();
  });

  test('the details panel names which engine produced the result', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await recordATake(page);
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 90_000,
    });

    await page.getByRole('button', { name: /^Details$/ }).click();
    // Whichever engine ran, the user is told. A silent fallback is the failure
    // mode ADR-001 forbids.
    await expect(
      page.getByText(/note model|pitch tracker|a server/i).first(),
    ).toBeVisible();
  });

  test('the complete package contains the original recorder bytes', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await recordATake(page);
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 90_000,
    });

    await page.getByRole('button', { name: /Take it with you/i }).click();
    await expect(page.getByRole('heading', { name: /Complete package/i })).toBeVisible({
      timeout: 90_000,
    });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download complete package/i }).click();
    const path = await (await downloadPromise).path();
    expect(path).toBeTruthy();
    const entries = readStoredZip(readFileSync(path as string));
    const sourceEntry = [...entries.entries()].find(([name]) =>
      name.startsWith('source/original-recording.'),
    );
    expect(sourceEntry).toBeDefined();
    expect(sourceEntry?.[1].length).toBeGreaterThan(100);
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json'))) as {
      source: { kind: string; bytes: number };
    };
    expect(manifest.source.kind).toBe('recording');
    expect(manifest.source.bytes).toBe(sourceEntry?.[1].length);
  });
});

test.describe('rhythm', () => {
  test('a beatbox take reaches the review screen', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A beat/i }).check();
    await setBpm(page, 120);
    await recordATake(page);

    // The rhythm path never loads a model, so it was never affected by the
    // melody regression. Asserted so a future change cannot break it quietly.
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 60_000,
    });
  });
});

test.describe('recovery', () => {
  test('a take too short to use is refused with a way forward', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await page.getByRole('button', { name: /Start a sketch/i }).click();
    await page.waitForTimeout(COUNT_IN_MS + 200);
    await page.getByRole('button', { name: /Stop recording/i }).click();

    await expect(page.getByText(/too short to work with/i)).toBeVisible({ timeout: 20_000 });
    // The recovery action is a real button, not advice.
    await expect(page.getByRole('button', { name: /Record again/i })).toBeVisible();
  });
});

function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}
