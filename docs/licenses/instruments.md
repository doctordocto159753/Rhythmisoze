# Instrument licence ledger

**US-0602.** Every sound the product can make, with its licence and provenance.
An instrument absent from `src/packages/synthesis/registry.ts` cannot be
selected, previewed, rendered or exported, so nothing can reach a user without
first appearing here. `auditRegistry()` checks the mechanical parts of this and
`tests/unit/synthesis.test.ts` fails the build if an entry is incomplete.

---

## Current sound source

All eleven instruments are voiced by the **procedural engine**
(`src/packages/synthesis/procedural.ts`) from the recipes in `voices.ts`. Those
recipes are original work in this repository, MIT-licensed with the rest of the
codebase. No third-party audio ships.

That makes provenance trivially clean and is one of the reasons the procedural
engine is the default (ADR-002). It also means **the instruments are synthesised
approximations rather than recordings**, which does not yet satisfy the
"realistic / acoustic" direction chosen in Q-D4.

| id | Name (en / fa) | Family | Mode | GM | Range | Licence | Source |
|---|---|---|---|---|---|---|---|
| `piano` | Piano / پیانو | keys | melody | 0 | 28–96 | MIT | Own recipe |
| `electric-piano` | Electric piano / پیانوی الکتریک | keys | melody | 4 | 28–96 | MIT | Own recipe |
| `acoustic-guitar` | Acoustic guitar / گیتار آکوستیک | strings | melody | 24 | 40–84 | MIT | Own recipe |
| `double-bass` | Bowed double bass / کنترباس آرشه‌ای | strings | melody | 43 | 28–62 | MIT | Own recipe |
| `strings` | String section / گروه زهی | strings | melody | 48 | 36–88 | MIT | Own recipe |
| `trumpet` | Trumpet / ترومپت | winds | melody | 56 | 52–84 | MIT | Own recipe |
| `saxophone` | Saxophone / ساکسیفون | reeds | melody | 65 | 44–80 | MIT | Own recipe |
| `harmonica` | Harmonica / سازدهنی | reeds | melody | 22 | 48–88 | MIT | Own recipe |
| `flute` | Flute / فلوت | winds | melody | 73 | 59–96 | MIT | Own recipe |
| `marching-drum` | Marching drum / طبل رژه | percussion | rhythm | — | 35–46 | MIT | Own recipe |
| `trap-kit` | Trap kit / کیت ترپ | percussion | rhythm | — | 35–46 | MIT | Own recipe |

Nine melody instruments against the PRD's minimum of eight (S-01), plus the two
kits the PRD names.

## Sample packs

**None ship.** Every registry entry has `samplePack: null`, and the test suite
asserts that `SampleEngine.supports()` is false for all of them, so this state
cannot drift silently.

When packs are added, each one gets a row here before it is referenced from the
registry:

| id | Pack | Bytes | Licence | Source | Attribution required |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

### Candidate sources, unverified

Listed as leads for the follow-up in ADR-002, not as approvals. Each needs its
licence read against commercial intent before use:

- **VSCO-2 Community Edition** — CC0. The PRD names it. Broad orchestral
  coverage; recording quality varies by instrument.
- **Philharmonia Orchestra samples** — CC BY-NC. The non-commercial clause has
  to be reconciled with any paid tier before this is usable.
- **Sonatina Symphonic Orchestra** — CC Sampling Plus 1.0. Older, but
  well-organised and widely used.
- **FluidR3_GM** — MIT. The PRD names it. Complete GM coverage; ~150 MB total,
  so it would need per-instrument extraction.

### Rules for adding a pack

1. Record the exact source URL, licence identifier and any required attribution
   in the table above, before writing any code.
2. Put the audio under `public/instruments/<id>/` with a `manifest.json` in the
   format documented in `src/packages/synthesis/sample.ts`.
3. Set `samplePack` and `samplePackBytes` on the registry entry. Nothing else
   changes — the engine selection in `render.ts` picks it up automatically.
4. If the licence requires attribution, it must appear in the product UI, not
   only in this file.

## Other audio assets

| Asset | Where | Licence | Notes |
|---|---|---|---|
| Metronome click | `metronome.ts` | MIT (own) | Synthesised square-wave click; no file |
| Reverb impulse | `render.ts` | MIT (own) | Generated from a seeded noise decay; no file |
| Preview patterns | `registry.ts` | MIT (own) | Note sequences, not audio |

Nothing in the product plays a recorded sound that was not made by the code in
this repository.
