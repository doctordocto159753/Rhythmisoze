/**
 * Downloads the pinned, redistributable samples used by the realistic
 * instrument pack and writes deterministic manifests for the browser sampler.
 *
 * Runtime code never contacts these upstreams. This script is a maintainer
 * tool; the resulting assets live under public/instruments and are served from
 * the same origin as the application.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const OUTPUT_ROOT = resolve(process.cwd(), 'public', 'instruments');
const FLUID_COMMIT = '044fab8e1456bfafc5776e86dfd6bb8697149aef';
const VSCO_COMMIT = '440300901dfe9275fd84e0b7763af1f8443ae62e';

const FLUID_LICENSE = {
  spdx: 'CC-BY-3.0',
  source: 'FluidR3_GM by Frank Wen, pre-rendered by midi-js-soundfonts',
  url: 'https://github.com/gleitz/midi-js-soundfonts/tree/gh-pages/FluidR3_GM',
  attribution: 'FluidR3_GM by Frank Wen; browser files prepared by Benjamin Gleitzman.',
  attributionRequired: true,
  redistribution: true,
};

const VSCO_LICENSE = {
  spdx: 'CC0-1.0',
  source: 'VSCO 2 Community Edition by Versilian Studios',
  url: 'https://github.com/sgossner/VSCO-2-CE',
  attribution: 'Recorded by Sam Gossner and Simon Dalzell; sample cutting by Elan Hickler.',
  attributionRequired: false,
  redistribution: true,
};

const FLUID_PACKS = [
  {
    id: 'warm-grand',
    name: 'Warm Grand',
    sourceDir: 'acoustic_grand_piano-mp3',
    lowMidi: 28,
    highMidi: 96,
    playback: { mode: 'natural', releaseSec: 0.45, tailSec: 3.25 },
  },
  {
    id: 'cedar-steel',
    name: 'Cedar Steel',
    sourceDir: 'acoustic_guitar_steel-mp3',
    lowMidi: 40,
    highMidi: 84,
    playback: { mode: 'natural', releaseSec: 0.28, tailSec: 3.25 },
  },
  {
    id: 'tender-violin',
    name: 'Tender Violin',
    sourceDir: 'violin-mp3',
    lowMidi: 55,
    highMidi: 96,
    playback: { mode: 'gated', releaseSec: 0.24, tailSec: 0.24 },
  },
  {
    id: 'deep-cello',
    name: 'Deep Cello',
    sourceDir: 'cello-mp3',
    lowMidi: 36,
    highMidi: 72,
    playback: { mode: 'gated', releaseSec: 0.3, tailSec: 0.3 },
  },
  {
    id: 'midnight-trumpet',
    name: 'Midnight Trumpet',
    sourceDir: 'trumpet-mp3',
    lowMidi: 52,
    highMidi: 84,
    playback: { mode: 'gated', releaseSec: 0.18, tailSec: 0.18 },
  },
];

const DRUM_SAMPLES = [
  {
    output: 'kick-soft.wav',
    source: 'VSCO 1 Percussion/drums/bass/bdrum_mp_1.wav',
    drum: 'kick',
    minVelocity: 1,
    maxVelocity: 80,
  },
  {
    output: 'kick-hard.wav',
    source: 'VSCO 1 Percussion/drums/bass/bdrum_ff_1.wav',
    drum: 'kick',
    minVelocity: 81,
    maxVelocity: 127,
  },
  {
    output: 'snare-soft.wav',
    source: 'VSCO 1 Percussion/drums/snare/drum1/snare1_mp_1.wav',
    drum: 'snare',
    minVelocity: 1,
    maxVelocity: 80,
  },
  {
    output: 'snare-hard.wav',
    source: 'VSCO 1 Percussion/drums/snare/drum1/snare1_ff_1.wav',
    drum: 'snare',
    minVelocity: 81,
    maxVelocity: 127,
  },
  {
    output: 'hat-1.wav',
    source: "VSCO 1 Percussion/varWood/Camo's Shaker/shake1.wav",
    drum: 'hat',
    minVelocity: 1,
    maxVelocity: 127,
    roundRobin: 1,
  },
  {
    output: 'hat-2.wav',
    source: "VSCO 1 Percussion/varWood/Camo's Shaker/shake6.wav",
    drum: 'hat',
    minVelocity: 1,
    maxVelocity: 127,
    roundRobin: 2,
  },
];

function midiName(midi) {
  // midi-js-soundfonts names chromatic files with flats (Db, Eb, Gb, Ab, Bb).
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function download(url, destination) {
  await mkdir(resolve(destination, '..'), { recursive: true });
  try {
    const existing = await stat(destination);
    if (existing.size > 0) return existing.size;
  } catch {
    // Missing files are downloaded below.
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  return bytes.length;
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function writeManifest(packDir, manifest) {
  const path = resolve(packDir, 'manifest.json');
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function syncFluidPack(pack) {
  const packDir = resolve(OUTPUT_ROOT, pack.id);
  const pitches = Array.from(
    { length: pack.highMidi - pack.lowMidi + 1 },
    (_, index) => pack.lowMidi + index,
  );

  const zones = await mapLimit(pitches, 10, async (pitch) => {
    const note = midiName(pitch);
    const file = `samples/${note}.mp3`;
    const destination = resolve(packDir, file);
    const source = `https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${FLUID_COMMIT}/FluidR3_GM/${pack.sourceDir}/${encodeURIComponent(note)}.mp3`;
    const bytes = await download(source, destination);
    return {
      file,
      rootMidi: pitch,
      lowMidi: pitch,
      highMidi: pitch,
      minVelocity: 1,
      maxVelocity: 127,
      bytes,
      sha256: await sha256(destination),
    };
  });

  await writeManifest(packDir, {
    version: 2,
    id: pack.id,
    name: pack.name,
    type: 'sample',
    license: FLUID_LICENSE,
    playback: pack.playback,
    samples: Object.fromEntries(zones.map((zone) => [midiName(zone.rootMidi), zone.file])),
    zones,
  });
  return zones.reduce((total, zone) => total + zone.bytes, 0);
}

async function syncDrumPack() {
  const id = 'live-room-kit';
  const packDir = resolve(OUTPUT_ROOT, id);
  const zones = await mapLimit(DRUM_SAMPLES, 6, async (sample) => {
    const file = `samples/${sample.output}`;
    const destination = resolve(packDir, file);
    const source = `https://raw.githubusercontent.com/sgossner/VSCO-2-CE/${VSCO_COMMIT}/${encodePath(sample.source)}`;
    const bytes = await download(source, destination);
    return {
      file,
      rootMidi: sample.drum === 'kick' ? 36 : sample.drum === 'snare' ? 38 : 42,
      lowMidi: sample.drum === 'kick' ? 35 : sample.drum === 'snare' ? 38 : 42,
      highMidi: sample.drum === 'kick' ? 36 : sample.drum === 'snare' ? 40 : 46,
      drum: sample.drum,
      minVelocity: sample.minVelocity,
      maxVelocity: sample.maxVelocity,
      roundRobin: sample.roundRobin,
      bytes,
      sha256: await sha256(destination),
    };
  });

  await writeManifest(packDir, {
    version: 2,
    id,
    name: 'Live Room Kit',
    type: 'sample',
    license: VSCO_LICENSE,
    playback: { mode: 'natural', releaseSec: 0.18, tailSec: 7 },
    samples: Object.fromEntries(DRUM_SAMPLES.map((sample) => [sample.output, `samples/${sample.output}`])),
    zones,
  });
  return zones.reduce((total, zone) => total + zone.bytes, 0);
}

await mkdir(OUTPUT_ROOT, { recursive: true });
const report = {};
for (const pack of FLUID_PACKS) report[pack.id] = await syncFluidPack(pack);
report['live-room-kit'] = await syncDrumPack();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
