/**
 * Uncompressed microphone capture.
 *
 * ## Why this exists
 *
 * `MediaRecorder` is the obvious way to record in a browser and it was the way
 * this product recorded. Every browser it runs on encodes to Opus, and none of
 * them lets you turn that off — `MediaRecorder.isTypeSupported('audio/wav')` is
 * false in Chrome, Firefox and Safari alike. So the first thing that happened to
 * a hum was lossy compression, at whatever bitrate the browser felt like, before
 * any part of this product saw it.
 *
 * That is a strange place to lose quality. Opus is built for speech and music
 * *as heard*, and it spends its bits accordingly: a psychoacoustic coder is
 * explicitly allowed to discard anything a listener will not notice. A pitch
 * model is not a listener. It reads the harmonic structure that the coder is
 * busy deciding is redundant, and the effect is worst on exactly the material
 * this product is for — a quiet, sustained, solo hum with no masking around it.
 *
 * It also explains a difference that was otherwise hard to account for:
 * recordings made in the app transcribed worse than the same performance
 * uploaded as a file, because an uploaded file never went through Opus.
 *
 * ## What this does instead
 *
 * Takes the samples straight off the audio graph, before any encoder. An
 * `AudioWorkletNode` receives the microphone's frames on the audio thread and
 * ships them out in blocks; the result is the signal the browser's own
 * resampler produced and nothing else.
 *
 * The worklet runs on the audio thread specifically so that a busy main thread
 * cannot drop samples. `ScriptProcessorNode` would have been simpler and needs
 * no module loading, but it runs on the main thread, and a dropped block there
 * is not a glitch in a monitor — it is a hole in the recording.
 *
 * ## Why the module is a blob URL
 *
 * `audioWorklet.addModule` takes a URL, which normally means a separate file
 * that the bundler has to be told to emit unhashed and serve from a known path.
 * The processor is nine lines. Building it into a blob URL keeps it beside the
 * code that uses it and removes a build-configuration dependency from a path
 * whose failure mode is silent.
 */

import { AppError } from '@contracts';

/** Registered name. Must match the string inside the processor source below. */
const PROCESSOR_NAME = 'rhythmisoze-pcm-capture';

/**
 * Frames per message. 4096 at 44.1 kHz is ~93 ms.
 *
 * The audio thread hands over 128 samples at a time. Posting each one is ~344
 * messages a second per recording, which is real overhead for no benefit —
 * nothing here needs the samples promptly, it needs all of them.
 */
const BLOCK_SIZE = 4096;

const PROCESSOR_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${BLOCK_SIZE});
    this.filled = 0;
    this.port.onmessage = (event) => {
      // A flush request on stop, so the final partial block is not lost.
      if (event.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.filled === 0) return;
    this.port.postMessage(this.buffer.slice(0, this.filled));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.buffer[this.filled] = channel[i];
        this.filled += 1;
        if (this.filled === this.buffer.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', PcmCaptureProcessor);
`;

/**
 * Which contexts have the processor registered.
 *
 * Per context, because registration is a property of the context rather than of
 * the page, and `addModule` on a context that already has it is wasted work.
 */
const registered = new WeakSet<BaseAudioContext>();

/**
 * Registers the capture processor, returning whether it is usable.
 *
 * Never throws. A browser without `AudioWorklet`, or one that refuses the blob
 * URL under a strict policy, is a browser that records through `MediaRecorder`
 * instead — which is worse, and still works. Losing the recording entirely
 * because the better path was unavailable would be the wrong trade.
 */
export async function ensurePcmCaptureModule(context: BaseAudioContext): Promise<boolean> {
  if (registered.has(context)) return true;
  if (typeof context.audioWorklet?.addModule !== 'function') return false;
  if (typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;

  const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
    registered.add(context);
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Whether `startRecording` can take the uncompressed path on this context. */
export function isPcmCaptureReady(context: BaseAudioContext): boolean {
  return registered.has(context);
}

export interface PcmCapture {
  /** Connect the microphone to this. */
  readonly node: AudioNode;
  /** Everything captured so far, in one array. Also tears the node down. */
  finish(): Promise<Float32Array>;
  /** Drops what was captured and tears the node down. */
  cancel(): void;
}

/**
 * Starts accumulating samples from whatever is connected to `node`.
 *
 * The returned node is connected to a silent sink by the caller's graph rather
 * than left dangling: an `AudioWorkletNode` whose output goes nowhere is not
 * guaranteed to be pulled, and a capture that silently stops after a few
 * hundred milliseconds is the worst possible failure here.
 */
export function createPcmCapture(context: BaseAudioContext): PcmCapture {
  if (!registered.has(context)) {
    throw new AppError('recording_failed', 'retry', 'pcm capture module not registered');
  }

  const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });

  const blocks: Float32Array[] = [];
  let total = 0;
  let closed = false;

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (closed) return;
    blocks.push(event.data);
    total += event.data.length;
  };

  const teardown = (): void => {
    closed = true;
    node.port.onmessage = null;
    try {
      node.disconnect();
    } catch {
      // Already disconnected by a context close; nothing to recover.
    }
  };

  return {
    node,
    async finish() {
      // Ask for the partial block still sitting in the processor, and give the
      // audio thread a turn to answer before reading. Without this the tail of
      // every recording is up to 93 ms short.
      node.port.postMessage('flush');
      await new Promise((resolve) => {
        setTimeout(resolve, 60);
      });
      teardown();

      const samples = new Float32Array(total);
      let offset = 0;
      for (const block of blocks) {
        samples.set(block, offset);
        offset += block.length;
      }
      blocks.length = 0;
      return samples;
    },
    cancel() {
      teardown();
      blocks.length = 0;
      total = 0;
    },
  };
}
