import type { NoteEvent } from '@contracts';

export type QualityGuardReason =
  | 'agreement_drop'
  | 'register_shift'
  | 'dominant_note'
  | 'contour_change';

export interface MelodyQualityAssessment {
  triggered: boolean;
  reasons: QualityGuardReason[];
  rawAgreement: number;
  cleanedAgreement: number;
  registerShiftSemitones: number;
  dominantNoteRatio: number;
  directionAgreement: number;
}

/**
 * Compares a retouched melody with the independent monophonic contour. The
 * thresholds come from the human regression report and are intentionally
 * product-level invariants rather than cleanup-slider tuning constants.
 */
export function assessMelodyQuality(
  raw: readonly NoteEvent[],
  cleaned: readonly NoteEvent[],
  reference: readonly NoteEvent[],
): MelodyQualityAssessment {
  if (reference.length === 0) {
    return {
      triggered: false,
      reasons: [],
      rawAgreement: 1,
      cleanedAgreement: 1,
      registerShiftSemitones: 0,
      dominantNoteRatio: 0,
      directionAgreement: 1,
    };
  }

  const rawAgreement = pitchAgreement(raw, reference, 1);
  const cleanedAgreement = pitchAgreement(cleaned, reference, 1);
  const referenceCenter = durationWeightedMedianPitch(reference);
  const cleanedCenter = durationWeightedMedianPitch(cleaned);
  const registerShiftSemitones =
    Number.isFinite(referenceCenter) && Number.isFinite(cleanedCenter)
      ? Math.abs(cleanedCenter - referenceCenter)
      : Number.POSITIVE_INFINITY;
  const span = Math.max(...reference.map((note) => note.endSec)) -
    Math.min(...reference.map((note) => note.startSec));
  const dominantNoteRatio = dominantPitchRatio(cleaned, span);
  const directionAgreement = contourDirectionAgreement(cleaned, reference);
  const reasons: QualityGuardReason[] = [];
  if (cleanedAgreement < rawAgreement - 0.05 - 1e-6) reasons.push('agreement_drop');
  if (registerShiftSemitones > 6) reasons.push('register_shift');
  if (dominantNoteRatio > 0.6) reasons.push('dominant_note');
  if (directionAgreement < 1 - 1e-6) reasons.push('contour_change');

  return {
    triggered: reasons.length > 0,
    reasons,
    rawAgreement,
    cleanedAgreement,
    registerShiftSemitones,
    dominantNoteRatio,
    directionAgreement,
  };
}

/** Fraction of voiced reference time covered within the pitch tolerance. */
export function pitchAgreement(
  candidate: readonly NoteEvent[],
  reference: readonly NoteEvent[],
  toleranceSemitones = 1,
): number {
  let voiced = 0;
  let agreed = 0;
  for (const guide of reference) {
    const duration = Math.max(0, guide.endSec - guide.startSec);
    if (duration === 0) continue;
    voiced += duration;
    const intervals = candidate
      .filter((note) => Math.abs(note.pitch - guide.pitch) <= toleranceSemitones)
      .map((note) => [Math.max(guide.startSec, note.startSec), Math.min(guide.endSec, note.endSec)] as const)
      .filter(([start, end]) => end > start)
      .sort((a, b) => a[0] - b[0]);
    let cursor = guide.startSec;
    for (const [start, end] of intervals) {
      const from = Math.max(cursor, start);
      if (end > from) agreed += end - from;
      cursor = Math.max(cursor, end);
    }
  }
  return voiced > 0 ? Math.max(0, Math.min(1, agreed / voiced)) : 1;
}

export function durationWeightedMedianPitch(notes: readonly NoteEvent[]): number {
  const weighted = notes
    .map((note) => ({ pitch: note.pitch, weight: Math.max(0, note.endSec - note.startSec) }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => a.pitch - b.pitch);
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (total === 0) return Number.NaN;
  let elapsed = 0;
  for (const item of weighted) {
    elapsed += item.weight;
    if (elapsed >= total / 2) return item.pitch;
  }
  return (weighted.at(-1) as { pitch: number }).pitch;
}

function dominantPitchRatio(notes: readonly NoteEvent[], durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  const totals = new Map<number, number>();
  for (const note of notes) {
    const duration = Math.max(0, note.endSec - note.startSec);
    totals.set(note.pitch, (totals.get(note.pitch) ?? 0) + duration);
  }
  const longest = Math.max(0, ...totals.values());
  return Math.max(0, Math.min(1, longest / durationSec));
}

function contourDirectionAgreement(
  candidate: readonly NoteEvent[],
  reference: readonly NoteEvent[],
): number {
  if (reference.length < 2) return 1;
  const aligned = reference.map((guide) => {
    let best: { pitch: number; overlap: number } | null = null;
    for (const note of candidate) {
      const overlap = Math.max(
        0,
        Math.min(guide.endSec, note.endSec) - Math.max(guide.startSec, note.startSec),
      );
      if (overlap > (best?.overlap ?? 0)) best = { pitch: note.pitch, overlap };
    }
    return best?.pitch ?? Number.NaN;
  });
  let compared = 0;
  let matched = 0;
  for (let index = 1; index < reference.length; index += 1) {
    const previousReference = reference[index - 1];
    const currentReference = reference[index];
    const previousCandidate = aligned[index - 1];
    const currentCandidate = aligned[index];
    if (!previousReference || !currentReference) continue;
    compared += 1;
    if (
      Number.isFinite(previousCandidate) &&
      Number.isFinite(currentCandidate) &&
      Math.sign((currentCandidate as number) - (previousCandidate as number)) ===
        Math.sign(currentReference.pitch - previousReference.pitch)
    ) {
      matched += 1;
    }
  }
  return compared > 0 ? matched / compared : 1;
}
