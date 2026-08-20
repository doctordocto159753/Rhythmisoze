import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INSTRUMENTS,
  validateSampleManifest,
  type SampleManifest,
} from '@synthesis';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadManifest(instrument: (typeof INSTRUMENTS)[number]): Promise<SampleManifest> {
  const path = resolve(ROOT, 'public', 'instruments', instrument.samplePack as string);
  return validateSampleManifest(JSON.parse(await readFile(path, 'utf8')), instrument);
}

describe('realistic instrument manifests', () => {
  const sampled = INSTRUMENTS.filter((instrument) => instrument.type === 'sample');

  it('ships exactly the focused six-instrument MVP pack', () => {
    expect(sampled.map((instrument) => instrument.id)).toEqual([
      'piano', 'acoustic-guitar', 'violin', 'cello', 'trumpet', 'acoustic-kit',
    ]);
  });

  it('keeps every zone local, present, sized and checksum-pinned', async () => {
    for (const instrument of sampled) {
      const manifest = await loadManifest(instrument);
      const manifestDir = resolve(ROOT, 'public', 'instruments', dirname(instrument.samplePack as string));
      let bytes = 0;
      for (const zone of manifest.zones) {
        const path = resolve(manifestDir, zone.file);
        const file = await readFile(path);
        expect((await stat(path)).isFile(), `${instrument.id}: ${zone.file}`).toBe(true);
        expect(zone.bytes, `${instrument.id}: ${zone.file}`).toBe(file.byteLength);
        expect(zone.sha256, `${instrument.id}: ${zone.file}`).toBe(
          createHash('sha256').update(file).digest('hex'),
        );
        bytes += file.byteLength;
      }
      expect(bytes, instrument.id).toBe(instrument.samplePackBytes);
    }
  });

  it('records source, licence, attribution rule and redistribution permission', async () => {
    for (const instrument of sampled) {
      const manifest = await loadManifest(instrument);
      expect(manifest.license.spdx).toBe(instrument.license.spdx);
      expect(manifest.license.url).toBe(instrument.license.url);
      expect(manifest.license.redistribution).toBe(true);
      expect(typeof manifest.license.attributionRequired).toBe('boolean');
    }
  });

  it('keeps each lazy pack below the five-second broadband size budget', () => {
    // A conservative 8 Mbps connection moves one byte in 1 microsecond.
    for (const instrument of sampled) {
      const estimatedSeconds = (instrument.samplePackBytes as number) * 8 / 8_000_000;
      expect(estimatedSeconds, instrument.id).toBeLessThan(5);
    }
  });
});
