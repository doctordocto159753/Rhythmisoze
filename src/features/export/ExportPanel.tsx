'use client';

import { useCallback, useState } from 'react';
import type { CreationMode, DrumEvent, Meter, NoteEvent } from '@contracts';
import { toAppError } from '@contracts';
import { melodyToMidi, rhythmToMidi, toSafeFilename } from '@midi';
import { getInstrument } from '@synthesis';
import { Button } from '@/components/Button';
import { Row, Stack, Well } from '@/components/Layout';
import { Text } from '@/components/Text';
import { track } from '@/features/analytics/track';
import { useLocale } from '@/i18n/provider';

export interface ExportPanelProps {
  title: string;
  mode: CreationMode;
  bpm: number;
  meter: Meter;
  instrumentId: string;
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  renderedAudio: Blob | null;
  cleanupLabel: string;
  onRender(): Promise<Blob | null>;
  onError(error: unknown): void;
}

/**
 * US-0901..US-0903 / D-0602 - the export moment.
 *
 * Two files, described by what they are for rather than by their format: an
 * audio file you can send to someone, and a note file you can open in music
 * software. "WAV" and "MIDI" still appear, because a user who knows those words
 * needs to see them, but they are the subtitle rather than the label.
 *
 * No account gate, no upsell, nothing between the user and their file - the
 * story is explicit about that.
 */
export function ExportPanel({
  title,
  mode,
  bpm,
  meter,
  instrumentId,
  notes,
  drums,
  renderedAudio,
  cleanupLabel,
  onRender,
  onError,
}: ExportPanelProps) {
  const { locale, t } = useLocale();
  const [busy, setBusy] = useState<'wav' | 'midi' | null>(null);

  const instrument = getInstrument(instrumentId);
  const instrumentName = instrument?.name[locale] ?? instrumentId;
  const effectiveTitle = title.trim() || t.workspace.untitled;

  const download = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking immediately can cancel the download on some mobile browsers;
    // one turn of the event loop is enough for the navigation to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const downloadWav = useCallback(async () => {
    setBusy('wav');
    try {
      // Re-render only when the cached result was invalidated by a change.
      const blob = renderedAudio ?? await onRender();
      if (blob === null) return;
      download(blob, toSafeFilename(effectiveTitle, 'wav'));
      track('download_wav', { mode, instrument: instrumentId });
    } catch (error) {
      onError(toAppError(error, 'export_failed', 'retry'));
    } finally {
      setBusy(null);
    }
  }, [renderedAudio, onRender, download, effectiveTitle, mode, instrumentId, onError]);

  const downloadMidi = useCallback(() => {
    setBusy('midi');
    try {
      const options = {
        bpm,
        meter,
        title: effectiveTitle,
        program: instrument?.gmProgram ?? 0,
        instrumentName,
      };
      const bytes =
        mode === 'rhythm' ? rhythmToMidi(drums, options) : melodyToMidi(notes, options);
      download(
        new Blob([new Uint8Array(bytes)], { type: 'audio/midi' }),
        toSafeFilename(effectiveTitle, 'mid'),
      );
      track('download_midi', { mode, instrument: instrumentId });
    } catch (error) {
      onError(toAppError(error, 'export_failed', 'retry'));
    } finally {
      setBusy(null);
    }
  }, [
    bpm,
    meter,
    effectiveTitle,
    instrument,
    instrumentName,
    mode,
    drums,
    notes,
    download,
    instrumentId,
    onError,
  ]);

  const hasContent = mode === 'rhythm' ? drums.length > 0 : notes.length > 0;

  return (
    <Well as="section" aria-labelledby="export-heading">
      <Stack gap={4}>
        <Stack gap={1}>
          <Text variant="heading" as="h3" id="export-heading">
            {t.exportPanel.title}
          </Text>
          <Text variant="micro" muted>
            {t.exportPanel.renderedWith(instrumentName, cleanupLabel)}
          </Text>
        </Stack>

        <Row gap={4} align="start">
          <Stack gap={2} grow>
            <Button
              kind="primary"
              block
              busy={busy === 'wav'}
              disabled={!hasContent}
              onClick={() => void downloadWav()}
            >
              {t.exportPanel.wav}
            </Button>
            <Text variant="micro" muted>
              {t.exportPanel.wavHint}
            </Text>
          </Stack>

          <Stack gap={2} grow>
            <Button
              kind="quiet"
              block
              busy={busy === 'midi'}
              disabled={!hasContent}
              onClick={downloadMidi}
            >
              {t.exportPanel.midi}
            </Button>
            <Text variant="micro" muted>
              {t.exportPanel.midiHint}
            </Text>
          </Stack>
        </Row>

        {/* PRD 6.6 is explicit that no watermark is added; saying so is part of
            the trust claim, not decoration. */}
        <Text variant="micro" muted>
          {t.exportPanel.noWatermark}
        </Text>
      </Stack>
    </Well>
  );
}
