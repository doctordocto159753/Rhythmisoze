import { expect, test } from '@playwright/test';

/**
 * US-1005 - the public share page.
 *
 * Without a configured database every id is unknown, which is itself the state
 * worth asserting: a dead link has to degrade into something useful rather than
 * into a stack trace.
 */

test('an unknown sketch shows a real page, not an error', async ({ page }) => {
  const response = await page.goto('/s/doesnotexist');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading').first()).toBeVisible();
});

test('the not-found page still offers the try-it CTA', async ({ page }) => {
  await page.goto('/s/doesnotexist');
  await expect(page.getByRole('link', { name: /Start a sketch|شروع یک اسکچ/ })).toBeVisible();
});
