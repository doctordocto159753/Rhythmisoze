# Dependency ledger

**Playbook §24.** Before adding a dependency, record its purpose, bundle impact,
maintenance status, licence, browser compatibility, and why a native API or an
existing dependency is not enough. This is that record.

The general position: this project prefers writing forty lines over adding a
package, and the "why not native" column is the one that decided most of these.
An FFT, a WAV encoder, a YIN tracker, an onset detector, a rate limiter and a
migration runner are all implemented here rather than installed.

---

## Runtime dependencies

| Package | Version | Licence | Purpose | Why not native / existing |
|---|---|---|---|---|
| `next` | 16.3.1 | MIT | App Router, routing, server rendering, bundling, image/OG generation | The PRD selects the platform. Pinned exactly rather than to v15 per the package's 2026 correction. |
| `react` / `react-dom` | 19.2.8 | MIT | UI runtime | Required by Next. |
| `@spotify/basic-pitch` | 1.0.1 | Apache-2.0 | Audio→MIDI transcription, the PRD's primary path (T-01) | The whole point of the client-first architecture. Dynamically imported; absent from the initial bundle. |
| `@tensorflow/tfjs` | 4.22.0 | Apache-2.0 | Runtime for the above | basic-pitch declares `^3.2.0`, but 3.x no longer resolves cleanly (`tfjs-core` missing). See ADR-001. |
| `@tonejs/midi` | 2.0.28 | MIT | Standard MIDI File read and write | Writing a conformant SMF with tempo and time-signature meta events is more subtlety than it looks, and this is the PRD's choice. |
| `dexie` | 4.4.5 | Apache-2.0 | IndexedDB wrapper for the local workspace | Raw IndexedDB is usable but its transaction and versioning ergonomics invite exactly the bugs that lose a user's work. |
| `zod` | 4.4.3 | MIT | Server-side request validation | Hand-written validators for the publish endpoints would be the place a security hole hides. |
| `postgres` | 3.4.9 | Unlicense | PostgreSQL client | One table, four queries. An ORM would add a build step and generated types for no benefit at this size. |
| `@vercel/blob` | 2.8.0 | Apache-2.0 | Direct client upload to object storage | The only supported way to keep a 10 MB WAV out of a Function body (4.5 MB limit). |
| `three` | 0.185.1 | MIT | WebGL renderer for the resonating body | Only loaded on the record screen, only above the `minimal` tier. |
| `@react-three/fiber` | 9.7.0 | MIT | React integration for the above | The design package names it. Avoids a hand-rolled imperative bridge between React state and a scene graph. |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 | Latin typeface | Self-hosted so the CSP stays closed to font CDNs. |
| `@fontsource-variable/vazirmatn` | 5.3.0 | OFL-1.1 | Persian typeface | Same. Persian must not fall back to a system face (D-0101). |

## Development dependencies

| Package | Version | Licence | Purpose |
|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | Strict-mode typechecking. Not 7.x: its Next.js compatibility is unverified. |
| `eslint` | 9.39.5 | MIT | Linting |
| `eslint-config-next` | 16.3.1 | MIT | Next.js and React rules, including the React Compiler checks |
| `typescript-eslint` | 8.48.1 | MIT | The `no-explicit-any` rule that enforces Playbook §23 |
| `vitest` | 4.1.11 | MIT | Unit tests. Runs the audio and retouch packages in Node, no browser needed. |
| `@vitest/coverage-v8` | 4.1.11 | MIT | Coverage |
| `@playwright/test` | 1.62.1 | Apache-2.0 | The browser matrix (US-1203) |
| `@types/*` | — | MIT | Type definitions |

## Bundled data assets

| Asset | Size | Licence | Source |
|---|---|---|---|
| `public/models/basic-pitch/model.json` | 174 KB | Apache-2.0 | `@spotify/basic-pitch@1.0.1`, copied by `scripts/sync-model.mjs` |
| `public/models/basic-pitch/group1-shard1of1.bin` | 742 KB | Apache-2.0 | Same |

The model is self-hosted rather than fetched from a CDN so that the CSP stays
closed, the version is pinned to the lockfile rather than to whatever a CDN
serves, and a returning visitor gets it from the HTTP cache with no cross-origin
request. `version.json` alongside it records which package version produced it.

## Python, development only

`numpy` and `pretty_midi` are needed only to regenerate the golden fixtures from
`reference/humtool.py`. The fixtures are committed, so a clean checkout builds
and tests without Python. CI installs them for the parity job, which is what
keeps the port honest.

## Deliberately not added

| Not added | Why |
|---|---|
| Tailwind CSS / shadcn/ui | ADR-003 |
| Storybook | DD-003 |
| An FFT library | 40 lines in `fft.ts`, and it is the piece most worth having under direct test |
| A WAV encoder | A RIFF header is 44 bytes of `DataView` calls |
| A rate limiter (Redis, Upstash) | The in-memory limiter is honest about its per-instance scope; a real one belongs in front of the route |
| A migration framework | `scripts/migrate.mjs` is 40 lines and idempotent |
| Tone.js | The playbook allows it only where its transport abstractions materially simplify things. The metronome needs sample-accurate scheduling, which is a lookahead loop either way, and the synth engine is already an adapter. |
| An error tracker | Q-G3 unanswered. Recommended before public release. |
