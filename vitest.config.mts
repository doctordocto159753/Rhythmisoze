import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'], reportsDirectory: 'coverage' },
  },
  resolve: {
    alias: {
      // `server-only` is a Next.js build-time guard with no Node runtime.
      // Stubbing it lets the server modules be unit-tested directly, which is
      // where the publish security boundary is actually verified.
      'server-only': r('./tests/stubs/server-only.ts'),
      '@contracts': r('./src/packages/contracts/index.ts'),
      '@retouch': r('./src/packages/retouch/index.ts'),
      '@audio-core': r('./src/packages/audio-core/index.ts'),
      '@midi': r('./src/packages/midi/index.ts'),
      '@synthesis': r('./src/packages/synthesis/index.ts'),
      '@': r('./src'),
    },
  },
});
