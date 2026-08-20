/**
 * Copies the Basic Pitch model out of node_modules and into `public/`.
 *
 * The model is self-hosted rather than fetched from a CDN for three reasons:
 * the Content-Security-Policy stays closed to third-party hosts, the model
 * version is pinned to the package version in the lockfile instead of to
 * whatever a CDN is serving today, and a returning user gets it from the HTTP
 * cache with no cross-origin request.
 *
 * The files are committed, so a clean checkout works without running this.
 * Re-run it after bumping @spotify/basic-pitch:
 *
 *     node scripts/sync-model.mjs
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'node_modules', '@spotify', 'basic-pitch');
const to = join(root, 'public', 'models', 'basic-pitch');

mkdirSync(to, { recursive: true });
for (const file of ['model/model.json', 'model/group1-shard1of1.bin']) {
  copyFileSync(join(from, file), join(to, file.replace('model/', '')));
}
copyFileSync(join(from, 'LICENSE'), join(to, 'LICENSE.txt'));

const version = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version;
writeFileSync(
  join(to, 'version.json'),
  `${JSON.stringify({ package: '@spotify/basic-pitch', version, license: 'Apache-2.0' }, null, 2)}\n`,
);
console.log(`synced @spotify/basic-pitch@${version} model to public/models/basic-pitch`);
