/**
 * Product catalogue and licence gate. Stable ids are deliberately separate
 * from feeling-first names so saved sketches survive presentation changes.
 */
import type { InstrumentDefinition, InstrumentLicense } from './types';

const OWN_WORK: InstrumentLicense = {
  spdx: 'MIT', source: 'Rhythmisoze procedural voice recipes (src/packages/synthesis/voices.ts)',
  attributionRequired: false, redistribution: true,
};
const FLUID_R3: InstrumentLicense = {
  spdx: 'CC-BY-3.0',
  source: 'FluidR3_GM by Frank Wen, pre-rendered by midi-js-soundfonts',
  url: 'https://github.com/gleitz/midi-js-soundfonts/tree/gh-pages/FluidR3_GM',
  attribution: 'FluidR3_GM by Frank Wen; browser files prepared by Benjamin Gleitzman.',
  attributionRequired: true, redistribution: true,
};
const VSCO_CE: InstrumentLicense = {
  spdx: 'CC0-1.0', source: 'VSCO 2 Community Edition by Versilian Studios',
  url: 'https://github.com/sgossner/VSCO-2-CE',
  attribution: 'Recorded by Sam Gossner and Simon Dalzell; sample cutting by Elan Hickler.',
  attributionRequired: false, redistribution: true,
};

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
    id: 'piano', name: { en: 'Warm Grand', fa: 'پیانوی گرند گرم' },
    category: 'melodic', type: 'sample', family: 'keys', mode: 'melody', gmProgram: 0,
    range: { low: 28, high: 96 },
    previewPattern: PLUCKED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 60 })),
    mood: { en: ['intimate', 'warm', 'dreamy'], fa: ['صمیمی', 'گرم', 'رویایی'] },
    bestFor: { en: ['humming', 'slow melody'], fa: ['زمزمه', 'ملودی آرام'] },
    visualProfile: [1, 0.78, 0.55, 0.38, 0.24, 0.16, 0.1, 0.06], license: FLUID_R3,
    samplePack: 'warm-grand/manifest.json', samplePackBytes: 1_616_229, renderTailSec: 3.25,
  },
  {
    id: 'electric-piano', name: { en: 'Soft Electric', fa: 'الکتریک نرم' },
    category: 'melodic', type: 'synth', family: 'keys', mode: 'melody', gmProgram: 4,
    range: { low: 28, high: 96 },
    previewPattern: PLUCKED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 60 })),
    mood: { en: ['soft', 'glowing'], fa: ['نرم', 'درخشان'] },
    bestFor: { en: ['late-night ideas'], fa: ['ایده‌های شبانه'] },
    visualProfile: [1, 0.42, 0.7, 0.26, 0.38, 0.14, 0.2, 0.08], license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'acoustic-guitar', name: { en: 'Cedar Steel', fa: 'گیتار سدر و استیل' },
    category: 'melodic', type: 'sample', family: 'strings', mode: 'melody', gmProgram: 25,
    range: { low: 40, high: 84 },
    previewPattern: PLUCKED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 55 })),
    mood: { en: ['earthy', 'open', 'gentle'], fa: ['خاکی', 'باز', 'ملایم'] },
    bestFor: { en: ['song ideas', 'plucked phrases'], fa: ['ایده ترانه', 'جمله‌های زخمه‌ای'] },
    visualProfile: [1, 0.64, 0.4, 0.31, 0.2, 0.15, 0.08, 0.04], license: FLUID_R3,
    samplePack: 'cedar-steel/manifest.json', samplePackBytes: 815_275, renderTailSec: 3.25,
  },
  {
    id: 'double-bass', name: { en: 'Wooden Bass', fa: 'باس چوبی' },
    category: 'melodic', type: 'synth', family: 'strings', mode: 'melody', gmProgram: 43,
    range: { low: 28, high: 62 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 40 })),
    mood: { en: ['grounded', 'dark'], fa: ['استوار', 'تیره'] },
    bestFor: { en: ['low humming'], fa: ['زمزمه بم'] },
    visualProfile: [1, 0.72, 0.36, 0.24, 0.12, 0.07, 0.04, 0.02], license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'strings', name: { en: 'Warm Strings', fa: 'زهی‌های گرم' },
    category: 'melodic', type: 'synth', family: 'strings', mode: 'melody', gmProgram: 48,
    range: { low: 36, high: 88 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 60 })),
    mood: { en: ['wide', 'warm'], fa: ['گسترده', 'گرم'] },
    bestFor: { en: ['layered melodies'], fa: ['ملودی‌های چندلایه'] },
    visualProfile: [1, 0.68, 0.48, 0.34, 0.24, 0.16, 0.11, 0.07], license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'violin', name: { en: 'Tender Violin', fa: 'ویولن لطیف' },
    category: 'melodic', type: 'sample', family: 'strings', mode: 'melody', gmProgram: 40,
    range: { low: 55, high: 96 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 67 })),
    mood: { en: ['tender', 'luminous', 'longing'], fa: ['لطیف', 'روشن', 'حسرت‌آلود'] },
    bestFor: { en: ['lyrical humming', 'emotional arcs'], fa: ['زمزمه آوازی', 'اوج احساسی'] },
    visualProfile: [0.92, 1, 0.73, 0.58, 0.4, 0.27, 0.18, 0.12], license: FLUID_R3,
    samplePack: 'tender-violin/manifest.json', samplePackBytes: 1_061_986, renderTailSec: 0.24,
  },
  {
    id: 'cello', name: { en: 'Deep Cello', fa: 'ویلنسل عمیق' },
    category: 'melodic', type: 'sample', family: 'strings', mode: 'melody', gmProgram: 42,
    range: { low: 36, high: 72 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 48 })),
    mood: { en: ['deep', 'human', 'cinematic'], fa: ['عمیق', 'انسانی', 'سینمایی'] },
    bestFor: { en: ['low melodies', 'reflective lines'], fa: ['ملودی بم', 'جمله‌های تأملی'] },
    visualProfile: [1, 0.8, 0.51, 0.37, 0.25, 0.15, 0.09, 0.05], license: FLUID_R3,
    samplePack: 'deep-cello/manifest.json', samplePackBytes: 946_645, renderTailSec: 0.3,
  },
  {
    id: 'trumpet', name: { en: 'Midnight Trumpet', fa: 'ترومپت نیمه‌شب' },
    category: 'melodic', type: 'sample', family: 'winds', mode: 'melody', gmProgram: 56,
    range: { low: 52, high: 84 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 64 })),
    mood: { en: ['bold', 'smoky', 'midnight'], fa: ['جسور', 'دودآلود', 'شبانه'] },
    bestFor: { en: ['clear hooks', 'held notes'], fa: ['هوک روشن', 'نت‌های کشیده'] },
    visualProfile: [1, 0.86, 0.68, 0.52, 0.4, 0.28, 0.18, 0.12], license: FLUID_R3,
    samplePack: 'midnight-trumpet/manifest.json', samplePackBytes: 833_515, renderTailSec: 0.18,
  },
  {
    id: 'saxophone', name: { en: 'Velvet Sax', fa: 'ساکس مخملی' },
    category: 'melodic', type: 'synth', family: 'reeds', mode: 'melody', gmProgram: 65,
    range: { low: 44, high: 80 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 58 })),
    mood: { en: ['velvet', 'late'], fa: ['مخملی', 'دیرهنگام'] },
    bestFor: { en: ['loose phrases'], fa: ['جمله‌های آزاد'] },
    visualProfile: [1, 0.34, 0.72, 0.22, 0.48, 0.16, 0.3, 0.1], license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'harmonica', name: { en: 'Pocket Air', fa: 'هوای جیبی' },
    category: 'melodic', type: 'synth', family: 'reeds', mode: 'melody', gmProgram: 22,
    range: { low: 48, high: 88 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 62 })),
    mood: { en: ['plainspoken', 'wandering'], fa: ['ساده', 'پرسه‌زن'] },
    bestFor: { en: ['folk-like ideas'], fa: ['ایده‌های فولک'] },
    visualProfile: [1, 0.55, 0.62, 0.3, 0.36, 0.18, 0.14, 0.06], license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'flute', name: { en: 'Clear Air', fa: 'هوای زلال' },
    category: 'melodic', type: 'synth', family: 'winds', mode: 'melody', gmProgram: 73,
    range: { low: 59, high: 96 },
    previewPattern: SUSTAINED_PREVIEW.map((note) => ({ ...note, pitch: note.pitch + 72 })),
    mood: { en: ['clear', 'weightless'], fa: ['زلال', 'بی‌وزن'] },
    bestFor: { en: ['high gentle lines'], fa: ['جمله‌های زیر و آرام'] },
    visualProfile: [1, 0.12, 0.06, 0.03, 0.02, 0.01, 0.006, 0.003], license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'acoustic-kit', name: { en: 'Live Room Kit', fa: 'کیت اتاق زنده' },
    category: 'percussion', type: 'sample', family: 'percussion', mode: 'rhythm', gmProgram: 0,
    range: { low: 35, high: 46 }, previewPattern: KIT_PREVIEW,
    mood: { en: ['live', 'grounded', 'organic'], fa: ['زنده', 'استوار', 'طبیعی'] },
    bestFor: { en: ['beatboxing', 'gentle grooves'], fa: ['بیت‌باکس', 'گروو ملایم'] },
    visualProfile: [1, 0.38, 0.82, 0.25, 0.63, 0.18, 0.42, 0.12], license: VSCO_CE,
    samplePack: 'live-room-kit/manifest.json', samplePackBytes: 3_860_656, renderTailSec: 7,
  },
  {
    id: 'marching-drum', name: { en: 'Parade Skin', fa: 'پوست رژه' },
    category: 'percussion', type: 'synth', family: 'percussion', mode: 'rhythm', gmProgram: 0,
    range: { low: 35, high: 46 }, previewPattern: KIT_PREVIEW,
    mood: { en: ['tight', 'forward'], fa: ['منسجم', 'پیش‌رونده'] },
    bestFor: { en: ['marching patterns'], fa: ['الگوی رژه'] },
    visualProfile: [0.86, 0.52, 0.78, 0.38, 0.62, 0.27, 0.4, 0.16], license: OWN_WORK,
    samplePack: null,
  },
  {
    id: 'trap-kit', name: { en: 'Deep Pocket', fa: 'ضرب عمیق' },
    category: 'percussion', type: 'synth', family: 'percussion', mode: 'rhythm', gmProgram: 0,
    range: { low: 35, high: 46 }, previewPattern: KIT_PREVIEW,
    mood: { en: ['deep', 'crisp'], fa: ['عمیق', 'شفاف'] },
    bestFor: { en: ['sharp beat ideas'], fa: ['ایده‌های ضربی تیز'] },
    visualProfile: [1, 0.26, 0.74, 0.2, 0.88, 0.12, 0.56, 0.08], license: OWN_WORK,
    samplePack: null,
  },
]);

