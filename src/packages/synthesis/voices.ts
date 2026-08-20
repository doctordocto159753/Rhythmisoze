/**
 * Voice specifications for the procedural engine.
 *
 * Each instrument is a small additive/subtractive recipe: a harmonic series, an
 * amplitude envelope, an optional filter sweep, an optional noise component for
 * breath or pluck, and an optional vibrato. Nothing exotic - the goal is a
 * timbre a listener names correctly within a second, not a convincing forgery.
 *
 * The numbers come from the physical behaviour each family is known for:
 *  - plucked and struck strings: strong odd and even partials, instant attack,
 *    long decay, no sustain;
 *  - bowed strings: slow attack, full sustain, a filter that opens with bow
 *    pressure;
 *  - brass: bright, partial-rich, a fast filter sweep on the attack;
 *  - reeds: strong odd harmonics, breath noise, gentle vibrato;
 *  - flutes: nearly a sine with a strong breath component.
 *
 * These are the values a future ADR would replace wholesale with sample packs.
 * They live in one table so that swap is a deletion, not an excavation.
 */

export interface Envelope {
  attackSec: number;
  decaySec: number;
  /** 0..1 level held while the note is on. */
  sustain: number;
  releaseSec: number;
}

export interface FilterSpec {
  type: BiquadFilterType;
  /** Cutoff at the attack, in Hz. */
  startHz: number;
  /** Cutoff after the filter envelope settles. */
  endHz: number;
  /** How long the cutoff takes to travel. */
  sweepSec: number;
  q: number;
  /** Cutoff also tracks pitch by this fraction, 0..1. */
  keyTracking: number;
}

export interface NoiseSpec {
  /** Level relative to the tonal part, 0..1. */
  amount: number;
  /** Bandpass centre for the noise component. */
  centreHz: number;
  q: number;
  /** `true` keeps the noise for the whole note (breath), `false` is a transient. */
  sustained: boolean;
  decaySec: number;
}

export interface VibratoSpec {
  rateHz: number;
  depthCents: number;
  /** Vibrato only starts after the note has been held this long. */
  onsetSec: number;
}

export interface VoiceSpec {
  /** Relative amplitude of harmonic 1, 2, 3... Normalised at build time. */
  partials: readonly number[];
  envelope: Envelope;
  filter?: FilterSpec;
  noise?: NoiseSpec;
  vibrato?: VibratoSpec;
  /** Cents of detune between two stacked copies. 0 disables the second copy. */
  unisonDetuneCents: number;
  /** Output level before the master bus, 0..1. */
  gain: number;
}

