/**
 * The procedural synthesis engine - the default sound source.
 *
 * Builds each note from Web Audio primitives following the recipes in
 * `voices.ts`. Nothing is fetched, so the first render happens with no network
 * at all, and the identical code path runs inside an `OfflineAudioContext`,
 * which is what makes the faster-than-real-time render target reachable.
 *
 * Its real limitation is stated plainly rather than hidden: these are
 * synthesised approximations, not recordings. Q-D4 asked for realistic acoustic
 * instruments, and reaching that means sample packs through `SampleEngine`.
 * See ADR-002 for the decision and what it is waiting on.
 *
 * Determinism: no randomness anywhere except the noise buffer, which is
 * generated once from a fixed seed. Two renders of the same sketch produce
 * byte-identical audio, which is what lets render output be regression-tested.
 */

import type {
  InstrumentDefinition,
  PreparedInstrument,
  ScheduledHit,
  ScheduledNote,
  SynthEngine,
} from './types';
import { DRUM_SPECS, VOICE_SPECS, type DrumVoiceSpec, type VoiceSpec } from './voices';

/** Deterministic noise, generated once per context and reused by every voice. */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** xorshift32 - fast, deterministic, and good enough for a noise floor. */
function seededNoise(length: number, seed = 0x9e3779b9): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = (state / 0x7fffffff) % 1;
  }
  return out;
}

function getNoiseBuffer(context: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(context);
  if (cached) return cached;
  const length = Math.ceil(context.sampleRate * 2);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  buffer.copyToChannel(new Float32Array(seededNoise(length)), 0);
  noiseCache.set(context, buffer);
  return buffer;
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Velocity to gain on a perceptual curve rather than a linear one. */
function velocityToGain(velocity: number): number {
  const normalized = Math.max(1, Math.min(127, velocity)) / 127;
  return normalized ** 1.6;
}

class ProceduralInstrument implements PreparedInstrument {
  readonly engineId = 'procedural';
  readonly releaseTailSec: number;

  private readonly nodes: AudioScheduledSourceNode[] = [];

  constructor(
    readonly instrumentId: string,
    private readonly context: BaseAudioContext,
    private readonly voice: VoiceSpec | null,
    private readonly kit: Record<'kick' | 'snare' | 'hat', DrumVoiceSpec> | null,
  ) {
    this.releaseTailSec = voice ? voice.envelope.releaseSec + 0.15 : 0.7;
  }

  scheduleNotes(destination: AudioNode, notes: readonly ScheduledNote[], originSec: number): void {
    if (!this.voice) return;
    for (const note of notes) {
      this.scheduleNote(destination, note, originSec);
    }
  }

  scheduleHits(destination: AudioNode, hits: readonly ScheduledHit[], originSec: number): void {
    if (!this.kit) return;
    for (const hit of hits) {
      const key = hit.drum === 'unknown' ? 'hat' : hit.drum;
      this.scheduleHit(destination, this.kit[key], hit, originSec);
    }
  }

  private scheduleNote(destination: AudioNode, note: ScheduledNote, originSec: number): void {
    const voice = this.voice as VoiceSpec;
    const context = this.context;
    const start = originSec + note.startSec;
    const held = Math.max(0.03, note.endSec - note.startSec);
    const end = start + held;
    const frequency = midiToHz(note.pitch);
    const level = velocityToGain(note.velocity) * voice.gain;

    const noteGain = context.createGain();
    noteGain.gain.value = 1;

    const output: AudioNode = voice.filter
      ? this.buildFilter(voice.filter, frequency, start, end)
      : noteGain;
    if (voice.filter) {
      noteGain.connect(output);
      output.connect(destination);
    } else {
      noteGain.connect(destination);
    }

    const amp = context.createGain();
    applyEnvelope(amp.gain, voice.envelope, start, end, level);
    amp.connect(noteGain);

    // Tonal part: one oscillator per partial, optionally doubled and detuned.
    const partialTotal = voice.partials.reduce((total, p) => total + p, 0) || 1;
    const copies = voice.unisonDetuneCents > 0 ? [-1, 1] : [0];

    for (const copy of copies) {
      for (let index = 0; index < voice.partials.length; index += 1) {
        const amplitude = (voice.partials[index] as number) / partialTotal;
        if (amplitude < 0.004) continue;
        const partialHz = frequency * (index + 1);
        // Above Nyquist a partial aliases back down as an audible whistle.
        if (partialHz >= context.sampleRate / 2) break;

        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = partialHz;
        oscillator.detune.value = copy * voice.unisonDetuneCents;

        if (voice.vibrato) this.attachVibrato(oscillator, voice, start, end);

        const partialGain = context.createGain();
        partialGain.gain.value = amplitude / copies.length;
        oscillator.connect(partialGain);
        partialGain.connect(amp);

        oscillator.start(start);
        oscillator.stop(end + voice.envelope.releaseSec + 0.05);
        this.nodes.push(oscillator);
      }
    }

    if (voice.noise) this.attachNoise(voice, amp, start, end, frequency);
  }

  private buildFilter(
    spec: NonNullable<VoiceSpec['filter']>,
    frequency: number,
    start: number,
    end: number,
  ): BiquadFilterNode {
    const filter = this.context.createBiquadFilter();
    filter.type = spec.type;
    filter.Q.value = spec.q;
    // Key tracking keeps the top of the range from sounding muffled and the
    // bottom from sounding thin, which one fixed cutoff cannot do.
    const track = 1 + spec.keyTracking * (frequency / 261.63 - 1);
    const from = Math.max(60, Math.min(20000, spec.startHz * track));
    const to = Math.max(60, Math.min(20000, spec.endHz * track));
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, Math.min(end, start + spec.sweepSec));
    return filter;
  }

  private attachVibrato(
    oscillator: OscillatorNode,
    voice: VoiceSpec,
    start: number,
    end: number,
  ): void {
    const spec = voice.vibrato as NonNullable<VoiceSpec['vibrato']>;
    if (end - start < spec.onsetSec) return;
    const lfo = this.context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = spec.rateHz;
    const depth = this.context.createGain();
    depth.gain.setValueAtTime(0, start);
    depth.gain.setValueAtTime(0, start + spec.onsetSec);
    depth.gain.linearRampToValueAtTime(spec.depthCents, start + spec.onsetSec + 0.12);
    lfo.connect(depth);
    depth.connect(oscillator.detune);
    lfo.start(start);
    lfo.stop(end + 0.1);
    this.nodes.push(lfo);
  }

  private attachNoise(
    voice: VoiceSpec,
    amp: GainNode,
    start: number,
    end: number,
    frequency: number,
  ): void {
    const spec = voice.noise as NonNullable<VoiceSpec['noise']>;
    const source = this.context.createBufferSource();
    source.buffer = getNoiseBuffer(this.context);
    source.loop = true;

    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    // Breath noise sits above the fundamental; anchoring it to the note keeps
    // a low bowed note from hissing like a high one.
    filter.frequency.value = Math.min(18000, Math.max(spec.centreHz, frequency * 2));
    filter.Q.value = spec.q;

    const gain = this.context.createGain();
    const peak = spec.amount * voice.gain;
    if (spec.sustained) {
      applyEnvelope(gain.gain, voice.envelope, start, end, peak);
    } else {
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.decaySec);
    }

    source.connect(filter);
    filter.connect(gain);
    gain.connect(amp);
    source.start(start);
    source.stop(end + voice.envelope.releaseSec + 0.05);
    this.nodes.push(source);
  }

  private scheduleHit(
    destination: AudioNode,
    spec: DrumVoiceSpec,
    hit: ScheduledHit,
    originSec: number,
  ): void {
    const context = this.context;
    const start = originSec + hit.startSec;
    const level = velocityToGain(hit.velocity) * spec.gain;
    // One ratio for the whole voice, so a tuned hit keeps its character: the
    // sweep, the noise colour and the tone move together, the way a drum does
    // when it is tuned rather than pitch-shifted after the fact.
    const tune = 2 ** ((hit.tuneSemitones ?? 0) / 12);

    if (spec.toneLevel > 0) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(spec.toneStartHz * tune, start);
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(20, spec.toneEndHz * tune),
        start + spec.toneSweepSec,
      );
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level * spec.toneLevel, start + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.toneDecaySec);
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start(start);
      oscillator.stop(start + spec.toneDecaySec + 0.05);
      this.nodes.push(oscillator);
    }

    if (spec.noiseLevel > 0) {
      const source = context.createBufferSource();
      source.buffer = getNoiseBuffer(context);
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = spec.noiseType;
      filter.frequency.value = spec.noiseHz * tune;
      filter.Q.value = spec.noiseQ;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level * spec.noiseLevel, start + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.noiseDecaySec);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      source.start(start);
      source.stop(start + spec.noiseDecaySec + 0.05);
      this.nodes.push(source);
    }
  }

  dispose(): void {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // Already stopped or never started; either way there is nothing to do.
      }
    }
    this.nodes.length = 0;
  }
}

