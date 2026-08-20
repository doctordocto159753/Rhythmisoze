# Manual device checks

**US-1203, D-0903.** The parts no headless browser can verify.

A headless browser has no microphone, so the automated suite covers everything
around capture — routing, the tempo control, the state machine's guards, the
workspace, the share page, the catalog — and the list below is what a person has
to do on real hardware.

**Status: not performed.** No device from Q-A3 has been named, and this
implementation has not been run on physical hardware.

## Matrix

| Device | Browser | Priority |
|---|---|---|
| Mid-range Android | Chrome | Required — the performance gate hinges on it |
| Recent iPhone | Safari | Required — the only WebKit engine |
| Windows laptop | Chrome, Edge, Firefox | Required |
| macOS | Safari | Required if desktop Safari matters |

## Per device

### Permission and capture
- [ ] The permission prompt appears only after tapping record, never on load
- [ ] Denying it produces a readable message with a way forward, not a dead end
- [ ] Denying then allowing in site settings recovers without a reload
- [ ] `getSettings()` reports the three processors as off (see
      `../benchmarks/capture-constraints.md`)
- [ ] Another app holding the microphone produces `mic_in_use`, not a crash

### Timing
- [ ] The count-in click is audible and lands on the beat
- [ ] Recording starts on the beat after the count-in, not late
- [ ] The metronome does not drift audibly over 60 s
- [ ] The beat dots stay in step with the click
- [ ] Muting the click leaves the visual count usable

### Recording
- [ ] The live waveform responds to the voice
- [ ] The timer counts and the bar fills
- [ ] Recording stops itself at 60 s
- [ ] Stopping early works, and re-recording immediately after works
- [ ] Backgrounding the app mid-take does not corrupt the result
- [ ] An incoming call, on a phone, does not corrupt the result

### Processing
- [ ] The progress bar reflects real progress rather than a fake sweep
- [ ] The UI stays responsive during inference — scroll while it runs
- [ ] Cancel actually stops it
- [ ] Which transcriber ran is visible in the details panel
- [ ] Offline on a first visit falls back to the tracker, with the warning shown

### Review and render
- [ ] The cleanup slider visibly moves notes in the piano roll
- [ ] Playback is audible and the playhead tracks it
- [ ] Every instrument previews, and only one plays at a time
- [ ] Render completes and the file opens in the platform's player

### Export
- [ ] The WAV plays in the OS player
- [ ] The MIDI opens in two different tools with the right tempo and notes
- [ ] A Persian filename survives the download
- [ ] Mobile download behaviour is sane — iOS Safari is the awkward one

### Bilingual and layout
- [ ] Persian is right-to-left throughout, with no stray left-aligned block
- [ ] Time still runs left-to-right in the waveform, piano roll and cleanup
      slider in **both** locales
- [ ] A long Persian title and a long English title both truncate cleanly
- [ ] Mixed BPM / note-name / filename strings read correctly
- [ ] Switching language mid-flow keeps the sketch

### Touch and accessibility
- [ ] Record and tap targets are reachable one-handed
- [ ] Nothing important sits under the notch or the home indicator
- [ ] The on-screen keyboard, when naming a sketch, does not cover the field
- [ ] 3D does not swallow taps or cause accidental scrolling
- [ ] With reduced motion on, the interface is calm and still complete
- [ ] VoiceOver / TalkBack can reach and operate record, stop and cleanup
- [ ] At 200% zoom nothing overlaps

## Recording the result

Fill this in per device and keep it with the release.

| Device | Date | Passed | Failed | Notes |
|---|---|---|---|---|
| — | — | — | — | — |

Any failure in a Required row is a release blocker under Playbook §26.