export const VOICE_SPECS: Readonly<Record<string, VoiceSpec>> = Object.freeze({
  piano: {
    partials: [1, 0.62, 0.34, 0.22, 0.13, 0.08, 0.05, 0.03],
    envelope: { attackSec: 0.002, decaySec: 1.6, sustain: 0.16, releaseSec: 0.5 },
    filter: { type: 'lowpass', startHz: 7200, endHz: 1900, sweepSec: 0.9, q: 0.7, keyTracking: 0.6 },
    unisonDetuneCents: 3,
    gain: 0.72,
  },
  'electric-piano': {
    // A bell-like partial at 4x is what makes an electric piano read as one.
    partials: [1, 0.18, 0.06, 0.44, 0.05, 0.02],
    envelope: { attackSec: 0.004, decaySec: 1.1, sustain: 0.22, releaseSec: 0.45 },
    filter: { type: 'lowpass', startHz: 5200, endHz: 1500, sweepSec: 0.7, q: 0.6, keyTracking: 0.5 },
    vibrato: { rateHz: 4.6, depthCents: 6, onsetSec: 0.25 },
    unisonDetuneCents: 0,
    gain: 0.7,
  },
  'acoustic-guitar': {
    partials: [1, 0.55, 0.42, 0.2, 0.16, 0.09, 0.06],
    envelope: { attackSec: 0.003, decaySec: 1.2, sustain: 0.1, releaseSec: 0.35 },
    filter: { type: 'lowpass', startHz: 6000, endHz: 1600, sweepSec: 0.5, q: 0.9, keyTracking: 0.7 },
    noise: { amount: 0.22, centreHz: 2600, q: 1.2, sustained: false, decaySec: 0.05 },
    unisonDetuneCents: 6,
    gain: 0.68,
  },
  'double-bass': {
    partials: [1, 0.72, 0.36, 0.24, 0.12, 0.07],
    envelope: { attackSec: 0.09, decaySec: 0.25, sustain: 0.78, releaseSec: 0.3 },
    filter: { type: 'lowpass', startHz: 700, endHz: 1500, sweepSec: 0.2, q: 1.1, keyTracking: 0.4 },
    noise: { amount: 0.13, centreHz: 1800, q: 0.9, sustained: true, decaySec: 0.2 },
    vibrato: { rateHz: 4.2, depthCents: 14, onsetSec: 0.3 },
    unisonDetuneCents: 4,
    gain: 0.75,
  },
  trumpet: {
    partials: [1, 0.86, 0.68, 0.52, 0.4, 0.28, 0.18, 0.12, 0.07],
    envelope: { attackSec: 0.045, decaySec: 0.12, sustain: 0.85, releaseSec: 0.14 },
    filter: { type: 'lowpass', startHz: 1200, endHz: 5200, sweepSec: 0.09, q: 1.6, keyTracking: 0.5 },
    vibrato: { rateHz: 5.4, depthCents: 11, onsetSec: 0.22 },
    unisonDetuneCents: 0,
    gain: 0.6,
  },
  saxophone: {
    // Odd harmonics dominate: the reed behaves close to a cylinder stopped at one end.
    partials: [1, 0.34, 0.72, 0.22, 0.48, 0.16, 0.3, 0.1],
    envelope: { attackSec: 0.05, decaySec: 0.15, sustain: 0.82, releaseSec: 0.18 },
    filter: { type: 'lowpass', startHz: 1500, endHz: 3600, sweepSec: 0.12, q: 1.3, keyTracking: 0.55 },
    noise: { amount: 0.16, centreHz: 3200, q: 0.8, sustained: true, decaySec: 0.3 },
    vibrato: { rateHz: 5, depthCents: 16, onsetSec: 0.25 },
    unisonDetuneCents: 0,
    gain: 0.62,
  },
  harmonica: {
    partials: [1, 0.55, 0.62, 0.3, 0.36, 0.18, 0.14],
    envelope: { attackSec: 0.035, decaySec: 0.1, sustain: 0.86, releaseSec: 0.12 },
    filter: { type: 'bandpass', startHz: 1400, endHz: 2200, sweepSec: 0.15, q: 1.1, keyTracking: 0.8 },
    noise: { amount: 0.2, centreHz: 2400, q: 0.7, sustained: true, decaySec: 0.25 },
    vibrato: { rateHz: 6.1, depthCents: 13, onsetSec: 0.18 },
    unisonDetuneCents: 8,
    gain: 0.58,
  },
  flute: {
    partials: [1, 0.12, 0.06, 0.03],
    envelope: { attackSec: 0.07, decaySec: 0.1, sustain: 0.9, releaseSec: 0.18 },
    filter: { type: 'lowpass', startHz: 2200, endHz: 4200, sweepSec: 0.15, q: 0.6, keyTracking: 0.9 },
    noise: { amount: 0.3, centreHz: 4200, q: 0.6, sustained: true, decaySec: 0.4 },
    vibrato: { rateHz: 5.2, depthCents: 9, onsetSec: 0.3 },
    unisonDetuneCents: 0,
    gain: 0.55,
  },
  violin: {
    partials: [0.92, 1, 0.73, 0.58, 0.4, 0.27, 0.18, 0.12],
    envelope: { attackSec: 0.08, decaySec: 0.14, sustain: 0.86, releaseSec: 0.24 },
    filter: { type: 'lowpass', startHz: 1500, endHz: 4300, sweepSec: 0.18, q: 1, keyTracking: 0.65 },
    noise: { amount: 0.11, centreHz: 3600, q: 0.9, sustained: true, decaySec: 0.25 },
    vibrato: { rateHz: 5.1, depthCents: 15, onsetSec: 0.22 },
    unisonDetuneCents: 0,
    gain: 0.58,
  },
  cello: {
    partials: [1, 0.8, 0.51, 0.37, 0.25, 0.15, 0.09, 0.05],
    envelope: { attackSec: 0.1, decaySec: 0.18, sustain: 0.82, releaseSec: 0.3 },
    filter: { type: 'lowpass', startHz: 850, endHz: 2600, sweepSec: 0.22, q: 1, keyTracking: 0.52 },
    noise: { amount: 0.12, centreHz: 2300, q: 0.9, sustained: true, decaySec: 0.28 },
    vibrato: { rateHz: 4.6, depthCents: 14, onsetSec: 0.26 },
    unisonDetuneCents: 0,
    gain: 0.68,
  },
  strings: {
    partials: [1, 0.68, 0.48, 0.34, 0.24, 0.16, 0.11, 0.07],
    envelope: { attackSec: 0.14, decaySec: 0.2, sustain: 0.85, releaseSec: 0.5 },
    filter: { type: 'lowpass', startHz: 900, endHz: 2600, sweepSec: 0.3, q: 0.8, keyTracking: 0.5 },
    vibrato: { rateHz: 4.8, depthCents: 12, onsetSec: 0.35 },
    // A wide detune is what turns one bowed voice into a section.
    unisonDetuneCents: 11,
    gain: 0.6,
  },
});

