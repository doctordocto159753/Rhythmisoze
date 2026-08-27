/** Server-owned MIDI parse, canonicalization and musical routing. */

import { NextResponse, type NextRequest } from 'next/server';
import { importMidi, planMidiImport } from '@midi';
import { correctClassification } from '@intent';
import { buildMusicalPhraseModel } from '@/packages/musical-phrase';
import { analyzeDrumRhythm, analyzeMelodyRhythm } from '@rhythm-extraction';
import { AppError } from '@contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MIDI_BYTES = 5 * 1024 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const form = await request.formData();
    const file = form.get('midi');
    const correctionValue = form.get('correction');
    const correction = correctionValue === 'melody' || correctionValue === 'rhythm'
      ? correctionValue
      : undefined;
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ error: 'midi_invalid', detail: 'no MIDI file' }, { status: 400 });
    }
    if (file.size > MAX_MIDI_BYTES) {
      return NextResponse.json({ error: 'file_too_large', detail: 'MIDI over 5 MiB' }, { status: 413 });
    }

    const imported = importMidi(new Uint8Array(await file.arrayBuffer()));
    const plan = planMidiImport(imported, correction);
    const classification = correction
      ? correctClassification(plan.classification, correction)
      : plan.classification;
    const phraseModel = plan.mode === 'melody'
      ? buildMusicalPhraseModel(plan.notes, {
          sourceKind:
            classification.type === 'polyphonic' || classification.type === 'mixed'
              ? 'polyphonic'
              : 'symbolic',
          interpretationNotes: plan.judge?.notes ?? plan.notes,
        })
      : null;
    const rhythmAnalysis = plan.mode === 'rhythm'
      ? plan.drums.length > 0 ? analyzeDrumRhythm(plan.drums, imported.durationSec) : null
      : plan.notes.length > 0 ? analyzeMelodyRhythm(plan.notes, imported.durationSec) : null;

    return NextResponse.json({
      ...imported,
      mode: plan.mode,
      notes: plan.notes,
      drums: plan.drums,
      judge: plan.judge,
      phraseModel,
      rhythmAnalysis,
      classification,
      pitchedNotesAsRhythm: plan.pitchedNotesAsRhythm,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    return NextResponse.json(
      { error: appError?.code ?? 'midi_invalid', detail: appError?.detail ?? 'MIDI parse failed' },
      { status: 422 },
    );
  }
}
