/**
 * US-0902 - WAV encoding.
 *
 * Documented format: RIFF/WAVE, 16-bit signed little-endian PCM, at the sample
 * rate of the render context (44,100 Hz on every browser the product supports).
 * Interleaved stereo when the render is stereo, mono otherwise.
 *
 * 16-bit is chosen over 32-bit float because the file is something a person
 * sends to a friend: half the size, and every player on every platform opens it.
 *
 * No branding, no watermark, no metadata chunk carrying anything about the user
 * (PRD 6.6, explicit: "watermark: no. Polluting the user's output breaks trust").
 */

const BYTES_PER_SAMPLE = 2;

export interface WavEncodeOptions {
  sampleRate: number;
  /** Peak level to normalise to, or `null` to leave the render untouched. */
  normalizeTo?: number | null;
}

/**
 * Encodes planar float channels into a WAV file.
 * Values outside -1..1 are hard-clipped, which is audibly better than the
 * wrap-around a naive cast produces.
 */
export function encodeWav(
  channels: readonly Float32Array[],
  options: WavEncodeOptions,
): ArrayBuffer {
  if (channels.length === 0) throw new Error('encodeWav requires at least one channel');
  const channelCount = channels.length;
  const frameCount = (channels[0] as Float32Array).length;
  const sampleRate = options.sampleRate;

  const gain = resolveGain(channels, options.normalizeTo ?? null);

  const dataBytes = frameCount * channelCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, channelCount * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const raw = ((channels[channel] as Float32Array)[frame] as number) * gain;
      const clamped = raw < -1 ? -1 : raw > 1 ? 1 : raw;
      // Asymmetric scaling: int16 reaches -32768 but only +32767.
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return buffer;
}

function resolveGain(channels: readonly Float32Array[], normalizeTo: number | null): number {
  if (normalizeTo === null) return 1;
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i] as number);
      if (magnitude > peak) peak = magnitude;
    }
  }
  if (peak === 0) return 1;
  return normalizeTo / peak;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Parses a WAV header. Used by tests and by the share page's duration check. */
export function readWavHeader(buffer: ArrayBuffer): {
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
  frameCount: number;
  durationSec: number;
} {
  const view = new DataView(buffer);
  const riff = readAscii(view, 0, 4);
  const wave = readAscii(view, 8, 4);
  if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  const channelCount = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const bytesPerFrame = (channelCount * bitsPerSample) / 8;
  const frameCount = bytesPerFrame > 0 ? dataBytes / bytesPerFrame : 0;
  return {
    channelCount,
    sampleRate,
    bitsPerSample,
    frameCount,
    durationSec: sampleRate > 0 ? frameCount / sampleRate : 0,
  };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}
