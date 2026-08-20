import { defineConfig, devices } from '@playwright/test';

/**
 * US-1203 - the browser matrix, and the E2E suite that runs across it.
 *
 * The projects below are the PRD's promised matrix. Chromium, Firefox and
 * WebKit cover the four desktop families (Edge shares Chromium's engine, and
 * the `msedge` channel is included for the packaging differences that
 * occasionally matter for media). Mobile Chrome and Mobile Safari cover the
 * phone path, which the design package insists is the primary test case rather
 * than a reduced desktop.
 *
 * What these tests do and do not cover, stated plainly because it matters for
 * reading the results: a headless browser has no microphone, so the specs
 * exercise everything up to and around capture - locale routing, the tempo
 * control, the state machine's guards, the workspace, the share page, the
 * design catalog - and the real microphone path is verified by hand against
 * `docs/runbooks/manual-device-checks.md`.
 *
 *     npx playwright install     # once, downloads the browsers
 *     npm run test:e2e
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    // Grants the permission so the flow can be driven past the prompt; the
    // browser still has no real device, which the specs account for.
    permissions: ['microphone'],
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npm run start -- --port 3000',
        url: 'http://127.0.0.1:3000/fa',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
