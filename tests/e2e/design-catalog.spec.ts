import { expect, test } from '@playwright/test';

/**
 * D-0801 / D-0802 - the catalog is the screenshot surface.
 *
 * Every state has a stable anchor, so these tests double as the anchors a
 * visual regression suite would target.
 */

const SECTIONS = [
  'tokens',
  'type-scale',
  'buttons',
  'surfaces',
  'controls',
  'recording-states',
  'processing',
  'piano-roll',
  'errors',
  'instrument-registry',
];

for (const locale of ['fa', 'en'] as const) {
  test(`the catalog renders every section in ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}/design`);
    for (const section of SECTIONS) {
      await expect(page.locator(`#${section}`)).toBeVisible();
    }
  });
}

test('the registry audit passes in the catalog', async ({ page }) => {
  await page.goto('/en/design');
  await expect(page.getByText(/licence ledger complete/i)).toBeVisible();
});

test('the mixed-direction specimen keeps its Latin fragments intact', async ({ page }) => {
  await page.goto('/fa/design');
  // The bidi-isolated fragments must survive as written, not be reordered.
  await expect(page.getByText('C#4')).toBeVisible();
  await expect(page.getByText('sketch.mid')).toBeVisible();
});

test('the page does not scroll sideways at a phone width', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto('/fa/design');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
