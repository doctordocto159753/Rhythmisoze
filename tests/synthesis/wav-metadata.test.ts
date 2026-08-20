import { describe, expect, it } from 'vitest';
import { encodeWav, readWavHeader } from '@audio-core';

describe('generated WAV metadata snapshot', () => {
  it('stays a portable stereo 16-bit PCM file without extra metadata chunks', () => {
    const left = new Float32Array([0, 0.25, -0.25, 0.5]);
    const right = new Float32Array([0, -0.25, 0.25, -0.5]);
    const wav = encodeWav([left, right], { sampleRate: 44_100 });
    expect({ byteLength: wav.byteLength, ...readWavHeader(wav) }).toMatchInlineSnapshot(`
      {
        "bitsPerSample": 16,
        "byteLength": 60,
        "channelCount": 2,
        "durationSec": 0.00009070294784580499,
        "frameCount": 4,
        "sampleRate": 44100,
      }
    `);
  });
});
