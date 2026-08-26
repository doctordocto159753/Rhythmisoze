#!/usr/bin/env node
/**
 * Runs the real-chain Musician E2E against a fully wired stack.
 *
 * Stands up:
 *   1. the actual Python musician-api (`services/musician`) on :8091, running
 *      its deterministic fake adapters — same FastAPI app, same routes, same
 *      contract as the containerised real-adapter deployment, without weights;
 *   2. the production Next server on :3215 with MUSICIAN_ENABLED=true and
 *      MUSICIAN_API_URL pointed at (1);
 * and then runs `tests/e2e/musician-real-chain.spec.ts` with browser route
 * mocking switched off for /api/musician/*.
 *
 * Usage:
 *   npm run build          # the Next server serves the production build
 *   node scripts/run-musician-e2e.mjs [extra playwright args...]
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 8091;
const WEB_PORT = 3215;
const NEXT_CLI = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const PLAYWRIGHT_CLI = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const PY_PATHS = [
  path.join(root, 'services', 'musician', 'api', 'src'),
  path.join(root, 'services', 'musician', 'shared', 'src'),
].join(process.platform === 'win32' ? ';' : ':');

const children = [];

function waitFor(url, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
          resolvePromise();
        } else {
          retry();
        }
      });
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) rejectPromise(new Error(`timed out waiting for ${what}`));
      else setTimeout(attempt, 500);
    };
    attempt();
  });
}

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (stream) => {
    stream.on('data', (chunk) => {
      process.stdout.write(`[${name}] ${chunk}`);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  children.push(child);
  return child;
}

async function main() {
  // 1. The service. PYTHONPATH instead of an install: no virtualenv required.
  run('musician-api', 'python', [
    '-m', 'uvicorn', 'musician_api.main:app', '--host', '127.0.0.1', '--port', String(API_PORT),
  ], {
    cwd: path.join(root, 'services', 'musician'),
    env: {
      PYTHONPATH: PY_PATHS,
      MUSICIAN_ADAPTERS: 'fake',
      MUSICIAN_REDIS_URL: '',
    },
  });

  await waitFor(`http://127.0.0.1:${API_PORT}/ready`, 'musician-api /ready', 30_000);

  // 2. The app, configured exactly like a deployment that offers the feature.
  run('web', process.execPath, [NEXT_CLI, 'start', '-p', String(WEB_PORT)], {
    env: {
      MUSICIAN_ENABLED: 'true',
      MUSICIAN_API_URL: `http://127.0.0.1:${API_PORT}`,
    },
  });

  await waitFor(`http://127.0.0.1:${WEB_PORT}/en`, 'next server', 60_000);

  // 3. The spec, with nothing intercepted.
  const playwrightArgs = [
    PLAYWRIGHT_CLI, 'test',
    'tests/e2e/musician-real-chain.spec.ts',
    '--project=chromium',
    '--reporter=line',
    ...process.argv.slice(2),
  ];
  const testRun = run('playwright', process.execPath, playwrightArgs, {
    env: {
      E2E_BASE_URL: `http://127.0.0.1:${WEB_PORT}`,
      E2E_REAL_MUSICIAN: '1',
    },
  });

  const code = await new Promise((resolvePromise) => {
    testRun.on('exit', resolvePromise);
    testRun.on('error', () => resolvePromise(1));
  });

  // The spawned servers keep the event loop alive; without an explicit exit
  // this script hangs forever after reporting its result.
  teardown();
  process.exit(typeof code === 'number' ? code : 1);
}

function teardown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
}

// Hard ceiling: a stuck server or browser must not hang CI indefinitely.
const WATCHDOG_MS = 10 * 60_000;
const watchdog = setTimeout(() => {
  console.error(`[runner] exceeded ${WATCHDOG_MS / 1000}s; tearing down`);
  teardown();
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

process.on('exit', teardown);
process.on('SIGINT', () => {
  teardown();
  process.exit(130);
});

main().catch((error) => {
  console.error(error);
  teardown();
  process.exit(1);
});
