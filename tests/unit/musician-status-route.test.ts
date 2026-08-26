/**
 * The real `/api/musician/status` route, exercised as a plain function.
 *
 * The release-validation gap this closes: every browser test used to mock the
 * status response, so a deployment whose web process answered
 * `{ enabled: false }` or `{ reachable: false }` for a healthy backend passed
 * the whole suite while showing no Musician area to anyone. These tests pin
 * the derivation — configuration in, availability JSON out — inside ordinary
 * CI, where no Python service or Docker network is required.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/musician/status/route';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  if (ORIGINAL_ENV.MUSICIAN_ENABLED === undefined) delete process.env.MUSICIAN_ENABLED;
  else process.env.MUSICIAN_ENABLED = ORIGINAL_ENV.MUSICIAN_ENABLED;
  if (ORIGINAL_ENV.MUSICIAN_API_URL === undefined) delete process.env.MUSICIAN_API_URL;
  else process.env.MUSICIAN_API_URL = ORIGINAL_ENV.MUSICIAN_API_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setEnv(enabled: string | undefined, url: string | undefined): void {
  if (enabled === undefined) delete process.env.MUSICIAN_ENABLED;
  else process.env.MUSICIAN_ENABLED = enabled;
  if (url === undefined) delete process.env.MUSICIAN_API_URL;
  else process.env.MUSICIAN_API_URL = url;
}

async function readJson(response: Response): Promise<{ enabled: boolean; reachable: boolean }> {
  return (await response.json()) as { enabled: boolean; reachable: boolean };
}

describe('GET /api/musician/status', () => {
  it('reports disabled when the deployment never configured the feature', async () => {
    setEnv(undefined, undefined);
    const body = await readJson(await GET());
    expect(body).toEqual({ enabled: false, reachable: false });
  });

  it('reports disabled when the flag is set but no service address exists', async () => {
    setEnv('true', undefined);
    const body = await readJson(await GET());
    expect(body).toEqual({ enabled: false, reachable: false });
  });

  it('reports available when configured and readiness answers ok', async () => {
    setEnv('true', 'http://musician-api:8080');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const body = await readJson(await GET());
    expect(body).toEqual({ enabled: true, reachable: true });
    // The probe goes to the service's own readiness endpoint, not liveness:
    // /health stays 200 while models are missing, which must not look ready.
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://musician-api:8080/ready',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('reports unreachable when readiness says a model is missing (503)', async () => {
    setEnv('true', 'http://musician-api:8080');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const body = await readJson(await GET());
    expect(body).toEqual({ enabled: true, reachable: false });
  });

  it('reports unreachable when the service cannot be reached at all', async () => {
    setEnv('true', 'http://musician-api:8080');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const body = await readJson(await GET());
    expect(body).toEqual({ enabled: true, reachable: false });
  });

  it('accepts a true flag regardless of case and surrounding whitespace', async () => {
    setEnv('TRUE ', 'http://musician-api:8080'); // case/whitespace tolerated
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const body = await readJson(await GET());
    expect(body.enabled).toBe(true);
  });

  it('treats any other flag value as off rather than guessing', async () => {
    setEnv('yes', 'http://musician-api:8080');
    const body = await readJson(await GET());
    expect(body).toEqual({ enabled: false, reachable: false });
  });
});
