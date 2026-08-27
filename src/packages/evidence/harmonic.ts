/**
 * A register witness that reads the spectrum directly.
 *
 * ## Why this exists
 *
 * `arbitrateRegister` will not move a note on one engine's say-so, and it is
 * right not to: a lone witness states "the tracker is wrong" and "this span is
 * genuinely ambiguous" in exactly the same words. So it requires two.
 *
 * In the default configuration there is only one. Basic Pitch runs in the
 * browser; GAME needs a service that is off unless an operator turns it on and
 * whose weights are not this project's licence. The result is that the register
 * arbitration — built to fix the product's oldest measured failure — is inert
 * for most deployments.
 *
 * This is the second witness that needs nothing. It asks the recording itself.
 *
 * ## What it measures
 *
 * For a candidate note at pitch *p*, it compares how well the audio in that
 * span is explained by a harmonic series built on *p* against series built on
 * *p*−12 and *p*+12, weighting each partial by 1/n so the fundamental carries
 * the decision.
 *
 * That weighting is what makes it useful, and it is not symmetric. A voice
 * singing A3 puts energy at 220, 440, 660, 880 Hz. When YIN finds a period
 * twice the true one and reports A2, the hypothesis at A2 has to account for an
 * empty slot at 110 Hz where its fundamental should be, and loses badly — so
 * this witness lifts it. The reverse is much weaker: a real note whose
 * fundamental the microphone rolled off looks, to a sum weighted this way, a
 * little like its own second harmonic, and the witness leans *up* rather than
 * down. Both of the errors it makes on the pinned recordings are that lean.
 *
 * Correcting subharmonic slips is the direction that matters, because that is
 * the failure the corpus actually contains: on the case where the register is
 * worst, twenty-one of thirty-three missing notes were found an octave low
 * rather than not found. Removing the lean by weighting partials equally was
 * measured, and it loses every correction the witness gets right. What contains
 * the lean instead is the decision ratio below, and the fact that the
 * arbitration will not act on this witness alone.
 *
 * The value of all of it is *independence*: this shares no code, no model and
 * no failure mode with YIN's autocorrelation or with a neural transcriber. When
 * it agrees with Basic Pitch, two genuinely different kinds of evidence agree.
 *
 * ## What it deliberately does not do
 *
 * It reports a pitch per note and nothing else. It has no opinion about note
 * boundaries, voicing, or whether a note exists — the contour engine owns those
 * and is measured as the best available at all three. Its `EngineStrengths`
 * entry says so, and the arbitration only consults engines that clear
 * `minRegisterStrength`.
 *
 * It also abstains rather than guessing. A span whose spectrum does not clearly
 * prefer one octave emits no note at all, which is the difference between a
 * witness and a vote.
 *
 * ## One thing that was tried and removed
 *
 * Both of the corrections this witness gets wrong on the pinned recordings are
 * the same shape: it picks the octave above, because a hypothesis at 2f
 * predicts energy at 2f, 4f, 6f — all of which a note at f also produces — so
 * it can never lose on the evidence it predicts, and a weak fundamental is the
 * normal case for a voice through a phone microphone. On one of them the
 * chosen peak had almost nothing above it: 6% at twice its frequency, 0.1% at
 * three times, where every correct choice on the corpus sat between 35% and
 * 77%. Rejecting hypotheses with no overtones looked like the principled fix,
 * and on nine recordings it removed that error at no cost.
 *
 * Then the same measurement was taken over all 386 reference spans, where the
 * true pitch is written down. Median overtone support is 0.86, but the low tail
 * reaches 0.004, and 5% of genuine fundamentals sit below 0.076 — inside the
 * band that would have to reject. There is no separating gap, only a window two
 * hundredths wide that happens to fit this corpus and would silence the witness
 * on one real note in twenty elsewhere. It was removed. The two errors are left
 * standing, because a wrong answer that is understood is better than a right
 * answer that is fitted.
 */

import type { MonoAudio, NoteEvent } from '@contracts';
import { hannWindow, magnitudeSpectrum } from '@/packages/audio-core/fft';
import { resample } from '@/packages/audio-core/normalize';
import { midiToHz } from '@/packages/audio-core/pitch';
import type { EvidenceNote, EvidenceSource } from './types';