/**
 * ADSR onto an `AudioParam`.
 *
 * Uses exponential ramps because amplitude is perceived logarithmically - a
 * linear fade sounds like it stops abruptly at the end. Zero is unreachable on
 * an exponential ramp, hence the 0.0001 floor and the final `setValueAtTime`.
 */
function applyEnvelope(
  param: AudioParam,
  envelope: { attackSec: number; decaySec: number; sustain: number; releaseSec: number },
  start: number,
  end: number,
  peak: number,
): void {
  const safePeak = Math.max(0.0002, peak);
  const attackEnd = start + envelope.attackSec;
  const decayEnd = attackEnd + envelope.decaySec;
  const sustainLevel = Math.max(0.0002, safePeak * envelope.sustain);
  const releaseEnd = end + envelope.releaseSec;

  param.setValueAtTime(0.0001, start);
  param.exponentialRampToValueAtTime(safePeak, attackEnd);

  if (decayEnd < end) {
    param.exponentialRampToValueAtTime(sustainLevel, decayEnd);
    param.setValueAtTime(sustainLevel, end);
  } else {
    // Note released mid-decay: ramp straight to wherever the decay had reached.
    param.exponentialRampToValueAtTime(sustainLevel, Math.max(attackEnd + 0.001, end));
  }
  param.exponentialRampToValueAtTime(0.0001, releaseEnd);
  param.setValueAtTime(0, releaseEnd + 0.001);
}

export class ProceduralEngine implements SynthEngine {
  readonly id = 'procedural';

  supports(instrument: InstrumentDefinition): boolean {
    return instrument.mode === 'rhythm'
      ? DRUM_SPECS[instrument.id] !== undefined
      : VOICE_SPECS[instrument.id] !== undefined;
  }

  async prepare(
    instrument: InstrumentDefinition,
    context: BaseAudioContext,
    onProgress?: (fraction: number) => void,
  ): Promise<PreparedInstrument> {
    onProgress?.(0.5);
    // Warms the noise buffer so the first note does not pay for it.
    getNoiseBuffer(context);
    onProgress?.(1);
    return new ProceduralInstrument(
      instrument.id,
      context,
      VOICE_SPECS[instrument.id] ?? null,
      DRUM_SPECS[instrument.id] ?? null,
    );
  }
}
