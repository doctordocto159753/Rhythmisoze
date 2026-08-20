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

  // Capability measurement replaces the setup screen after hydration in
  // Playwright's Linux WebKit. Probe the same browser primitives first so the
  // test cannot race that replacement while locating an interactive control.
  test.skip(
    !hasRequiredMedia,
    'Playwright WebKit does not expose the required recording and Web Audio APIs.',
  );
  await expect(page.getByText(/Nothing is uploaded/i).first()).toBeVisible();
}

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
    // The privacy claim is on the first screen, not buried in a policy page.
    await expect(page.getByText(/Nothing is uploaded/i)).toBeVisible();
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

test.describe('mode', () => {
  test('melody and rhythm are both offered without jargon', async ({ page }) => {
    await gotoSupportedCreation(page);
    await expect(page.getByRole('radio', { name: /A tune/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /A beat/i })).toBeVisible();
    await page.getByRole('radio', { name: /A beat/i }).check();
    await expect(page.getByRole('radio', { name: /A beat/i })).toBeChecked();
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
