import { expect, test } from '@playwright/test';

/**
 * The unsupported-browser fallback, asserted rather than skipped.
 *
 * ## Why this file exists
 *
 * Playwright's Linux WebKit does not implement `MediaRecorder` at all — probed
 * directly, it reports `undefined`, while Chromium and Firefox report a
 * function. That is a real platform limitation of the test browser, not
 * flakiness and not a defect in the product.
 *
 * The consequence is that on WebKit the app correctly renders its
 * unsupported-browser panel, and the creation setup screen never appears. Every
 * test that needs a tempo slider or a mode selector therefore has nothing to
 * interact with, and skips.
 *
 * A skip on its own is a hole in the suite: it records that something did not
 * run, not that anything is right. So this file asserts the *other* side of the
 * same condition. On a browser without the required media APIs it checks that
 * the fallback is correct and useful; on a browser with them it checks that the
 * fallback stays out of the way.
 *
 * Between the two, every browser in the matrix makes a positive assertion about
 * capability handling, and no behaviour is quietly marked as passing when it was
 * never executed.
 *
 * ## Why the panel assertions wait longer than the default
 *
 * The fallback is gated on `support.measured`, which is only true once the
 * client has hydrated and actually looked at the browser. That gate is
 * deliberate -- rendering "this browser cannot run Rhythmisoze" during prerender
 * would put the accusation into the static HTML of every page, before anything
 * had been checked -- and it means the panel is a *post-hydration* element.
 *
 * The probe below is not: `page.evaluate` reads the live globals immediately.
 * So the test can know the browser is unsupported several seconds before the app
 * has had the chance to say so, and the gap is exactly hydration time.
 *
 * Under five parallel WebKit workers that gap exceeded Playwright's 5 s default
 * and these two tests failed intermittently -- 2 of 12 runs. Serialised, the
 * same assertions pass 16 of 16, each in under 1.2 s. So the assertion was
 * right and the patience was wrong.
 */

/**
 * Long enough to cover hydration on a loaded worker, short enough that a panel
 * which never appears still fails the run rather than hanging it.
 *
 * Not a blanket timeout raise: it is applied only to the assertions that depend
 * on the app having hydrated, so an ordinary missing element still fails fast.
 */
const HYDRATION_TIMEOUT = 20_000;

/** The same primitives the app's own capability detection reads. */
async function mediaSupport(page: import('@playwright/test').Page): Promise<{
  secureContext: boolean;
  getUserMedia: boolean;
  mediaRecorder: boolean;
  webAudio: boolean;
  offlineAudio: boolean;
  supported: boolean;
}> {
  return page.evaluate(() => {
    const secureContext = window.isSecureContext;
    const getUserMedia = typeof navigator.mediaDevices?.getUserMedia === 'function';
    const mediaRecorder = typeof window.MediaRecorder !== 'undefined';
    const webAudio = typeof window.AudioContext !== 'undefined';
    const offlineAudio = typeof window.OfflineAudioContext !== 'undefined';
    return {
      secureContext,
      getUserMedia,
      mediaRecorder,
      webAudio,
      offlineAudio,
      supported: getUserMedia && mediaRecorder && webAudio && offlineAudio,
    };
  });
}

test.describe('capability handling', () => {
  test('the app agrees with the browser about what it can do', async ({ page }) => {
    await page.goto('/en');
    const support = await mediaSupport(page);

    // Whichever branch the browser falls into, the app must be in the matching
    // state. This is the assertion that makes the skips elsewhere honest.
    const unsupportedPanel = page.getByRole('heading', {
      name: /cannot run Rhythmisoze|needs a secure connection/i,
    });

    if (support.supported) {
      await expect(unsupportedPanel).toHaveCount(0);
      // And the creation screen really is usable.
      await expect(page.getByRole('slider').first()).toBeVisible();
    } else {
      await expect(unsupportedPanel).toBeVisible({ timeout: HYDRATION_TIMEOUT });
    }
  });

  test('an unsupported browser is told what is missing, not just that it failed', async ({
    page,
  }) => {
    await page.goto('/en');
    const support = await mediaSupport(page);
    test.skip(
      support.supported,
      'This browser supports the media APIs; the fallback is covered by the negative case above.',
    );

    // The panel must name the missing capability. "Something went wrong" would
    // leave the user with nothing to act on.
    await expect(page.getByText(/Missing:|secure connection/i).first()).toBeVisible({
      timeout: HYDRATION_TIMEOUT,
    });
  });

  test('an unsupported browser can still read the page and navigate', async ({ page }) => {
    // The fallback is not a dead end: branding, language switching and the
    // non-creation routes all have to keep working.
    await page.goto('/en');
    await expect(page.getByRole('link', { name: /Rhythmisoze/i }).first()).toBeVisible();

    await page.goto('/en/workspace');
    await expect(page.getByRole('heading', { name: /My sketches/i })).toBeVisible();

    await page.goto('/fa');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('the fallback is localized, not English-only', async ({ page }) => {
    await page.goto('/fa');
    const support = await mediaSupport(page);
    test.skip(support.supported, 'Only meaningful on a browser that shows the fallback.');

    // Persian users must not be handed an English error.
    await expect(
      page.getByRole('heading', { name: /نمی‌تواند ریتمیسوز را اجرا کند|اتصال امن/ }),
    ).toBeVisible({ timeout: HYDRATION_TIMEOUT });
  });
});
