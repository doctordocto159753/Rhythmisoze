/**
 * US-0602 - the instrument registry and license ledger.
 *
 * Every sound the product can make is listed here with an explicit licence and
 * provenance. This is the file a release check reads: an instrument that is not
 * in this table cannot be selected, previewed, rendered or exported, so an
 * asset cannot reach a user without first being declared.
 *
 * The full ledger, including the reasoning behind the current sound source, is
 * in `docs/licenses/instruments.md`.
 */

import type { InstrumentDefinition } from './types';

/**
 * The procedural engine synthesises its output from the recipes in `voices.ts`,
 * which are original work in this repository. That makes provenance trivial and
 * is the reason it is the default: no third-party sample is shipped, so there is
 * no licence to get wrong.
 */
const OWN_WORK = {
  spdx: 'MIT',
  source: 'Rhythmisoze procedural voice recipes (src/packages/synthesis/voices.ts)',
} as const;

/** Preview gestures. Short, consistent, and the same shape for every instrument
 *  in a family so the gallery compares timbre rather than composition (US-0604). */
const SUSTAINED_PREVIEW = [
  { pitch: 0, startSec: 0, endSec: 0.42, velocity: 92 },
  { pitch: 4, startSec: 0.36, endSec: 0.78, velocity: 88 },
  { pitch: 7, startSec: 0.72, endSec: 1.45, velocity: 96 },
] as const;

const PLUCKED_PREVIEW = [
  { pitch: 0, startSec: 0, endSec: 0.5, velocity: 96 },
  { pitch: 7, startSec: 0.22, endSec: 0.72, velocity: 84 },
  { pitch: 12, startSec: 0.44, endSec: 1.3, velocity: 100 },
] as const;

const KIT_PREVIEW = [
  { pitch: 36, startSec: 0, endSec: 0.12, velocity: 110 },
  { pitch: 42, startSec: 0.25, endSec: 0.32, velocity: 70 },
  { pitch: 38, startSec: 0.5, endSec: 0.62, velocity: 104 },
  { pitch: 42, startSec: 0.75, endSec: 0.82, velocity: 68 },
  { pitch: 36, startSec: 1, endSec: 1.12, velocity: 108 },
] as const;

export const INSTRUMENTS: readonly InstrumentDefinition[] = Object.freeze([
  {
    id: 'piano',
    name: { en: 'Piano', fa: 'پیانو' },
    family: 'keys',
    mode: 'melody',
    gmProgram: 0,
    range: { low: 28, high: 96 },
    previewPattern: PLUCKED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 60 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'electric-piano',
    name: { en: 'Electric piano', fa: 'پیانوی الکتریک' },
    family: 'keys',
    mode: 'melody',
    gmProgram: 4,
    range: { low: 28, high: 96 },
    previewPattern: PLUCKED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 60 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'acoustic-guitar',
    name: { en: 'Acoustic guitar', fa: 'گیتار آکوستیک' },
    family: 'strings',
    mode: 'melody',
    gmProgram: 24,
    range: { low: 40, high: 84 },
    previewPattern: PLUCKED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 55 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'double-bass',
    name: { en: 'Bowed double bass', fa: 'کنترباس آرشه‌ای' },
    family: 'strings',
    mode: 'melody',
    gmProgram: 43,
    range: { low: 28, high: 62 },
    previewPattern: SUSTAINED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 40 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'strings',
    name: { en: 'String section', fa: 'گروه زهی' },
    family: 'strings',
    mode: 'melody',
    gmProgram: 48,
    range: { low: 36, high: 88 },
    previewPattern: SUSTAINED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 60 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'trumpet',
    name: { en: 'Trumpet', fa: 'ترومپت' },
    family: 'winds',
    mode: 'melody',
    gmProgram: 56,
    range: { low: 52, high: 84 },
    previewPattern: SUSTAINED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 64 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'saxophone',
    name: { en: 'Saxophone', fa: 'ساکسیفون' },
    family: 'reeds',
    mode: 'melody',
    gmProgram: 65,
    range: { low: 44, high: 80 },
    previewPattern: SUSTAINED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 58 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'harmonica',
    name: { en: 'Harmonica', fa: 'سازدهنی' },
    family: 'reeds',
    mode: 'melody',
    gmProgram: 22,
    range: { low: 48, high: 88 },
    previewPattern: SUSTAINED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 62 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'flute',
    name: { en: 'Flute', fa: 'فلوت' },
    family: 'winds',
    mode: 'melody',
    gmProgram: 73,
    range: { low: 59, high: 96 },
    previewPattern: SUSTAINED_PREVIEW.map((n) => ({ ...n, pitch: n.pitch + 72 })),
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'marching-drum',
    name: { en: 'Marching drum', fa: 'طبل رژه' },
    family: 'percussion',
    mode: 'rhythm',
    gmProgram: 0,
    range: { low: 35, high: 46 },
    previewPattern: KIT_PREVIEW,
    license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'trap-kit',
    name: { en: 'Trap kit', fa: 'کیت ترپ' },
    family: 'percussion',
    mode: 'rhythm',
    gmProgram: 0,
    range: { low: 35, high: 46 },
    previewPattern: KIT_PREVIEW,
    license: OWN_WORK,
    samplePack: null,
  },
]);

const BY_ID = new Map(INSTRUMENTS.map((instrument) => [instrument.id, instrument]));

export const DEFAULT_MELODY_INSTRUMENT = 'piano';
export const DEFAULT_RHYTHM_INSTRUMENT = 'trap-kit';

export function getInstrument(id: string): InstrumentDefinition | undefined {
  return BY_ID.get(id);
}

/**
 * Resolves an id to a definition, falling back to the mode's default.
 * Used everywhere a stored sketch might reference an instrument that has since
 * been removed - a rename should degrade to a different sound, not a crash.
 */
export function resolveInstrument(
  id: string | undefined,
  mode: 'melody' | 'rhythm',
): InstrumentDefinition {
  const found = id ? BY_ID.get(id) : undefined;
  if (found && found.mode === mode) return found;
  const fallback = mode === 'rhythm' ? DEFAULT_RHYTHM_INSTRUMENT : DEFAULT_MELODY_INSTRUMENT;
  return BY_ID.get(fallback) as InstrumentDefinition;
}

export function instrumentsForMode(mode: 'melody' | 'rhythm'): InstrumentDefinition[] {
  return INSTRUMENTS.filter((instrument) => instrument.mode === mode);
}

/**
 * Release check backing US-0602's "CI or review checklist catches unregistered
 * assets". Asserted by `tests/unit/instrument-registry.test.ts`.
 */
export function auditRegistry(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const instrument of INSTRUMENTS) {
    if (seen.has(instrument.id)) problems.push(`duplicate id: ${instrument.id}`);
    seen.add(instrument.id);
    if (!instrument.license.spdx) problems.push(`${instrument.id}: missing licence`);
    if (!instrument.license.source) problems.push(`${instrument.id}: missing provenance`);
    if (instrument.range.low >= instrument.range.high) problems.push(`${instrument.id}: bad range`);
    if (instrument.previewPattern.length === 0) problems.push(`${instrument.id}: no preview`);
    if (instrument.samplePack !== null && instrument.samplePackBytes === undefined) {
      problems.push(`${instrument.id}: sample pack without a declared size`);
    }
  }

  if (instrumentsForMode('melody').length < 8) {
    problems.push('fewer than eight melody instruments (PRD S-01)');
  }
  if (instrumentsForMode('rhythm').length < 1) problems.push('no rhythm kit registered');

  return { ok: problems.length === 0, problems };
}
