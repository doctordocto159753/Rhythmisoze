import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * A synthesised hum, fed to Chromium in place of a microphone.
 *
 * `--use-file-for-fake-audio-capture` makes `getUserMedia` return this file as
 * a live stream, which is the only way to exercise the real capture path in
 * CI. Without it the whole audio half of the product is untestable, and the
 * melody hang that prompted `capture.spec.ts` could only be found by hand.
 */
// `resolve` rather than `import.meta.url`: Playwright loads this config through
// the CommonJS require path, where `import.meta` is a syntax error.
const FAKE_MIC_WAV = resolve(__dirname, 'tests/fixtures/audio/hum-melody.wav');

const FAKE_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
  '--autoplay-policy=no-user-gesture-required',
];

const ORDINARY_PROJECT_IGNORES = /(?:capture|instruments|source-import|musician)\.spec\.ts/;
const LIVE_MUSICIAN_SPEC = /musician-real-chain\.spec\.ts/;
const STANDARD_PROJECT_IGNORES =
  process.env.E2E_REAL_MUSICIAN === '1'
    ? ORDINARY_PROJECT_IGNORES
    : [ORDINARY_PROJECT_IGNORES, LIVE_MUSICIAN_SPEC];

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

  /**
   * Concurrency is declared, not inherited from the machine.
   *
   * The capture project drives real Chromium instances with a fake audio
   * device and a MediaRecorder, alongside the Next server. Left to its default,
   * Playwright sizes the pool from the host's core count, so the same suite runs
   * 2 workers on one machine and 8 on another — and at 8 the browser sessions
   * start dying with `Protocol error: session closed`, which surfaces as a test
   * failure that has nothing to do with the code under test.
   *
   * Two workers is what the audio suite is validated at. It is not a way of
   * hiding a failure: every test still runs, on every browser, and the wall
   * clock cost is roughly ninety seconds.
   */
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },

  projects: [
    // The capture suite needs the fake microphone and only Chromium supports
    // supplying one, so it runs as its own project rather than across the
    // whole matrix. The real device path is covered by
    // `docs/runbooks/manual-device-checks.md`.
    {
      name: 'capture',
      testMatch: /(?:capture|instruments|source-import|musician)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: FAKE_MEDIA_ARGS },
      },
    },
    {
      name: 'chromium',
      // The live-service chain has its own runner and environment. Keeping it
      // out of the ordinary matrix preserves the lightweight browser suite;
      // the dedicated CI step still makes the regression a required check.
      testIgnore: STANDARD_PROJECT_IGNORES,
      use: { ...devices['Desktop Chrome'] },
    },
    { name: 'firefox', testIgnore: STANDARD_PROJECT_IGNORES, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testIgnore: STANDARD_PROJECT_IGNORES, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', testIgnore: STANDARD_PROJECT_IGNORES, use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', testIgnore: STANDARD_PROJECT_IGNORES, use: { ...devices['iPhone 14'] } },
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
