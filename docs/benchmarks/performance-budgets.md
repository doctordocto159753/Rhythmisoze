# Performance budgets

**PRD §8, US-1204.** The targets, how each one is instrumented, and what has
actually been observed.

| Target | Value | Instrumented | Measured |
|---|---|---|---|
| Initial page load | < 2 s on 4G | Route sizes reported by `next build` | Not on a throttled profile |
| First model load | < 8 s | `ProcessingDiagnostics.modelLoadMs` | Not on device |
| Subsequent model load | from cache | `modelFromCache` flag | Not on device |
| Transcription | ≤ 0.5 × clip | `ProcessingDiagnostics.elapsedMs` | Not on device |
| Render | ≤ 0.25 × clip | `RenderResult.realtimeRatio`, returned on every render | Not on device |
| Main thread responsive during inference | required | Worker architecture | Not on device |

Every one of these is *reported* by the running app and sampled by telemetry
(US-1103), so the numbers become available as soon as there is a device to run
on. What is missing is the run, not the instrumentation.

## What the architecture already guarantees

Some of these are structural rather than hopeful:

- **Nothing heavy is in the initial bundle.** TensorFlow.js and Basic Pitch load
  by dynamic import inside a worker, and only when a take is processed. `three`
  and `@react-three/fiber` load by `next/dynamic` with `ssr: false`, and only on
  the record screen above the `minimal` tier. A visitor who reads the landing
  page and leaves downloads neither.
- **The model is 0.9 MB and self-hosted**, not the 20 MB the PRD assumed, and it
  comes from the same origin with normal HTTP caching.
- **The render is offline.** `OfflineAudioContext` runs as fast as the CPU
  allows, which is what makes a faster-than-real-time target reachable without
  special-casing.
- **The 3D scene is demand-driven.** It renders only while a value is still
  settling, so a still object costs nothing.
- **The default instruments have no assets at all.** First render works with no
  network.

## Where the risk actually is

Not in the page load. It is in **TensorFlow.js on a mid-range Android**: the
runtime is the large download, the backend selection inside a worker is
untested, and CPU inference on a 60 s clip is the one place the 0.5 × target
could plausibly fail. ADR-001 records this as the open gap, and the built-in
tracker exists so a failure there degrades rather than blocks.

## How to measure

```bash
npm run build          # route sizes and first-load JS per route
npx playwright test    # add a trace and read the timings
```

For device measurement, use the telemetry fields: they are already emitted with
`transcriber`, `ms` and a coarse device class, and carry no audio or note
content.

| Device | First load | Model load | Transcribe (30 s) | Render (30 s) |
|---|---|---|---|---|
| — | — | — | — | — |
