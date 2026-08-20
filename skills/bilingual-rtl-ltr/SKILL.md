# Skill — Bilingual Persian / English Interface

## Use when
Writing UI, laying out components, handling localization, formatting mixed-direction content or reviewing Persian/English parity.

## Goal
Make Persian and English feel like two native presentations of one system.

## Rules
- Set `lang` and `dir` at the correct scope.
- Use logical CSS: inline-start/end, block-start/end.
- Treat note names, BPM, numbers, MIDI/WAV filenames, URLs and code-like tokens as direction-sensitive content.
- Use bidi isolation (`bdi`, Unicode isolation strategy or equivalent) where mixed strings need it.
- Do not mirror timelines/waveforms/piano-roll time simply because the page is RTL.
- Audit directional icons individually.
- Never assume English label length when sizing controls.

## Copy rules
- Prefer plain Persian and plain English.
- Do not translate technical terms if the translation creates more confusion.
- Keep accessible labels localized.
- Validate punctuation around mixed Persian/Latin phrases visually.

## Visual QA matrix
For every core screen:
- Persian desktop;
- English desktop;
- Persian mobile;
- English mobile;
- long title;
- mixed BPM/note/file string;
- validation/error state.

## Avoid
- using `text-align:right` as the whole RTL strategy;
- hard-coded left/right spacing;
- forcing Latin characters into Persian direction;
- separate visual systems per language.
