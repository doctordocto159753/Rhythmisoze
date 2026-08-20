# ADR-002 — Hybrid sample and procedural instrument engine

**Status:** Accepted and implemented
**Date:** 2026-08-20
**Related:** US-0601–US-0607, US-INST-001–US-INST-010

## Context

Rhythmisoze must turn a vocal gesture into a convincing musical sketch without
changing the stable `NoteEvent` contract, uploading unpublished audio, or
blocking creation when a sound asset cannot be fetched. Procedural Web Audio
voices met reliability and privacy goals but not the chosen realistic/acoustic
quality direction.

## Decision

Use one public instrument abstraction over two implementations:

- `SampleEngine` is preferred for registered sample instruments. It uses
  same-origin, manifest-driven multisamples with per-note pitch zones, velocity
  layers, round robin, natural or gated release, concurrent decoding, progress,
  and an in-memory promise cache.
- `ProceduralEngine` remains available for every registry entry. It is the
  deterministic fallback when the pack is unavailable or the device is in the
  minimal synthesis tier.
- Realtime audition and `OfflineAudioContext` rendering use the same scheduling
  and master-bus path. The renderer sees only `PreparedInstrument`; it does not
  know whether a source is a decoded recording or an oscillator graph.
- Pack manifests are runtime-validated against the registry licence before any
  sample URL is fetched. Unsafe relative paths and malformed ranges fail closed.

The implementation stays browser-native instead of adding Tone.js. The existing
Web Audio sampler already supports the realtime/offline graph without an extra
runtime dependency, and this phase filled its quality and reliability gaps
rather than replacing one adapter with another.

## Pack decision

The focused MVP contains six recorded instruments:

1. Warm Grand
2. Cedar Steel acoustic guitar
3. Tender Violin
4. Deep Cello
5. Midnight Trumpet
6. Live Room acoustic kit

The five melodic packs are curated per-note browser files from FluidR3_GM. The
kit uses two velocity layers for kick/snare and round-robin shaker hits from
VSCO 2 Community Edition. Exact provenance, versions, byte counts and licence
obligations are in `docs/licenses/instruments.md`.

## Consequences

- Initial navigation fetches no instrument audio. Selection or preview starts
  only that pack, and later use reuses decoded buffers.
- A pack failure does not lose the user's notes or block WAV export; the same
  instrument id is voiced by its procedural fallback.
- Natural piano, guitar and drum decays increase offline render tail and memory
  use. Desktop is the release priority; the minimal device tier uses synth.
- Sample renders are not byte-identical across browser decoders. Structural WAV
  metadata and non-silence are regression-tested; procedural fallback remains
  deterministic.
- Subjective quality remains a human gate. The protocol is in
  `docs/instruments/listening-test.md`; no ≥4/5 claim is made without completed
  score sheets.

## Evidence

- `tests/synthesis/manifest.test.ts` audits every shipped file and SHA-256.
- `tests/synthesis/loading.test.ts` covers lazy loading, progress, cache and
  procedural fallback.
- `tests/synthesis/scheduling.test.ts` covers velocity layers and release.
- `tests/synthesis/wav-metadata.test.ts` snapshots the exported PCM contract.
- `tests/e2e/instruments.spec.ts` covers browser requests, progress, preview and
  rendered WAV on the real product path.
