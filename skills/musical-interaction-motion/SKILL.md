# Skill — Musical Interaction & Motion

## Use when
Designing tap tempo, metronome, count-in, record, playback, processing, retouch or any timed animation.

## Goal
Make time itself part of the interaction while preserving accuracy and calm.

## Principles
- Audio clock is truth for musical timing.
- UI animation follows musical timing; it must not drive it.
- Use bounded temporal relationships: beat, half-beat, bar, phrase.
- Not everything should pulse.
- Motion should clarify entry, continuity, causality or completion.

## Process
1. Identify the temporal source.
2. Define what the user must perceive.
3. Choose the smallest motion that communicates it.
4. Test at 40, 80, 120 and 200 BPM.
5. Test with reduced motion.
6. Verify no visual lag makes the beat feel wrong.
7. Listen while looking; then listen without looking.

## Acceptance bar
- count-in is unambiguous;
- tap response feels immediate;
- record state feels focused;
- processing motion never implies false precision;
- retouch motion does not distract from A/B listening;
- playback cursor is stable and legible.

## Avoid
- CSS timers as source of metronome truth;
- easing that makes a beat land late;
- animating every control on every beat;
- motion whose amplitude is uncontrolled by live audio;
- transitions longer than the user's musical action demands.