/**
 * The rate this witness analyses at, regardless of what the recording arrived
 * at.
 *
 * Fixed rather than inherited so that the same take gives the same answer on a
 * 44.1 kHz laptop and a 48 kHz phone: with a fixed window size, the source rate
 * would otherwise decide the frequency resolution, and with it which octave
 * wins a close call. It also matches the pitch tracker's own analysis rate, so
 * the two witnesses are at least looking at the same band.
 */
const ANALYSIS_RATE = 16000;

export interface HarmonicWitnessOptions {
  /** Analysis window. 4096 at 16 kHz is ~256 ms of audio and 3.9 Hz per bin —
   *  fine enough to separate a low fundamental from its octave. */
  frameSize: number;
  /** Partials summed per hypothesis. Beyond the sixth a voice has little left. */
  partials: number;
  /**
   * How much better a rival octave must explain the span before this witness
   * will name it instead of the candidate's own pitch.
   *
   * A ratio, not a difference, so it means the same thing at every level. A
   * correct fundamental normally beats its neighbours by a wide margin, because
   * the wrong hypothesis has to explain the true partials as accidents.
   *
   * Two measurements set it. The first is structural, on synthesised signals
   * where the true octave is exact, binary-searching the highest ratio at which
   * the witness still gives each answer:
   *
   * ```
   * candidate an octave low, natural partials  -> lift      up to 2.19
   * candidate an octave low, flat partials     -> lift      up to 2.67
   * real note, fundamental attenuated to 15%   -> push up   only to 1.05
   * ```
   *
   * The last row is the error mode: a note whose fundamental the microphone has
   * rolled off, which this witness will move an octave up if allowed to. It
   * stops being allowed to above about 1.06, while the corrections that matter
   * survive past 2.1. So anything in [1.06, 2.19] separates the two, which is a
   * wide enough band that the exact value is not what decides the outcome.
   *
   * The second measurement is the corpus, counting corrections that moved a
   * note toward the reference against ones that moved it away:
   *
   * ```
   * ratio   opinions   moved   toward   away
   * 1.00       220       14      12       2
   * 1.20       186       14      12       2
   * 1.30       172       14      12       2
   * 1.45       148       11       9       2
   * 1.80        99        6       6       0
   * ```
   *
   * Identical from 1.00 to 1.30, which says the same thing from the other side:
   * the arbitration's own coverage and corroboration gates are what decide,
   * and the extra opinions a looser setting produces never clear them.
   *
   * 1.25 is inside both bands. It asks a rival octave to explain the span a
   * quarter better, which is a real margin, and it is not on either edge.
   */
  decisionRatio: number;
  /** Spans shorter than this are not worth a spectrum. */
  minDurationSec: number;
}

export const DEFAULT_HARMONIC_OPTIONS: HarmonicWitnessOptions = {
  frameSize: 4096,
  partials: 6,
  decisionRatio: 1.25,
  minDurationSec: 0.12,
};

/** Interpolated magnitude at an arbitrary frequency. */
function magnitudeAt(spectrum: Float32Array, hz: number, sampleRate: number, frameSize: number): number {
  const bin = (hz * frameSize) / sampleRate;
  if (bin < 1 || bin >= spectrum.length - 1) return 0;
  const low = Math.floor(bin);
  const fraction = bin - low;
  // Peak-picking over a small neighbourhood: a sung partial is never exactly on
  // a bin centre, and reading only the nearest bin turns ordinary detuning into
  // a missing harmonic.
  let best = 0;
  for (let offset = -1; offset <= 2; offset += 1) {
    const index = low + offset;
    if (index < 0 || index >= spectrum.length) continue;
    best = Math.max(best, spectrum[index] as number);
  }
  const interpolated =
    (spectrum[low] as number) * (1 - fraction) + (spectrum[low + 1] as number) * fraction;
  return Math.max(best, interpolated);
}

/**
 * How well a harmonic series on `midi` explains this spectrum.
 *
 * Partials are weighted down as they rise: the fundamental and low partials
 * carry the identity, and crediting high partials equally is what lets a
 * hypothesis an octave up score well by borrowing the true note's even
 * harmonics.
 */
