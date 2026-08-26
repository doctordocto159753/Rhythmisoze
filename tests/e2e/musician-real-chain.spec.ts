import { expect, test, type Page } from '@playwright/test';

/**
 * The real Musician chain, with nothing faked above the model adapters.
 *
 * ## Why this spec exists
 *
 * Every other test in `musician.spec.ts` intercepts `/api/musician/*` in the
 * browser. That is the right call for UI behaviour, but it means the suite can
 * pass while the *real* availability path is broken: if
 * `GET /api/musician/status` reports `reachable: false` for a healthy service —
 * wrong environment variables, a network name the web container cannot resolve,
 * a readiness probe that disagrees with liveness — every mocked test still
 * passes and the review screen silently shows no Musician area at all. That is
 * precisely the release-validation gap this file closes.
 *
 * What must be true before these tests run (the runner script
 * `scripts/run-musician-e2e.mjs`, or an equivalent compose stack, sets this up):
 *
 * - the app under test was started with `MUSICIAN_ENABLED=true` and a live
 *   `MUSICIAN_API_URL`;
 * - something real answers that URL's `/ready` (in CI this is the actual
 *   Python service running its deterministic fake adapters — same contract,
 *   same routes, no weights).
 *
 * Gated behind `E2E_REAL_MUSICIAN=1` so ordinary frontend CI never needs Python.
 */

test.skip(
  process.env.E2E_REAL_MUSICIAN !== '1',
  'run through scripts/run-musician-e2e.mjs against a server wired to a live musician-api',
);

const configuredResultTimeout = Number.parseInt(
  process.env.E2E_MUSICIAN_RESULT_TIMEOUT_MS ?? '',
  10,
);
const RESULT_TIMEOUT_MS =
  Number.isFinite(configuredResultTimeout) && configuredResultTimeout > 0
    ? configuredResultTimeout
    : 60_000;

/** Same technique as musician.spec.ts; duplicated to keep specs standalone. */
async function setBpm(page: Page, bpm: number) {
  const slider = page.getByRole('slider', { name: /Beats per minute|ضرب در دقیقه/i });
  await slider.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, bpm);
}

async function reachReview(page: Page) {
  await page.goto('/en');
  await setBpm(page, 120);
  await page
    .getByLabel('Choose a recording to upload')
    .setInputFiles('tests/fixtures/audio/hum-melody.wav');
  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
    timeout: 90_000,
  });
}

test.describe('real musician chain', () => {
  test('the deployed status route reports the musician as truly available', async ({ request }) => {
    // The assertion the previous suite could never make: the REAL route, not a
    // browser mock, says enabled and reachable. A deployment whose web process
    // lacks the musician environment fails here with the exact JSON in the message.
    const response = await request.get('/api/musician/status');
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { enabled: boolean; reachable: boolean };
    expect(body, `status said ${JSON.stringify(body)}`).toEqual({
      enabled: true,
      reachable: true,
    });
  });

  test('review shows the panel, generates through the real API, and offers valid versions', async ({
    page,
  }) => {
    test.setTimeout(RESULT_TIMEOUT_MS + 60_000);
    const jobPosts: string[] = [];
    page.on('request', (request) => {
      if (
        request.url().includes('/api/musician/jobs') &&
        request.method() === 'POST'
      ) {
        jobPosts.push(request.url());
      }
    });

    await reachReview(page);

    // The panel exists because the real availability answer said yes.
    await expect(page.getByRole('heading', { name: /Take it further/i })).toBeVisible({
      timeout: 15_000,
    });
    const completedResponse = page.waitForResponse(
      async (response) => {
        if (
          response.request().method() !== 'GET' ||
          !/\/api\/musician\/jobs\/[^/]+$/.test(response.url()) ||
          !response.ok()
        ) {
          return false;
        }
        const body = (await response.json()) as { state?: unknown };
        return body.state === 'succeeded';
      },
      { timeout: RESULT_TIMEOUT_MS },
    );
    await page.getByRole('button', { name: /Create musician versions/i }).click();

    // The POST left the browser and reached the app's own API (which proxies to
    // the service); the variants came back through polling and landed in the picker.
    const completedJobResponse = await completedResponse;
    const completed = (await completedJobResponse.json()) as {
      state: 'succeeded';
      result: Record<'refined' | 'developed' | 'expanded', { source_fallback: boolean }>;
    };
    expect(jobPosts.length).toBeGreaterThanOrEqual(1);
    expect(jobPosts[0]).toContain('/api/musician/jobs');

    const variants = [
      { key: 'refined', label: /Shaped/i },
      { key: 'developed', label: /Taken further/i },
      { key: 'expanded', label: /Grown/i },
    ] as const;
    const offered = variants.filter(({ key }) => !completed.result[key].source_fallback);
    expect(offered.length, 'the real service returned no genuine variant').toBeGreaterThan(0);

    // Every genuine result is offered. A source fallback is the Teacher copied
    // back by the service and must never masquerade as an AI version.
    for (const { key, label } of variants) {
      const button = page.getByRole('button', { name: label });
      if (completed.result[key].source_fallback) await expect(button).toHaveCount(0);
      else await expect(button).toBeVisible();
    }

    // And a generated version is genuinely selectable, not merely present.
    const firstOffered = offered[0] as (typeof offered)[number];
    const button = page.getByRole('button', { name: firstOffered.label });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  });
});
