import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const COUNT_IN_MS = 2_400;
const TAKE_MS = 6_000;

test.use({ permissions: ['microphone'] });

async function reachReview(page: Page): Promise<void> {
  await page.goto('/en');
  await page.getByRole('button', { name: /Start a sketch/i }).click();
  await page.waitForTimeout(COUNT_IN_MS + TAKE_MS);
  await page.getByRole('button', { name: /Stop recording/i }).click();
  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({ timeout: 90_000 });
}

test('initial navigation downloads no instrument samples', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/instruments/')) requests.push(request.url());
  });
  await page.goto('/en');
  await page.waitForLoadState('networkidle');
  expect(requests).toEqual([]);
});

test('one selected pack lazy-loads, previews, renders and exports a real WAV', async ({ page }) => {
  test.setTimeout(120_000);

  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/instruments/')) requests.push(request.url());
  });
  await page.route('**/instruments/**', async (route) => {
    // Keep progress observable while preserving the real same-origin response.
    if (/\.(mp3|wav)$/.test(route.request().url())) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await route.continue();
  });

  await reachReview(page);
  expect(requests).toEqual([]);

  const card = page.getByRole('listitem').filter({ hasText: 'Cedar Steel' });
  const loadStarted = Date.now();
  await card.getByRole('button').first().click();
  await expect(card.getByRole('progressbar')).toBeVisible();
  await expect(card.getByText('Ready to play')).toBeVisible({ timeout: 5_000 });
  expect(Date.now() - loadStarted).toBeLessThan(5_000);
  expect(requests.length).toBeGreaterThan(10);
  expect(requests.every((url) => url.includes('/instruments/cedar-steel/'))).toBe(true);

  const loadedRequestCount = requests.length;
  await card.getByRole('button', { name: /Hear it: Cedar Steel/i }).click();
  await expect(card.getByRole('button', { name: /Stop: Cedar Steel/i })).toBeVisible();
  expect(requests).toHaveLength(loadedRequestCount);
  await card.getByRole('button', { name: /Stop: Cedar Steel/i }).click();

  await page.getByRole('button', { name: /Take it with you/i }).click();
  await expect(page.getByRole('heading', { name: /Take it with you/i })).toBeVisible({
    timeout: 30_000,
  });
  expect(requests).toHaveLength(loadedRequestCount);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Audio file/i }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const bytes = await readFile(path as string);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  expect(bytes.readUInt16LE(22)).toBe(2);
  expect(bytes.readUInt32LE(24)).toBe(44_100);
  expect(bytes.readUInt16LE(34)).toBe(16);
  let nonSilent = false;
  for (let offset = 44; offset + 1 < bytes.length; offset += 2) {
    if (bytes.readInt16LE(offset) !== 0) { nonSilent = true; break; }
  }
  expect(nonSilent).toBe(true);
});