const BY_ID = new Map(INSTRUMENTS.map((instrument) => [instrument.id, instrument]));
export const DEFAULT_MELODY_INSTRUMENT = 'piano';
export const DEFAULT_RHYTHM_INSTRUMENT = 'acoustic-kit';

export function getInstrument(id: string): InstrumentDefinition | undefined { return BY_ID.get(id); }
export function resolveInstrument(id: string | undefined, mode: 'melody' | 'rhythm'): InstrumentDefinition {
  const found = id ? BY_ID.get(id) : undefined;
  if (found && found.mode === mode) return found;
  const fallback = mode === 'rhythm' ? DEFAULT_RHYTHM_INSTRUMENT : DEFAULT_MELODY_INSTRUMENT;
  return BY_ID.get(fallback) as InstrumentDefinition;
}
export function instrumentsForMode(mode: 'melody' | 'rhythm'): InstrumentDefinition[] {
  return INSTRUMENTS.filter((instrument) => instrument.mode === mode);
}

export function auditRegistry(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const instrument of INSTRUMENTS) {
    if (seen.has(instrument.id)) problems.push(`duplicate id: ${instrument.id}`);
    seen.add(instrument.id);
    if (!instrument.license.spdx) problems.push(`${instrument.id}: missing licence`);
    if (!instrument.license.source) problems.push(`${instrument.id}: missing provenance`);
    if (!instrument.license.redistribution) problems.push(`${instrument.id}: redistribution denied`);
    if (instrument.range.low >= instrument.range.high) problems.push(`${instrument.id}: bad range`);
    if (instrument.previewPattern.length === 0) problems.push(`${instrument.id}: no preview`);
    if (instrument.category !== (instrument.mode === 'melody' ? 'melodic' : 'percussion')) {
      problems.push(`${instrument.id}: category does not match mode`);
    }
    for (const locale of ['en', 'fa'] as const) {
      if (instrument.mood[locale].length === 0) problems.push(`${instrument.id}: missing ${locale} mood`);
      if (instrument.bestFor[locale].length === 0) problems.push(`${instrument.id}: missing ${locale} bestFor`);
    }
    if (instrument.visualProfile.length < 4 || instrument.visualProfile.some((value) => value < 0 || value > 1)) {
      problems.push(`${instrument.id}: invalid visual profile`);
    }
    if (instrument.type === 'sample') {
      if (instrument.samplePack === null) problems.push(`${instrument.id}: sample type without a pack`);
      if (!instrument.samplePackBytes || instrument.samplePackBytes <= 0) problems.push(`${instrument.id}: pack size missing`);
      if (!instrument.license.url) problems.push(`${instrument.id}: source URL missing`);
    } else if (instrument.samplePack !== null) {
      problems.push(`${instrument.id}: synth type unexpectedly declares a pack`);
    }
  }
  if (instrumentsForMode('melody').length < 8) problems.push('fewer than eight melody instruments (PRD S-01)');
  if (instrumentsForMode('rhythm').length < 1) problems.push('no rhythm kit registered');
  if (INSTRUMENTS.filter((instrument) => instrument.type === 'sample').length < 6) {
    problems.push('fewer than six realistic sample instruments (US-INST-005)');
  }
  return { ok: problems.length === 0, problems };
}
