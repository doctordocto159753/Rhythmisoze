import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The AI Musician, end to end.
 *
 * ## Why the service is faked at the route boundary
 *
 * These tests intercept `/api/musician/*` in the browser rather than standing up
 * the Python service. That is not a shortcut around testing the real thing — it
 * is testing the right thing:
 *
 *  - the service has its own suite, in its own language, with 104 tests;
 *  - running it here would mean 1.43 GB of model weights in frontend CI, which
 *    the brief explicitly forbids (§16);
 *  - and the *generated music* is not what these tests are about. What they
 *    check is that the app stays usable while a generation runs, that the two
 *    versions become playable, that failures leave the Teacher intact, and that
 *    export and reload behave — none of which depends on the notes being good.
 *
 * Everything below the interception is real: the real client, the real Zod
 * validation, the real version registry, the real instrument engine.
 *
 * The `available` flag is what a deployment without a Musician looks like, and
 * the first test asserts that case explicitly (AC-01).
 */

const JOB_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function variant(kind: 'refined' | 'developed' | 'expanded', transpose: number, repeats = 1) {
  // Two audibly different variants, so a test can tell which one is playing
  // from the notes rather than from a label.
  // `repeats` lets Expanded be genuinely longer, so the six-version UI is
  // exercised against variants that actually differ in length.
  const shape = [0, 2, 4, 5, 7, 5, 4, 2];
  const notes = Array.from({ length: shape.length * repeats }, (_, index) => ({
    pitch: 60 + (shape[index % shape.length] as number) + transpose,
    start_sec: index * 0.5,
    end_sec: index * 0.5 + 0.45,
    velocity: 92,
  }));
  return {
    kind,
    notes,
    tempo: { bpm: 120, confidence: 0.85 },
    meter: { numerator: 4, denominator: 4, confidence: 0.8 },
    key: { tonic: 'C', mode: 'major', confidence: 0.75 },
    duration_sec: 4,
    identity: {
      contour_similarity: 0.94,
      motif_survival: 0.9,
      phrase_similarity: 0.92,
      tonal_compatibility: 1,
      meter_compatibility: 1,
      duration_ratio: 1,
      pitch_range_change: 1,
      note_density_change: 1,
      aggregate: 0.93,
      passed: true,
      failures: [],
    },
    infill_spans:
      kind === 'developed'
        ? [{ start_index: 2, end_index: 5, reason: 'interval outlier: 9 semitones against a median of 2' }]
        : [],
  };
}

function result(seedOffset = 0) {
  return {
    version: 1,
    source_id: 'e2e',
    refined: variant('refined', seedOffset),
    developed: variant('developed', 7 + seedOffset),
    expanded: variant('expanded', 2 + seedOffset, 4),
    provenance: {
      melody_t5_revision: 'test-melody-rev',
      midi_rwkv_revision: 'test-rwkv-rev',
      musician_service_version: '0.1.0',
      input_fingerprint: 'e2efingerprint',
      seeds: { base: 12345 + seedOffset },
      parameters: { refined: { candidate_count: 4 }, developed: { candidate_count: 4 } },
      elapsed_ms: 1500,
    },
    diagnostics: {
      candidate_counts: { refined: 4, developed: 4, expanded: 5, accepted: 13 },
      rejected_candidates: [],
      identity_guard_summary: { rejection_rate: 0 },
    },
  };
}

interface FakeOptions {
  available?: boolean;
  /** Polls returning "running" before the result lands. */
  pollsBeforeDone?: number;
  outcome?: 'succeed' | 'fail' | 'malformed' | 'never';
}

/** Installs a fake Musician at the app's own API boundary. */
async function fakeMusician(page: Page, options: FakeOptions = {}) {
  const { available = true, pollsBeforeDone = 1, outcome = 'succeed' } = options;
  let polls = 0;
  let generation = 0;

  await page.route('**/api/musician/status', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: available, reachable: available }),
    }),
  );

  await page.route('**/api/musician/jobs', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    polls = 0;
    generation += 1;
    // The request body is asserted separately; here we only accept it.
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: JOB_ID, state: 'pending' }),
    });
  });

  await page.route('**/api/musician/jobs/*', async (route: Route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: JOB_ID, state: 'cancelled' }),
      });
    }

    polls += 1;
    if (outcome === 'never' || polls <= pollsBeforeDone) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: JOB_ID, state: 'running' }),
      });
    }

    if (outcome === 'fail') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: JOB_ID, state: 'failed', error: 'ModelNotLoaded' }),
      });
    }

    if (outcome === 'malformed') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        // Valid JSON, valid shape, impossible music. The exact failure a
        // generative service produces.
        body: JSON.stringify({
          jobId: JOB_ID,
          state: 'succeeded',
          result: { ...result(), refined: { ...variant('refined', 0), notes: [{ pitch: 9999 }] } },
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: JOB_ID,
        state: 'succeeded',
        result: result((generation - 1) * 2),
      }),
    });
  });
}