export interface DrumVoiceSpec {
  /** Pitch sweep for the tonal body, in Hz. */
  toneStartHz: number;
  toneEndHz: number;
  toneSweepSec: number;
  toneLevel: number;
  toneDecaySec: number;
  /** Noise component. */
  noiseLevel: number;
  noiseType: BiquadFilterType;
  noiseHz: number;
  noiseQ: number;
  noiseDecaySec: number;
  gain: number;
}

/**
 * Drum voices, one set per kit. The two kits differ in character rather than in
 * mapping, so a user switching between them hears the same performance played
 * on a different kit - which is the whole promise of the instrument gallery.
 */
export const DRUM_SPECS: Readonly<Record<string, Record<'kick' | 'snare' | 'hat', DrumVoiceSpec>>> =
  Object.freeze({
    'acoustic-kit': {
      kick: {
        toneStartHz: 135, toneEndHz: 52, toneSweepSec: 0.08, toneLevel: 0.88, toneDecaySec: 0.34,
        noiseLevel: 0.16, noiseType: 'lowpass', noiseHz: 780, noiseQ: 0.7, noiseDecaySec: 0.045,
        gain: 0.82,
      },
      snare: {
        toneStartHz: 230, toneEndHz: 176, toneSweepSec: 0.028, toneLevel: 0.36, toneDecaySec: 0.11,
        noiseLevel: 0.82, noiseType: 'bandpass', noiseHz: 2100, noiseQ: 0.85, noiseDecaySec: 0.16,
        gain: 0.76,
      },
      hat: {
        toneStartHz: 0, toneEndHz: 0, toneSweepSec: 0, toneLevel: 0, toneDecaySec: 0,
        noiseLevel: 0.64, noiseType: 'highpass', noiseHz: 6800, noiseQ: 0.65, noiseDecaySec: 0.045,
        gain: 0.42,
      },
    },
    'marching-drum': {
      kick: {
        toneStartHz: 150, toneEndHz: 58, toneSweepSec: 0.07, toneLevel: 0.9, toneDecaySec: 0.32,
        noiseLevel: 0.18, noiseType: 'lowpass', noiseHz: 900, noiseQ: 0.7, noiseDecaySec: 0.05,
        gain: 0.85,
      },
      snare: {
        toneStartHz: 240, toneEndHz: 185, toneSweepSec: 0.03, toneLevel: 0.4, toneDecaySec: 0.12,
        noiseLevel: 0.8, noiseType: 'bandpass', noiseHz: 1900, noiseQ: 0.8, noiseDecaySec: 0.18,
        gain: 0.78,
      },
      hat: {
        toneStartHz: 0, toneEndHz: 0, toneSweepSec: 0, toneLevel: 0, toneDecaySec: 0,
        noiseLevel: 0.7, noiseType: 'highpass', noiseHz: 7000, noiseQ: 0.7, noiseDecaySec: 0.05,
        gain: 0.5,
      },
    },
    'trap-kit': {
      kick: {
        // The long sub-heavy sweep is the defining sound of the style.
        toneStartHz: 190, toneEndHz: 42, toneSweepSec: 0.13, toneLevel: 1, toneDecaySec: 0.55,
        noiseLevel: 0.1, noiseType: 'lowpass', noiseHz: 700, noiseQ: 0.7, noiseDecaySec: 0.03,
        gain: 0.92,
      },
      snare: {
        toneStartHz: 320, toneEndHz: 210, toneSweepSec: 0.02, toneLevel: 0.32, toneDecaySec: 0.09,
        noiseLevel: 0.9, noiseType: 'bandpass', noiseHz: 2600, noiseQ: 1.1, noiseDecaySec: 0.13,
        gain: 0.8,
      },
      hat: {
        toneStartHz: 0, toneEndHz: 0, toneSweepSec: 0, toneLevel: 0, toneDecaySec: 0,
        noiseLevel: 0.75, noiseType: 'highpass', noiseHz: 9000, noiseQ: 0.9, noiseDecaySec: 0.028,
        gain: 0.46,
      },
    },
  });
