# Instrument licence ledger

Every sound must be registered here and in
`src/packages/synthesis/registry.ts` before it can reach playback or export.
`tests/synthesis/manifest.test.ts` verifies that every shipped zone exists,
matches its declared byte count and SHA-256, and agrees with the registry
licence.

## Recorded sample packs

| Product ids | Pack directories | Bytes | Licence | Source and pinned revision | Attribution | Redistribution |
|---|---|---:|---|---|---|---|
| `piano`, `acoustic-guitar`, `violin`, `cello`, `trumpet` | `warm-grand`, `cedar-steel`, `tender-violin`, `deep-cello`, `midnight-trumpet` | 5,273,650 | CC BY 3.0 | [FluidR3_GM browser files](https://github.com/gleitz/midi-js-soundfonts/tree/gh-pages/FluidR3_GM), commit `044fab8e1456bfafc5776e86dfd6bb8697149aef` | Required: “FluidR3_GM by Frank Wen; browser files prepared by Benjamin Gleitzman.” | Permitted with attribution |
| `acoustic-kit` | `live-room-kit` | 3,860,656 | CC0 1.0 | [VSCO 2 Community Edition](https://github.com/sgossner/VSCO-2-CE), commit `440300901dfe9275fd84e0b7763af1f8443ae62e` | Not required; courtesy credit retained in the manifest | Permitted without restriction |

FluidR3_GM files are copied from the repository's per-instrument MP3 output,
not fetched from that host at runtime. VSCO kit files are copied from the raw
WAV library. All files are served from `public/instruments/` on the same origin
as Rhythmisoze.

### FluidR3_GM attribution

FluidR3_GM by Frank Wen. Browser-ready files prepared by Benjamin Gleitzman and
contributors to `midi-js-soundfonts`. Licensed under Creative Commons
Attribution 3.0 Unported. Rhythmisoze selects and redistributes unmodified note
files in per-instrument packs.

### VSCO 2 CE courtesy credit

Recorded by Sam Gossner and Simon Dalzell; sample cutting by Elan
Hickler/Soundemote. Dedicated to the public domain under CC0 1.0.

## Procedural fallback

Every registered instrument also has a fallback voice in
`src/packages/synthesis/voices.ts`. These recipes and generated noise/reverb are
original Rhythmisoze work distributed under the repository MIT licence. No
recorded user audio is part of an instrument pack.

## Maintainer rules

1. Pin upstream revisions in `scripts/sync-instrument-packs.mjs`.
2. Record source URL, SPDX id, attribution requirement and redistribution
   permission in both registry and manifest.
3. Run `npm run instruments:sync`; never hand-replace one zone.
4. Run `npm test -- --run tests/synthesis` and review the exact Git diff.
5. New packs must stay lazy and must not broaden this product into General MIDI.
