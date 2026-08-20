# Instrument packs

Rhythmisoze uses a hybrid instrument engine: recorded sample packs for the six
acoustic MVP sounds and deterministic procedural voices for additional colours
and fallback.

## Runtime path

```text
NoteEvent[]
  -> registry definition
  -> sample prepare (preferred)
       -> manifest validation
       -> concurrent same-origin fetch/decode
       -> decoded tab cache
  -> procedural prepare (fallback)
  -> PreparedInstrument
  -> shared realtime/offline scheduler
  -> master bus
  -> playback or WAV
```

The stable note events and MIDI export do not change when the sound source
changes. Initial page load does not call `/instruments/`; explicit selection,
preview, playback or render does.

## Manifest v2

Each `public/instruments/<pack>/manifest.json` contains:

- `id`, `name`, `type: "sample"`
- complete licence/provenance and redistribution fields
- `playback.mode` (`natural` or `gated`), release and render tail
- a simple `samples` map for inspection
- validated `zones` with file, root/range, velocity bounds, optional drum class,
  round-robin index, byte count and SHA-256

The runtime rejects absolute paths, traversal, invalid MIDI/velocity ranges,
unknown licences, empty packs and mismatched pack ids before audio is decoded.

## Quality and fallback

Desktop and normally capable devices choose sample sound. Devices reporting at
most 2 GB memory or 2 logical cores choose the procedural fallback. Any network,
manifest or decode failure also falls back without mutating the note sequence.
Mobile performance is a non-blocking release concern for this desktop-first
phase.

## Rebuild

```bash
npm run instruments:sync
npm test -- --run tests/synthesis
```

The sync script is idempotent, pins upstream commits, and does no network work
when all local sample files already exist.