function harmonicScore(
  spectrum: Float32Array,
  midi: number,
  sampleRate: number,
  options: HarmonicWitnessOptions,
): number {
  const fundamental = midiToHz(midi);
  if (fundamental <= 0) return 0;
  let total = 0;
  let weightSum = 0;
  for (let partial = 1; partial <= options.partials; partial += 1) {
    const hz = fundamental * partial;
    if (hz >= sampleRate / 2) break;
    const weight = 1 / partial;
    total += weight * magnitudeAt(spectrum, hz, sampleRate, options.frameSize);
    weightSum += weight;
  }
  return weightSum > 0 ? total / weightSum : 0;
}

/** Averaged magnitude spectrum across a note's span. */
function spanSpectrum(
  audio: MonoAudio,
  startSec: number,
  endSec: number,
  frameSize: number,
): Float32Array | null {
  const from = Math.max(0, Math.floor(startSec * audio.sampleRate));
  const to = Math.min(audio.samples.length, Math.ceil(endSec * audio.sampleRate));
  if (to - from < frameSize) return null;

  const window = hannWindow(frameSize);
  const frame = new Float32Array(frameSize);
  const accumulated = new Float32Array(frameSize / 2);
  // Three windows spread across the note, so one transient cannot decide it.
  const positions = [from, Math.floor((from + to - frameSize) / 2), to - frameSize];
  let used = 0;
  for (const position of positions) {
    if (position < 0 || position + frameSize > audio.samples.length) continue;
    for (let i = 0; i < frameSize; i += 1) {
      frame[i] = (audio.samples[position + i] as number) * (window[i] as number);
    }
    const magnitude = magnitudeSpectrum(frame);
    for (let i = 0; i < accumulated.length; i += 1) {
      accumulated[i] = (accumulated[i] as number) + (magnitude[i] as number);
    }
    used += 1;
  }
  if (used === 0) return null;
  for (let i = 0; i < accumulated.length; i += 1) {
    accumulated[i] = (accumulated[i] as number) / used;
  }
  return accumulated;
}

/**
 * Which octave the recording itself supports, per candidate note.
 *
 * Emits a note only where the spectrum has a clear preference. Silence from
 * this witness means "no opinion", which the arbitration reads as no evidence
 * rather than as agreement.
 */
export function harmonicRegisterWitness(
  audio: MonoAudio,
  candidate: readonly NoteEvent[],
  overrides: Partial<HarmonicWitnessOptions> = {},
): EvidenceSource {
  const options = { ...DEFAULT_HARMONIC_OPTIONS, ...overrides };
  const analysed = resample(audio, ANALYSIS_RATE);
  const notes: EvidenceNote[] = [];

  for (const note of candidate) {
    if (note.endSec - note.startSec < options.minDurationSec) continue;
    const spectrum = spanSpectrum(analysed, note.startSec, note.endSec, options.frameSize);
    if (spectrum === null) continue;

    const here = harmonicScore(spectrum, note.pitch, ANALYSIS_RATE, options);
    const below = harmonicScore(spectrum, note.pitch - 12, ANALYSIS_RATE, options);
    const above = harmonicScore(spectrum, note.pitch + 12, ANALYSIS_RATE, options);
    if (here <= 0 && below <= 0 && above <= 0) continue;

    // The rival only wins by being decisively better, and the candidate's own
    // pitch is confirmed only when nothing beats it by that margin. Anything in
    // between is an opinion this witness does not have.
    const strongest = Math.max(here, below, above);
    let chosen: number | null = null;
    if (strongest === here) {
      if (here >= Math.max(below, above) * options.decisionRatio) chosen = note.pitch;
    } else if (strongest === below) {
      if (below >= here * options.decisionRatio) chosen = note.pitch - 12;
    } else if (above >= here * options.decisionRatio) {
      chosen = note.pitch + 12;
    }
    if (chosen === null) continue;

    notes.push({ startSec: note.startSec, endSec: note.endSec, pitch: chosen });
  }

  return { engineId: 'harmonic-spectrum', view: 'original', notes };
}
