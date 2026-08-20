# Skill — Accessibility for an Audio-Creation Product

## Use when
Designing or implementing recording, playback, piano-roll, 3D/audio visualizations, progress, downloads or keyboard behavior.

## Goal
Ensure expressive audio interaction remains usable without requiring perfect vision, hearing, pointer control or motion tolerance.

## Requirements
- Record/stop controls have explicit accessible names and states.
- Processing status uses appropriate live announcements without spam.
- Keyboard can complete the core flow.
- Focus does not disappear inside canvas/WebGL regions.
- Visual status has text/icon/state equivalents.
- Sound-only cues such as metronome count-in have visual equivalents.
- Visual-only pitch/note views have a concise semantic summary.
- Reduced-motion mode remains designed and coherent.
- Hit targets are touch-appropriate.

## Audio-specific considerations
- Do not assume user hears metronome; show pulse/count.
- Do not assume waveform alone proves recording; expose text/status.
- Do not autoplay surprising sound on page load.
- Respect browser audio-unlock/user-gesture constraints.
- Prevent multiple overlapping previews from becoming chaotic.

## Validation
- keyboard-only smoke test;
- screen-reader smoke test;
- reduced-motion test;
- high zoom;
- mobile touch;
- muted-audio path where meaningful.
