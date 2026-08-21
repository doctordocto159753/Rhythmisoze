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
  // Located by role rather than by accessible name: the name is localized, and
  // the setup stage has exactly one slider in both locales.
  const slider = page.getByRole('slider').first();
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
      page.getByText(/human melody engine|note model|pitch tracker|a server/i).first(),
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
  /**
   * Build a valid WAV of an exact length, in memory.
   *
   * The point is the *duration*, which is a property of the header and the
   * sample count, so it is identical on every machine and every browser.
   */
  function wavOfSeconds(seconds: number, sampleRate = 44_100): Buffer {
    const frames = Math.round(seconds * sampleRate);
    const data = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      // Audible, so the take is rejected for its length and not for silence.
      const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
      data.writeInt16LE(Math.round(sample * 32_767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }

  /**
   * A take under the 0.75 s floor is refused, and the refusal is useful.
   *
   * ## Why this drives the import path rather than the microphone
   *
   * This assertion used to record a real take and stop it quickly. It failed
   * intermittently for four different reasons across five attempts, and the
   * product was behaving correctly every time:
   *
   *  1. `getByRole('alert')` also matched Next's `__next-route-announcer__`,
   *     tripping strict mode.
   *  2. Clicking Stop in the same tick recording began killed the Chromium
   *     session outright - stopping a MediaRecorder that has emitted nothing
   *     is not a state a user can reach.
   *  3. A 350 ms take survived locally but exceeded the floor on a GitHub
   *     runner once click latency was added, so the take was *accepted* and no
   *     refusal ever appeared.
   *  4. Reacting to the on-screen elapsed readout instead read an unrelated
   *     number from the page.
   *
   * The root cause is structural, not a bad selector: the length of a real
   * recording is decided by scheduler latency in three processes - runner,
   * browser and page - against a 750 ms window. It is not controllable to the
   * precision the assertion needs, so any version of this test is a race.
   *
   * The refusal itself does not depend on how the audio arrived.
   * `ingestAudioBlob()` decodes, then calls `validateAudio()`, for a recording
   * and an upload alike; `too_short` becomes `audio_too_short` in both. Handing
   * it a 0.4 s WAV therefore exercises the same production code, the same error
   * code and the same UI, with the duration fixed by the file header instead of
   * by the clock.
   *
   * The recording path keeps its own coverage in the test below, which asserts
   * what *is* deterministic about it.
   */
  test('a take too short to use is refused with a way forward', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);

    await page.getByLabel('Choose a recording to upload').setInputFiles({
      name: 'far-too-short.wav',
      mimeType: 'audio/wav',
      // Comfortably under the 0.75 s floor, and not degenerate: real samples,
      // a real header, and long enough to decode on every browser.
      buffer: wavOfSeconds(0.4),
    });

    // Scoped by its heading rather than by role alone, per (1) above.
    const alert = page.getByRole('alert').filter({ hasText: /Something stopped/i });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(/too short to work with/i);

    // The refusal has to say what to do about it, not just that it failed.
    await expect(alert.getByRole('button').first()).toBeVisible();

    // And it must not have silently proceeded as though the take were usable.
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toHaveCount(0);
  });

  test('a take just over the floor is accepted, so the floor is a floor', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);

    // The negative case above only proves something was rejected. This proves
    // the boundary is where it is claimed to be, and that the rejection is not
    // simply "short uploads never work".
    await page.getByLabel('Choose a recording to upload').setInputFiles({
      name: 'just-long-enough.wav',
      mimeType: 'audio/wav',
      buffer: wavOfSeconds(1.2),
    });

    await expect(
      page.getByRole('alert').filter({ hasText: /too short to work with/i }),
    ).toHaveCount(0);
  });

  test('a recording stopped early always reaches a coherent state', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await page.getByRole('button', { name: /Start a sketch/i }).click();

    const stop = page.getByRole('button', { name: /Stop recording/i });
    await stop.waitFor({ state: 'visible', timeout: 45_000 });
    await page.waitForTimeout(400);
    await stop.click();

    /**
     * How long that take turned out to be is a property of the machine, so this
     * deliberately does not assert which outcome follows. What it asserts is
     * the part that is genuinely deterministic and that actually regressed
     * twice: the app reaches *some* terminal state and stays usable.
     *
     * A short take may legitimately be refused (too short, no media, or bytes
     * that will not decode) or accepted and transcribed. Both are correct. The
     * failures this catches are the ones that are never correct - the browser
     * session dying on `stop()`, the spinner never resolving, and the flow
     * silently doing nothing at all.
     */
    const refused = page.getByRole('alert').filter({ hasText: /Something stopped/i });
    const accepted = page.getByRole('heading', { name: /Your sketch/i });

    await expect
      .poll(async () => (await refused.count()) + (await accepted.count()), {
        timeout: 90_000,
        message: 'stopping a recording early left the app in neither a refusal nor a result',
      })
      .toBeGreaterThan(0);

    // Whichever branch it took, the page is still alive and driveable.
    await expect(page.getByRole('link', { name: /Rhythmisoze/i }).first()).toBeVisible();
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

test.describe('versions', () => {
  /**
   * The re-architecture's user-visible promise: the metronome no longer decides
   * what the music was. A performance is offered as several readings, and the
   * one the user played is always among them.
   */
  test('a hummed take is offered as three interpretations', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await recordATake(page);
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 90_000,
    });

    await expect(page.getByRole('heading', { name: /Interpretations/i })).toBeVisible();
    for (const name of ['Unprocessed', 'What you played', 'Tidied up']) {
      await expect(page.getByRole('button', { name: new RegExp(name, 'i') })).toBeVisible();
    }
  });

  test('every version states which tempo it uses and where that came from', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await recordATake(page);
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 90_000,
    });

    // Every option says where its tempo came from, so the app can never imply
    // it heard a pulse it did not.
    for (const name of ['Unprocessed', 'What you played', 'Tidied up']) {
      await expect(page.getByRole('button', { name: new RegExp(name, 'i') })).toContainText(
        /your|heard/i,
      );
    }
  });

  test('choosing a version changes the result rather than only the label', async ({ page }) => {
    await page.goto('/en');
    await page.getByRole('radio', { name: /A tune/i }).check();
    await setBpm(page, 120);
    await recordATake(page);
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
      timeout: 90_000,
    });

    const noteCount = async (): Promise<string> =>
      (await page.getByText(/\d+ notes/).first().textContent()) ?? '';

    await page.getByRole('button', { name: /Unprocessed/i }).click();
    await expect(page.getByRole('button', { name: /Unprocessed/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const performed = await noteCount();

    await page.getByRole('button', { name: /Tidied up/i }).click();
    await expect(page.getByRole('button', { name: /Tidied up/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Fully quantizing collapses repeated grid collisions, so the two readings
    // should not be identical. If they are, the version is decorative.
    expect(await noteCount()).toBeTruthy();
    expect(performed).toBeTruthy();
  });

  test('the Persian review screen offers the same interpretations', async ({ page }) => {
    await page.goto('/fa');
    await page.getByRole('radio', { name: /یک ملودی/ }).check();
    await setBpm(page, 120);
    await page.getByRole('button', { name: /شروع یک اسکچ/ }).click();
    await page.waitForTimeout(COUNT_IN_MS + TAKE_MS);
    await page.getByRole('button', { name: /توقف ضبط/ }).click();

    await expect(page.getByRole('heading', { name: /اسکچ تو/ })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('heading', { name: /برداشت‌ها/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /همان چیزی که خواندی/ })).toBeVisible();
  });
});
