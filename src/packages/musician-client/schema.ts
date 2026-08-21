/**
 * The network boundary.
 *
 * These schemas mirror the Pydantic contract in
 * `services/musician/shared/src/musician_shared/contract.py`. Two independent
 * definitions of one shape will drift; `tests/unit/musician-contract.test.ts`
 * reads the Python file and fails when they do, which is the cheapest honest
 * way to keep them together short of generating one from the other.
 *
 * ## Why parse rather than cast
 *
 * `await response.json() as MusicianResult` is a lie the type system agrees to.
 * The response comes from a service that runs generative models; the failure
 * mode is not "the field is missing" but "the field is there and contains a
 * pitch of 4096, or a note that ends before it starts". Casting turns that into
 * a corrupted piano roll several layers away from the cause.
 *
 * So everything is parsed, and the ranges are the real musical ranges rather
 * than `z.number()`. A malformed response is a normal, handled outcome: the
 * user keeps the Teacher version and is offered a retry.
 */

import { z } from 'zod';

/** Matches MIN_MIDI_PITCH..MAX_MIDI_PITCH in contract.py. */
const midiPitch = z.number().int().min(0).max(127);

export const noteSchema = z
  .object({
    pitch: midiPitch,
    start_sec: z.number().finite().min(0),
    end_sec: z.number().finite().positive(),
    velocity: z.number().int().min(1).max(127),
  })
  .refine((note) => note.end_sec > note.start_sec, {
    message: 'note ends before it starts',
  });

export const tempoSchema = z.object({
  bpm: z.number().finite().gt(10).lt(400),
  confidence: z.number().min(0).max(1),
});

export const meterSchema = z.object({
  numerator: z.number().int().min(1).max(32),
  denominator: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(16),
    z.literal(32),
  ]),
  confidence: z.number().min(0).max(1),
});

export const keySchema = z.object({
  tonic: z.string().min(1).max(3),
  mode: z.union([z.literal('major'), z.literal('minor')]),
  confidence: z.number().min(0).max(1),
});

export const identityReportSchema = z.object({
  contour_similarity: z.number(),
  motif_survival: z.number(),
  phrase_similarity: z.number(),
  tonal_compatibility: z.number(),
  meter_compatibility: z.number(),
  duration_ratio: z.number(),
  pitch_range_change: z.number(),
  note_density_change: z.number(),
  aggregate: z.number(),
  passed: z.boolean(),
  failures: z.array(z.string()),
});

export const infillSpanSchema = z.object({
  start_index: z.number().int().min(0),
  end_index: z.number().int().min(0),
  reason: z.string(),
});

export const variantSchema = z.object({
  kind: z.union([z.literal('refined'), z.literal('developed'), z.literal('expanded')]),
  // A variant with no notes is not a variant. Catching it here means the review
  // screen never has to render an empty version it was told exists.
  notes: z.array(noteSchema).min(1),
  tempo: tempoSchema,
  meter: meterSchema,
  key: keySchema.nullable(),
  duration_sec: z.number().finite().positive(),
  identity: identityReportSchema,
  infill_spans: z.array(infillSpanSchema),
  /**
   * The service refused: nothing survived the Identity Guard and these notes are
   * the Teacher's, unchanged.
   *
   * Defaulted rather than required so an older service still parses. It has to
   * be read, not merely carried: without it a refusal is indistinguishable from
   * a generation — same notes as the Teacher, `identity.passed` true (the guard
   * compared the Teacher against itself), `kind` still `refined`. Showing that
   * as the Musician's work is exactly the failure the guard exists to prevent.
   */
  source_fallback: z.boolean().default(false),
});

export const provenanceSchema = z.object({
  melody_t5_revision: z.string(),
  midi_rwkv_revision: z.string(),
  musician_service_version: z.string(),
  input_fingerprint: z.string(),
  seeds: z.record(z.string(), z.number()),
  parameters: z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))),
  elapsed_ms: z.number().int().min(0),
});

export const diagnosticsSchema = z.object({
  candidate_counts: z.record(z.string(), z.number()),
  rejected_candidates: z.array(
    z.object({
      stage: z.string(),
      seed: z.number(),
      accepted: z.boolean(),
      identity_aggregate: z.number(),
      rejection_reasons: z.array(z.string()),
    }),
  ),
  identity_guard_summary: z.record(z.string(), z.number()),
});

export const musicianResultSchema = z.object({
  version: z.literal(1),
  source_id: z.string(),
  refined: variantSchema,
  developed: variantSchema,
  expanded: variantSchema,
  provenance: provenanceSchema,
  diagnostics: diagnosticsSchema,
});

/**
 * Job states as the service reports them.
 *
 * The UI has more states than this (see `JobPhase`), because "running" is one
 * thing to a queue and two things to a person waiting.
 */
export const jobStateSchema = z.union([
  z.literal('pending'),
  z.literal('running'),
  z.literal('succeeded'),
  z.literal('failed'),
  z.literal('cancelled'),
]);

export const jobStatusSchema = z.object({
  jobId: z.string().min(1),
  state: jobStateSchema,
  createdAt: z.number().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  result: musicianResultSchema.optional(),
  error: z.string().optional(),
});

export const jobAcceptedSchema = z.object({
  jobId: z.string().min(1),
  state: jobStateSchema,
});

export type MusicianNote = z.infer<typeof noteSchema>;
export type MusicianVariant = z.infer<typeof variantSchema>;
export type MusicianResult = z.infer<typeof musicianResultSchema>;
export type MusicianJobStatus = z.infer<typeof jobStatusSchema>;
export type MusicianJobState = z.infer<typeof jobStateSchema>;
