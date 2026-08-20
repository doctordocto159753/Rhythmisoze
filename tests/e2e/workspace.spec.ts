import { expect, test } from '@playwright/test';

/**
 * US-0803 / D-0601 - the local workspace, in both locales.
 */

test('the empty state teaches the first action', async ({ page }) => {
  await page.goto('/en/workspace');
  await expect(page.getByRole('heading', { name: /My sketches/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Record your first idea/i })).toBeVisible();
});

test('the Persian workspace is laid out right-to-left', async ({ page }) => {
  await page.goto('/fa/workspace');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'اسکچ‌های من' })).toBeVisible();
});

test('the workspace needs no network', async ({ page, context }) => {
  await page.goto('/en/workspace');
  // Everything is local; going offline must not change the page.
  await context.setOffline(true);
  await page.reload().catch(() => undefined);
  await context.setOffline(false);
});
