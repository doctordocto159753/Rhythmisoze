'use client';

import { useCallback, useRef, useState } from 'react';
import type {
  CreationMode,
  DrumEvent,
  LocalSourceAsset,
  Meter,
  NoteEvent,
} from '@contracts';
import { toAppError } from '@contracts';
import { melodyToMidi, rhythmToMidi, toSafeFilename, toSafeFilenameStem } from '@midi';
import { getInstrument } from '@synthesis';
import { Button } from '@/components/Button';
import { Row, Stack, Well } from '@/components/Layout';
import { Bdi, Text } from '@/components/Text';
import { track } from '@/features/analytics/track';
import { useLocale } from '@/i18n/provider';
import { createExportArchive } from '@/packages/export/archive';

export interface ExportPanelProps {
  title: string;
  mode: CreationMode;
  bpm: number;
  meter: Meter;
  instrumentId: string;
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  renderedAudio: Blob | null;
  source: LocalSourceAsset | null;
  cleanupLabel: string;
  onRender(): Promise<Blob | null>;
  onError(error: unknown): void;
}

type BusyExport = 'package' | 'wav' | 'midi' | null;

/**
 * US-0901..US-0903 / D-0602 - the export moment.
 *
 * The complete package is the focal delivery object: rendered audio, editable
 * notes, a deterministic manifest and, when present, the exact source bytes.
 * WAV and MIDI remain available as quiet individual downloads for people who
 * already know which file they need.
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
  source,
  cleanupLabel,
  onRender,
  onError,
}: ExportPanelProps) {
  const { locale, t } = useLocale();
  const [busy, setBusy] = useState<BusyExport>(null);
  const archiveInFlight = useRef(false);

  const instrument = getInstrument(instrumentId);
  const instrumentName = instrument?.name[locale] ?? instrumentId;
  const gmProgram = instrument?.gmProgram ?? 0;
  const effectiveTitle = title.trim() || t.workspace.untitled;
  const safeSourceFilename = source ? toSafeOriginalFilename(source.filename) : null;

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

  const createMidi = useCallback((): Blob => {
    const options = {
      bpm,
      meter,
      title: effectiveTitle,
      program: gmProgram,
      instrumentName,
    };
    const bytes = mode === 'rhythm' ? rhythmToMidi(drums, options) : melodyToMidi(notes, options);
    return new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
  }, [bpm, meter, effectiveTitle, gmProgram, instrumentName, mode, drums, notes]);

  const downloadPackage = useCallback(async () => {
    // State-driven disabled styling arrives on the next render. This ref closes
    // the smaller same-frame window in which a double click could start a
    // second render/archive job.
    if (archiveInFlight.current) return;
    archiveInFlight.current = true;
    setBusy('package');

    try {
      const wav = renderedAudio ?? (await onRender());
      if (wav === null) return;
      const midi = createMidi();
      const manifest = {
        schemaVersion: 1,
        title: effectiveTitle,
        mode,
        bpm,
        meter: {
          beatsPerBar: meter.beatsPerBar,
          beatUnit: meter.beatUnit,
        },
        instrumentId,
        instrumentName,
        cleanupLabel,
        source: source
          ? {
              kind: source.kind,
              filename: source.filename,
              mimeType: source.mimeType,
              bytes: source.blob.size,
            }
          : null,
      };
      const entries = [
        { name: 'rendered.wav', data: wav },
        { name: 'notes.mid', data: midi },
        ...(source && safeSourceFilename
          ? [{ name: `source/${safeSourceFilename}`, data: source.blob }]
          : []),
        { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
      ];
      const archive = await createExportArchive(entries);
      download(archive, toSafeFilename(effectiveTitle, 'zip'));
    } catch (error) {
      onError(toAppError(error, 'export_failed', 'retry'));
    } finally {
      archiveInFlight.current = false;
      setBusy(null);
    }
  }, [
    renderedAudio,
    onRender,
    createMidi,
    effectiveTitle,
    mode,
    bpm,
    meter,
    instrumentId,
    instrumentName,
    cleanupLabel,
    source,
    safeSourceFilename,
    download,
    onError,
  ]);

  const downloadWav = useCallback(async () => {
    if (busy !== null) return;
    setBusy('wav');
    try {
      // Re-render only when the cached result was invalidated by a change.
      const blob = renderedAudio ?? (await onRender());
      if (blob === null) return;
      download(blob, toSafeFilename(effectiveTitle, 'wav'));
      track('download_wav', { mode, instrument: instrumentId });
    } catch (error) {
      onError(toAppError(error, 'export_failed', 'retry'));
    } finally {
      setBusy(null);
    }
  }, [busy, renderedAudio, onRender, download, effectiveTitle, mode, instrumentId, onError]);

  const downloadMidi = useCallback(() => {
    if (busy !== null) return;
    setBusy('midi');
    try {
      download(createMidi(), toSafeFilename(effectiveTitle, 'mid'));
      track('download_midi', { mode, instrument: instrumentId });
    } catch (error) {
      onError(toAppError(error, 'export_failed', 'retry'));
    } finally {
      setBusy(null);
    }
  }, [busy, createMidi, download, effectiveTitle, mode, instrumentId, onError]);

  const downloadSource = useCallback(() => {
    if (!source || !safeSourceFilename || busy !== null) return;
    download(source.blob, safeSourceFilename);
  }, [source, safeSourceFilename, busy, download]);

  const hasContent = mode === 'rhythm' ? drums.length > 0 : notes.length > 0;
  const exportsDisabled = !hasContent || busy !== null;

  return (
    <Well as="section" aria-labelledby="export-heading">
      <Stack gap={5}>
        <Stack gap={1}>
          <Text variant="heading" as="h3" id="export-heading">
            {t.exportPanel.title}
          </Text>
          <Text variant="micro" muted>
            {t.exportPanel.renderedWith(instrumentName, cleanupLabel)}
          </Text>
        </Stack>

        <Well tone="accent" padding="tight">
          <Stack gap={3}>
            <Stack gap={1}>
              <Text variant="heading" as="h4">
                {t.exportPanel.package}
              </Text>
              <Text variant="micro" muted>
                {t.exportPanel.packageHint}
              </Text>
            </Stack>

            <Well padding="tight">
              <Stack gap={2}>
                <Text variant="label" as="h5">
                  {t.exportPanel.packageContents}
                </Text>
                <Row gap={3} justify="between">
                  <Text variant="micro" as="span">
                    {t.exportPanel.renderedAudio}
                  </Text>
                  <Text variant="micro" as="span" muted>
                    {instrumentName}
                  </Text>
                </Row>
                <Row gap={3} justify="between">
                  <Text variant="micro" as="span">
                    {t.exportPanel.editableNotes}
                  </Text>
                  <Text variant="micro" as="span" muted>
                    MIDI
                  </Text>
                </Row>
                {source ? (
                  <Row gap={3} justify="between">
                    <Text variant="micro" as="span">
                      {t.exportPanel.original}
                    </Text>
                    <Text variant="micro" as="span" muted>
                      <Bdi>{source.filename}</Bdi> · {t.exportPanel.untouched}
                    </Text>
                  </Row>
                ) : null}
              </Stack>
            </Well>

            <Button
              kind="accent"
              size="large"
              block
              busy={busy === 'package'}
              disabled={exportsDisabled}
              onClick={() => void downloadPackage()}
            >
              {t.exportPanel.downloadPackage}
            </Button>
          </Stack>
        </Well>

        <Stack gap={3}>
          <Text variant="label" as="h4">
            {t.exportPanel.individualFiles}
          </Text>

          <Row gap={3} align="start">
            <Stack gap={2} grow>
              <Button
                kind="quiet"
                block
                busy={busy === 'wav'}
                disabled={exportsDisabled}
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
                disabled={exportsDisabled}
                onClick={downloadMidi}
              >
                {t.exportPanel.midi}
              </Button>
              <Text variant="micro" muted>
                {t.exportPanel.midiHint}
              </Text>
            </Stack>

            {source ? (
              <Stack gap={2} grow>
                <Button kind="quiet" block disabled={busy !== null} onClick={downloadSource}>
                  {t.exportPanel.original}
                </Button>
                <Text variant="micro" muted>
                  {t.exportPanel.originalHint}
                </Text>
              </Stack>
            ) : null}
          </Row>
        </Stack>

        <Stack gap={1}>
          <Text variant="micro" muted>
            {t.exportPanel.sourcePrivacy}
          </Text>
          <Text variant="micro" muted>
            {t.exportPanel.noWatermark}
          </Text>
        </Stack>
      </Stack>
    </Well>
  );
}

/**
 * Keeps a source's real extension while removing path separators, control and
 * bidi characters before it reaches either `download` or a ZIP entry name.
 */
function toSafeOriginalFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const extension = cleaned.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? '';
  const stem = extension ? cleaned.slice(0, -extension.length) : cleaned;
  return `${toSafeFilenameStem(stem, 'source')}${extension}`;
}
