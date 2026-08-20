'use client';

import { useState, type ChangeEvent } from 'react';
import { Stack } from '@/components/Layout';
import { Text } from '@/components/Text';
import { useLocale } from '@/i18n/provider';
import styles from './SourceInput.module.css';

const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.webm,.flac';
const MIDI_ACCEPT = '.mid,.midi,audio/midi,audio/x-midi';

export interface SourceInputProps {
  tempoReady: boolean;
  onUploadAudio(file: File): Promise<void>;
  onUploadMidi(file: File): Promise<void>;
}

/**
 * The quiet alternative to the brass record action.
 *
 * These are native file inputs rather than a drop zone: browser file pickers
 * are familiar, keyboard-operable and honest about the kinds of files this
 * stage can read. The full input covers its tactile label, so focus and disabled
 * semantics still belong to the native control rather than a simulated button.
 */
export function SourceInput({
  tempoReady,
  onUploadAudio,
  onUploadMidi,
}: SourceInputProps) {
  const { t } = useLocale();
  const [busy, setBusy] = useState<'audio' | 'midi' | null>(null);

  const handleFile = async (
    event: ChangeEvent<HTMLInputElement>,
    kind: 'audio' | 'midi',
  ): Promise<void> => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setBusy(kind);
    try {
      if (kind === 'audio') await onUploadAudio(file);
      else await onUploadMidi(file);
    } finally {
      // Selecting the same file again should still fire `change` after a
      // recoverable import error.
      input.value = '';
      setBusy(null);
    }
  };

  const audioDisabled = !tempoReady || busy !== null;
  const midiDisabled = busy !== null;

  return (
    <section className={styles.root} aria-labelledby="source-input-heading">
      <Stack gap={3} align="center">
        <Text variant="label" as="h3" id="source-input-heading">
          {t.sourceInput.title}
        </Text>

        <div className={styles.actions}>
          <label
            className={[styles.action, audioDisabled ? styles.disabled : null]
              .filter(Boolean)
              .join(' ')}
            aria-disabled={audioDisabled}
          >
            <input
              className={styles.input}
              type="file"
              accept={AUDIO_ACCEPT}
              disabled={audioDisabled}
              aria-label={t.sourceInput.audioInputLabel}
              aria-busy={busy === 'audio' || undefined}
              onChange={(event) => void handleFile(event, 'audio')}
            />
            <span className={styles.actionTitle}>
              {busy === 'audio' ? t.sourceInput.reading : t.sourceInput.audio}
            </span>
            <span className={styles.actionHint}>
              {tempoReady ? t.sourceInput.audioReadyHint : t.sourceInput.audioNeedsTempo}
            </span>
          </label>

          <label
            className={[styles.action, midiDisabled ? styles.disabled : null]
              .filter(Boolean)
              .join(' ')}
            aria-disabled={midiDisabled}
          >
            <input
              className={styles.input}
              type="file"
              accept={MIDI_ACCEPT}
              disabled={midiDisabled}
              aria-label={t.sourceInput.midiInputLabel}
              aria-busy={busy === 'midi' || undefined}
              onChange={(event) => void handleFile(event, 'midi')}
            />
            <span className={styles.actionTitle}>
              {busy === 'midi' ? t.sourceInput.reading : t.sourceInput.midi}
            </span>
            <span className={styles.actionHint}>{t.sourceInput.midiHint}</span>
          </label>
        </div>
      </Stack>
    </section>
  );
}
