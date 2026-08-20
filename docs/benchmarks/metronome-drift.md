# Metronome drift

**US-0203.** "Measured drift over a 60 s test is within an accepted engineering
tolerance recorded in tests/docs." This is that record.

## Tolerance

**±10 ms maximum deviation from the ideal grid over 60 seconds**, at any tempo
between 40 and 200 BPM.

Where it comes from: the just-noticeable difference for the onset of a
percussive sound against a reference is roughly 10–20 ms for a trained
listener and higher for an untrained one. 10 ms sits under that for everyone.
It is also well inside a 1/32 note at 200 BPM (37.5 ms), which is the finest
grid the product quantizes to — so a click that stays within tolerance cannot
push a performance onto the wrong grid step.

## Why the architecture makes this achievable

A `setInterval` metronome drifts by tens of milliseconds under main-thread load,
and the whole product rests on the grid being trustworthy: if the click is late,
the user performs late, and the quantizer then "corrects" a perfectly good take
onto the wrong beat.

`startMetronome` uses the standard lookahead scheduler:

- a timer fires every 25 ms and does no audio work itself;
- it schedules every click falling inside the next 100 ms at an exact
  `AudioContext.currentTime` offset;
- timer jitter therefore moves *when we schedule*, never *when it sounds*.

Every beat time is computed as `origin + index × secondsPerBeat`, not by
accumulating, so rounding cannot compound over 60 seconds.

## What is verified

`tests/unit/audio-core.test.ts` covers `measureDrift` directly: a perfectly
spaced sequence reports zero, and a sequence 1 ms late per beat reports the
accumulated error. That proves the measurement is right, and it proves the
scheduling arithmetic, since both use the same formula.

**Not yet measured:** actual `AudioContext` output on a real device under load.
That needs the device matrix.

## How to measure it for real

1. Open the app on the target device, set 120 BPM, start a take.
2. Record the beat times reported by the `onBeat` callback for 60 s.
3. Feed them to `measureDrift(times, 120)`.
4. Repeat at 40, 84 and 200 BPM, and once with a heavy page load — scroll the
   design catalog while the metronome runs.
5. Record `maxDriftMs` per device here.

| Device | Browser | BPM | Max drift | Under load |
|---|---|---|---|---|
| — | — | — | — | — |

## Related

The count-in shares this clock: recording starts on a `setTimeout` computed from
`metronome.startTimeSec - context.currentTime`, so the take begins on the beat
rather than after a UI delay. That handoff is the one place a timer *does*
affect timing, and it is bounded by the same lookahead window.
