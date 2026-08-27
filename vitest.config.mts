import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/synthesis/**/*.test.ts',
      'tests/melody/**/*.test.ts',
      'tests/musical-judge/**/*.test.ts',
      'tests/music-teacher/**/*.test.ts',
      'tests/musician/**/*.test.ts',
      'tests/evaluation/**/*.test.ts',
    ],
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
      '@rhythm-extraction': r('./src/packages/rhythm-extraction/index.ts'),
      '@intent': r('./src/packages/intent/index.ts'),
      '@musical-judge': r('./src/packages/musical-judge/index.ts'),
      '@evidence': r('./src/packages/evidence/index.ts'),
      '@music-teacher': r('./src/packages/music-teacher/index.ts'),
      '@audio-core': r('./src/packages/audio-core/index.ts'),
      '@versions': r('./src/packages/versions/index.ts'),
      '@musician-client': r('./src/packages/musician-client/index.ts'),
      '@midi': r('./src/packages/midi/index.ts'),
      '@raw-transcription': r('./src/packages/raw-transcription/index.ts'),
      '@synthesis': r('./src/packages/synthesis/index.ts'),
      '@': r('./src'),
    },
  },
});
