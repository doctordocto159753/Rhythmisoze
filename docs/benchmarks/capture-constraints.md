# Microphone capture constraints

**US-0205.** "Capture constraints for echo cancellation / noise suppression /
AGC are benchmarked and documented."

## What is requested

`MUSIC_CAPTURE_CONSTRAINTS` in `src/packages/audio-core/recorder.ts`:

```ts
{ echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  channelCount: 1, sampleRate: 44100 }
```

All three processors **off**, deliberately.

## Why each one is off

They are tuned for speech intelligibility on a call, and each damages exactly
what this product needs:

| Processor | What it does to a hum |
|---|---|
| **Noise suppression** | Gates the tail of a sustained note. A held vowel decays below its threshold and gets cut, which the note segmenter then reads as two notes with a gap. |
| **Automatic gain control** | Pumps the level mid-phrase. Velocity is derived from peak RMS, so AGC actively destroys the dynamics the render is supposed to reproduce — and it does so unevenly, so the flattening is not even consistent. |
| **Echo cancellation** | Applies an adaptive filter referenced to the output. With a metronome playing through speakers, it is *chasing the click*, and the filter's phase response moves the pitch tracker around. |

The metronome case is the sharpest: the product plays a click while recording,
by design. Echo cancellation exists to remove exactly that, and removing it
takes some of the voice with it.

## The catch

**A browser is free to ignore any of this.** `getUserMedia` constraints are
requests, and some Android builds apply hardware-level processing that no
constraint reaches. That is why `openMicrophone` returns `track.getSettings()`
alongside the stream: what was granted, not what was asked.

## What to measure

For each target device and browser:

1. Record a 10 s sustained hum with the metronome audible through speakers.
2. Log `getSettings()` — do the three flags come back `false`?
3. Check the decay tail: does the note end where the singer stopped, or earlier?
4. Check level stability: does a crescendo survive, or flatten?
5. Run the pitch tracker and check for a systematic offset when the click plays
   versus when it does not.

| Device | Browser | EC granted | NS granted | AGC granted | Tail intact | Level stable | Notes |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — |

**Not yet measured.** Needs the device matrix from Q-A3.

## Fallback if a device forces processing

If a platform cannot be persuaded to turn AGC off, the options in order of
preference:

1. Recommend headphones for the metronome, which removes the echo path entirely
   and is the correct advice for a musician anyway.
2. Fall back to a visual-only count-in with the click muted — already supported,
   and the beat dots make it usable (D-0302).
3. Compress the velocity mapping's range on that device class, so a flattened
   input does not produce a render that is flat *and* wrong.

## Sample rate

44.1 kHz requested; the browser may grant 48 kHz. Nothing downstream assumes the
recorded rate: `toMonoAudio` records whatever it got, and `resample` converts to
the model's 22.05 kHz explicitly rather than letting the wrapper do it
invisibly. The playbook's warning that "Basic Pitch may resample internally; do
not assume the recorded sample rate equals inference sample rate" is handled by
making the conversion visible and testable.
