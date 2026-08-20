# Audio validation thresholds

**US-0208.** The acceptance criterion is specific: validation must not "reject
valid quiet material using an arbitrary single threshold without calibration."
This documents where each number came from.

Defaults live in one place, `DEFAULT_VALIDATION_THRESHOLDS` in
`src/packages/audio-core/normalize.ts`, so a corpus run can move them without
hunting through the UI.

## The failure mode being guarded against

Rejecting a soft singer. The product's user is someone who hums quietly into a
laptop, often self-consciously. A single RMS gate tuned on a confident voice
refuses them, and the refusal is unrecoverable from their side — they were doing
the right thing.

So: **quietness alone never blocks processing.** The only genuinely unusable
case is a clip whose *loudest* 20 ms frame sits at the noise floor.

## Values

| Threshold | Value | Reasoning |
|---|---|---|
| `minDurationSec` | 0.75 | Below this there is not enough material for a pitch tracker to produce two notes, let alone a phrase. Not a taste judgement: the YIN frame is 2048 samples and the segmenter needs several. |
| `emptyFrameRms` | 0.0025 | ≈ −52 dBFS. Below the noise floor of every consumer microphone tested against. A clip whose loudest frame is here has nothing in it. |
| `faintFrameRms` | 0.012 | ≈ −38 dBFS. Faint but workable. Combined with `mostlySilentRatio`, it produces a *hint*, never a rejection. |
| `mostlySilentRatio` | 0.97 | A take is only called "mostly silent" when 97% of frames are below the floor. A phrase with long rests still passes. |
| `clippedRatio` | 0.02 | A couple of clipped samples on a plosive is normal. Distortion is reported only past 2% of the whole clip, and even then the take is still processed. |
| `CLIP_LEVEL` | 0.985 | Just below full scale, to catch codec rounding that lands a clipped sample at 0.998 rather than 1.0. |
| `SILENCE_FLOOR_RMS` | 0.004 | Used for frame classification and for `trimSilence`. |
| `FRAME_MS` | 20 | Short enough to see the gap between two hummed notes. |

## What is calibrated and what is not

**Derived from the signal processing:** `minDurationSec`, `FRAME_MS`,
`CLIP_LEVEL`. These follow from frame sizes and from how integer audio clips.

**Reasoned, not measured:** `emptyFrameRms`, `faintFrameRms`,
`mostlySilentRatio`, `clippedRatio`. They are placed conservatively — biased
toward accepting a marginal take — but no human recording has been run through
them.

## How to calibrate them properly

Once the corpus exists:

1. Run `analyzeAudio` over every fixture and record `loudestFrameRms`,
   `silentRatio` and `clippedRatio`.
2. Plot the soft-voice fixtures against the deliberately-empty ones. There
   should be a clear gap; put `emptyFrameRms` inside it.
3. Confirm that no fixture a human would call usable is rejected. A false
   rejection is a much worse outcome than a false acceptance here, because the
   pipeline downstream degrades gracefully on marginal input and not at all on
   a refusal.
4. Record the observed ranges in this file and update the table.

## Current test coverage

`tests/unit/audio-core.test.ts` asserts the behaviours rather than the numbers:
a normal take passes, silence is rejected, a short clip is rejected, **a quiet
singer at −34 dBFS is accepted**, and heavy clipping warns without refusing.
Those assertions survive a recalibration; the numbers above are expected to move.
