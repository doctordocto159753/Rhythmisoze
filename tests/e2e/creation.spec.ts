import { expect, test, type Page } from '@playwright/test';

/**
 * US-1305 / Gate G3 - the creation flow as a person meets it.
 *
 * These assert the *user truth* gate: someone who does not know what
 * quantization is can get from the landing page to an armed recorder without
 * reading anything technical.
 */

async function gotoSupportedCreation(page: Page): Promise<void> {
  await page.goto('/en');
  const hasRequiredMedia = await page.evaluate(() => Boolean(
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.AudioContext !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof window.OfflineAudioContext !== 'undefined',
  ));

  // Playwright's Linux WebKit does not implement MediaRecorder - probed
  // directly it reports `undefined`, while Chromium and Firefox report a
  // function. The app therefore renders its unsupported-browser panel and the
  // setup screen never exists, so there is no tempo control to drive.
  //
  // The skip is paired with `unsupported-browser.spec.ts`, which asserts that
  // the fallback shown instead is correct, localized and navigable. A skip on
  // its own would only record that something did not run; together they make a
  // positive statement about every browser in the matrix.
  test.skip(
    !hasRequiredMedia,
    'Browser lacks MediaRecorder/getUserMedia; the fallback is asserted in unsupported-browser.spec.ts.',
  );
  // The landing copy is the marker that the page rendered its real content.
  //
  // This used to assert "Nothing is uploaded". That claim was withdrawn when
  // the Musician began sending symbolic note data to a server, so asserting it
  // would now be asserting a falsehood. What replaced it is narrower and still
  // true: the recording is processed on the device.
  await expect(page.getByText(/processed on your device/i).first()).toBeVisible();
}

test.describe('privacy copy', () => {
  test('the withdrawn local-only claim is gone in both languages', async ({ page }) => {
    /**
     * AC-12, asserted rather than assumed.
     *
     * "Nothing is uploaded" and "everything is on your device" stopped being
     * universally true when the Musician started sending note data to a
     * server. A claim like that reappearing is not a cosmetic regression -- it
     * is the product telling users something false about their data -- so it
     * gets a test rather than a code review.
     */
    for (const locale of ['en', 'fa'] as const) {
      await page.goto(`/${locale}`);
      const body = (await page.locator('body').innerText()).toLowerCase();
      for (const withdrawn of [
        'nothing is uploaded',
        'everything is on your device',
        'چیزی آپلود نمی‌شود',
        'همه‌چیز روی دستگاه خودت است',
      ]) {
        expect(body).not.toContain(withdrawn.toLowerCase());
      }
    }
  });

  test('what replaced it is specific rather than vague', async ({ page }) => {
    // Vague privacy copy is worse than none: it cannot be checked. The
    // replacement has to name what stays and what leaves.
    await page.goto('/en');
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/processed on your device/i);
  });
});

test.describe('landing and setup', () => {
  test('a bare URL lands in a locale', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/(fa|en)$/);
  });

  test('Persian renders right-to-left', async ({ page }) => {
    await page.goto('/fa');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await expect(html).toHaveAttribute('lang', 'fa');
  });

  test('English renders left-to-right', async ({ page }) => {
    await page.goto('/en');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('dir', 'ltr');
    await expect(html).toHaveAttribute('lang', 'en');
  });

  test('the language switch keeps the current page', async ({ page }) => {
    await page.goto('/en/workspace');
    await page.getByRole('link', { name: /فارسی|Switch to Persian/ }).click();
    await expect(page).toHaveURL(/\/fa\/workspace$/);
  });

  test('the first screen explains the product in one line', async ({ page }) => {
    await gotoSupportedCreation(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The privacy statement is on the first screen, not buried in a policy
    // page. Its wording changed when the local-only claim was withdrawn; what
    // matters for this test is that a specific, checkable statement is still
    // there and still first.
    await expect(page.getByText(/processed on your device/i)).toBeVisible();
  });
});

test.describe('tempo', () => {
  test('four taps produce a BPM', async ({ page }) => {
    await gotoSupportedCreation(page);
    const pad = page.getByRole('button', { name: /Tap four times/i });
    await expect(pad).toBeVisible();

    // ~500 ms apart is 120 BPM. The exact value depends on real timing, so the
    // assertion is that a tempo appeared and is inside the PRD's range.
    for (let i = 0; i < 5; i += 1) {
      await pad.click();
      await page.waitForTimeout(500);
    }

    const slider = page.getByRole('slider', { name: /Beats per minute/i });
    const value = Number(await slider.inputValue());
    expect(value).toBeGreaterThanOrEqual(40);
    expect(value).toBeLessThanOrEqual(200);
  });

  test('the BPM slider is keyboard operable', async ({ page }) => {
    await gotoSupportedCreation(page);
    const slider = page.getByRole('slider', { name: /Beats per minute/i });
    await slider.focus();
    const before = Number(await slider.inputValue());
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(Number(await slider.inputValue())).toBeGreaterThan(before);
  });

  test('recording cannot start before a tempo exists', async ({ page }) => {
    await gotoSupportedCreation(page);
    // The state machine forbids ARM from `idle`; the UI reflects that by not
    // offering the action at all.
    await expect(page.getByRole('button', { name: /Start a sketch/i })).toHaveCount(0);
  });

  test('the meter can be changed', async ({ page }) => {
    await gotoSupportedCreation(page);
    await page.getByRole('radio', { name: '3', exact: true }).check();
    await expect(page.getByRole('radio', { name: '3', exact: true })).toBeChecked();
  });
});

test.describe('unified input', () => {
  test('asks for a source without asking the user to classify it', async ({ page }) => {
    await gotoSupportedCreation(page);
    await expect(page.getByRole('radio', { name: /A tune/i })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /A beat/i })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Melody mode/i })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Instrument mode/i })).toHaveCount(0);
    await expect(page.getByLabel('Choose a recording to upload')).toHaveCount(1);
    await expect(page.getByLabel('Choose a MIDI file to import')).toHaveCount(1);
  });
});

test.describe('accessibility basics', () => {
  test('a skip link is the first focusable element', async ({ page }) => {
    await gotoSupportedCreation(page);
    await page.keyboard.press('Tab');
    await expect(page.locator('a.skip-link')).toBeFocused();
  });

  test('the whole setup stage is reachable by keyboard', async ({ page }) => {
    await gotoSupportedCreation(page);
    const reachable: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      const role = await page.evaluate(() => {
        const active = document.activeElement;
        return active ? `${active.tagName.toLowerCase()}` : '';
      });
      reachable.push(role);
    }
    expect(reachable).toContain('button');
    expect(reachable).toContain('input');
  });

  test('every image-role element carries a label', async ({ page }) => {
    await page.goto('/en');
    const unlabelled = await page.evaluate(() =>
      [...document.querySelectorAll('[role="img"]')].filter(
        (node) => !node.getAttribute('aria-label') && !node.getAttribute('aria-labelledby'),
      ).length,
    );
    expect(unlabelled).toBe(0);
  });
});