/** Gets to the review screen with a Teacher version present. */
async function reachReview(page: Page) {
  await page.goto('/en');
  await page
    .getByLabel('Choose a recording to upload')
    .setInputFiles('tests/fixtures/audio/hum-melody.wav');
  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
    timeout: 90_000,
  });
}

test.describe('when the deployment has no Musician', () => {
  test('the three-version flow is completely unchanged', async ({ page }) => {
    // AC-01. This is the regression guard that matters most: the product
    // existed before this feature and must not depend on it.
    await fakeMusician(page, { available: false });
    await reachReview(page);

    await expect(page.getByRole('button', { name: /Unprocessed/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /What you played/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Tidied up/i })).toBeVisible();

    // The area is absent, not disabled. A greyed-out button would advertise
    // something this deployment can never provide.
    await expect(page.getByRole('heading', { name: /Take it further/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Create musician versions/i })).toHaveCount(0);

    // And the rest of the screen still works.
    await page.getByRole('button', { name: /Tidied up/i }).click();
    await expect(page.getByRole('button', { name: /Tidied up/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('generating Musician versions', () => {
  test('both versions arrive and become selectable', async ({ page }) => {
    await fakeMusician(page);
    await reachReview(page);

    await expect(page.getByRole('heading', { name: /Take it further/i })).toBeVisible();
    await page.getByRole('button', { name: /Create musician versions/i }).click();

    // Before the result lands, the two versions do not exist. Offering them
    // early would put unplayable entries in the picker.
    await expect(page.getByRole('button', { name: /Shaped/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Grown/i })).toHaveCount(0);

    await expect(page.getByRole('button', { name: /Shaped/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Taken further/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Grown/i })).toBeVisible();

    // Six versions, all switchable without leaving the screen (AC-12).
    for (const name of [
      /Unprocessed/i,
      /What you played/i,
      /Tidied up/i,
      /Shaped/i,
      /Taken further/i,
      /Grown/i,
    ]) {
      const button = page.getByRole('button', { name }).first();
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      // The review screen is still the review screen: switching is not a
      // navigation, so nothing resets.
      await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible();
    }
  });

  test('the page stays usable while generation runs', async ({ page }) => {
    // AC-04. The whole reason the feature is asynchronous.
    await fakeMusician(page, { outcome: 'never' });
    await reachReview(page);

    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(page.getByRole('status')).toContainText(
      /Waiting its turn|Working through the whole melody/i,
      { timeout: 20_000 },
    );

    // Another version can still be selected, and the instrument changed.
    await page.getByRole('button', { name: /Unprocessed/i }).click();
    await expect(page.getByRole('button', { name: /Unprocessed/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: /Stop$/i })).toBeVisible();
  });

  test('only symbolic note data is sent, never audio', async ({ page }) => {
    // AC-02 and AC-03, observed on the wire.
    await fakeMusician(page);
    const bodies: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/musician/jobs') && request.method() === 'POST') {
        bodies.push(request.postData() ?? '');
      }
    });

    await reachReview(page);
    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(page.getByRole('button', { name: /Shaped/i })).toBeVisible({ timeout: 30_000 });

    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(bodies[0] as string) as {
      teacher: Record<string, unknown> & { phrases: unknown[] };
    };
    expect(Object.keys(payload.teacher).sort()).toEqual([
      'durationSec',
      'key',
      'meter',
      'notes',
      'phrases',
      'sourceId',
      'tempo',
    ]);
    // Phrase boundaries are symbolic musical evidence too. Their presence is
    // the contract that stops the Musician from receiving isolated events.
    expect(payload.teacher.phrases.length).toBeGreaterThan(0);
    // A whole take of audio would be orders of magnitude larger than this.
    expect((bodies[0] as string).length).toBeLessThan(200_000);
    expect(bodies[0]?.toLowerCase()).not.toContain('audio');
  });

  test('cancelling leaves every other version untouched', async ({ page }) => {
    // AC-06.
    await fakeMusician(page, { outcome: 'never' });
    await reachReview(page);

    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(page.getByRole('button', { name: /Stop$/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Stop$/i }).click();

    await expect(page.getByRole('status')).toContainText(/Stopped/i);
    for (const name of [/Unprocessed/i, /What you played/i, /Tidied up/i]) {
      await expect(page.getByRole('button', { name }).first()).toBeVisible();
    }
    await page.getByRole('button', { name: /Tidied up/i }).click();
    await expect(page.getByRole('button', { name: /Tidied up/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('when the Musician fails', () => {
  test('a failed generation leaves the Teacher fully usable', async ({ page }) => {
    // AC-10. A model outage must not become a fatal app state.
    await fakeMusician(page, { outcome: 'fail' });
    await reachReview(page);

    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(page.getByText(/Everything else still works/i)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /Tidied up/i }).click();
    await expect(page.getByRole('button', { name: /Tidied up/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // And a retry is offered rather than a dead end.
    await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();
  });

  test('a malformed response is refused rather than rendered', async ({ page }) => {
    // Valid JSON containing an impossible pitch. It must not reach the picker.
    await fakeMusician(page, { outcome: 'malformed' });
    await reachReview(page);

    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(page.getByText(/Everything else still works/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Shaped/i })).toHaveCount(0);
  });

  test('an unreachable service is not treated as a broken app', async ({ page }) => {
    await page.route('**/api/musician/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, reachable: true }),
      }),
    );
    await page.route('**/api/musician/jobs', (route) => route.abort('connectionrefused'));

    await reachReview(page);
    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(page.getByText(/not reachable right now/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('generation status is announced', async ({ page }) => {
    await fakeMusician(page, { outcome: 'never' });
    await reachReview(page);

    // A persistent live region, so the announcement is consistent across
    // screen readers rather than depending on when the node was inserted.
    const status = page.getByRole('status');
    await expect(status).toHaveAttribute('aria-live', 'polite');

    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(status).toContainText(/Waiting its turn|Working through/i, { timeout: 20_000 });
  });

  test('the whole area is reachable by keyboard', async ({ page }) => {
    await fakeMusician(page);
    await reachReview(page);

    const start = page.getByRole('button', { name: /Create musician versions/i });
    await start.focus();
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Shaped/i })).toBeVisible({ timeout: 30_000 });

    // And the new versions are reachable the same way.
    const shaped = page.getByRole('button', { name: /Shaped/i });
    await shaped.focus();
    await page.keyboard.press('Enter');
    await expect(shaped).toHaveAttribute('aria-pressed', 'true');
  });

  test('the Persian area is laid out right to left and is not English', async ({ page }) => {
    // AC-11.
    await fakeMusician(page);
    await page.goto('/fa');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    await page
      .getByLabel('انتخاب فایل صوتی برای آپلود')
      .setInputFiles('tests/fixtures/audio/hum-melody.wav');
    await expect(page.getByRole('heading', { name: /اسکچ تو/ })).toBeVisible({ timeout: 90_000 });

    await expect(page.getByRole('heading', { name: /یک قدم جلوتر ببر/ })).toBeVisible();
    const start = page.getByRole('button', { name: /ساخت نسخه‌های نوازنده/ });
    await expect(start).toBeVisible();
    await start.click();

    // Persian users must not be handed English status text.
    await expect(page.getByRole('status')).toContainText(/در نوبت است|دارد کل ملودی/, {
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: /پرداخت‌شده/ })).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('regeneration', () => {
  test('a new pair does not overwrite the accepted one until chosen', async ({ page }) => {
    // §9. The previous result survives until the user decides.
    await fakeMusician(page);
    await reachReview(page);

    await page.getByRole('button', { name: /Create musician versions/i }).click();
    await expect(page.getByRole('button', { name: /Shaped/i })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: /Try another/i }).click();
    await expect(page.getByText(/Which do you want to keep/i)).toBeVisible({ timeout: 30_000 });

    // Both choices are offered with equal weight; neither is applied for them.
    await expect(page.getByRole('button', { name: /Keep the new ones/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Keep the previous ones/i })).toBeVisible();

    // Keeping the previous pair leaves the versions playable.
    await page.getByRole('button', { name: /Keep the previous ones/i }).click();
    await expect(page.getByRole('button', { name: /Shaped/i })).toBeVisible();
  });
});
