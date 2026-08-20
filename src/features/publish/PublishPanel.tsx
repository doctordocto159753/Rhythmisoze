'use client';

import { useCallback, useState } from 'react';
import type { CreationMode, DrumEvent, Meter, NoteEvent, PublishReceipt } from '@contracts';
import { AppError, toAppError } from '@contracts';
import { melodyToMidi, rhythmToMidi } from '@midi';
import { getInstrument } from '@synthesis';
import { Button } from '@/components/Button';
import { Row, Stack, Well } from '@/components/Layout';
import { Bdi, Text } from '@/components/Text';
import { track } from '@/features/analytics/track';
import { forgetManageToken, getManageToken, rememberManageToken } from './manageTokens';
import { useLocale } from '@/i18n/provider';

export interface PublishPanelProps {
  enabled: boolean;
  title: string;
  mode: CreationMode;
  bpm: number;
  meter: Meter;
  instrumentId: string;
  notes: readonly NoteEvent[];
  drums: readonly DrumEvent[];
  keyRoot: string | null;
  keyMode: 'major' | 'minor' | null;
  durationSec: number;
  renderedAudio: Blob | null;
  publishedId: string | null;
  shareUrl: string | null;
  onTitleChange(title: string): void;
  onRender(): Promise<Blob | null>;
  onStart(): void;
  onPublished(receipt: PublishReceipt): void;
  onUnpublished(): void;
  onError(error: unknown): void;
}

/**
 * US-1003..US-1007 / D-0603 - the publish moment.
 *
 * The transition from private to public is stated before it happens, in two
 * separate sentences that say two different things (US-1104):
 *   - what *is* uploaded: the rendered audio and the note file;
 *   - what is *not*: the original recording.
 *
 * Both are true, and the second is the one the product's privacy claim rests
 * on, so it is not folded into the first.
 *
 * Ownership follows questionnaire Q-C1: anonymous publish with a secret manage
 * token. The token is stored locally and shown once, and the copy says plainly
 * that losing it means losing the ability to delete.
 */
export function PublishPanel({
  enabled,
  title,
  mode,
  bpm,
  meter,
  instrumentId,
  notes,
  drums,
  keyRoot,
  keyMode,
  durationSec,
  renderedAudio,
  publishedId,
  shareUrl,
  onTitleChange,
  onRender,
  onStart,
  onPublished,
  onUnpublished,
  onError,
}: PublishPanelProps) {
  const { locale, t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const publish = useCallback(async () => {
    setBusy(true);
    onStart();
    track('publish_started', { mode, instrument: instrumentId });

    try {
      const audio = renderedAudio ?? await onRender();
      if (audio === null) throw new AppError('publish_upload_failed', 'retry', 'no render');

      const instrument = getInstrument(instrumentId);
      const midiOptions = {
        bpm,
        meter,
        title: title.trim() || 'Rhythmisoze sketch',
        program: instrument?.gmProgram ?? 0,
      };
      const midiBytes =
        mode === 'rhythm' ? rhythmToMidi(drums, midiOptions) : melodyToMidi(notes, midiOptions);

      // Step 1: the server mints the id and a signed ticket. The client never
      // chooses its own id, so it cannot aim an upload at somebody else's.
      const prepareResponse = await fetch('/api/publish/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          audioBytes: audio.size,
          midiBytes: midiBytes.byteLength,
          durationSec,
        }),
      });
      if (!prepareResponse.ok) throw await publishError(prepareResponse);
      const prepared = (await prepareResponse.json()) as {
        id: string;
        ticket: string;
        prefix: string;
      };

      // Step 2: upload straight to blob storage. Nothing large crosses a
      // Function body (Vercel's 4.5 MB limit; a 60 s WAV is roughly 10 MB).
      const { upload } = await import('@vercel/blob/client');
      const [audioBlob, midiBlob] = await Promise.all([
        upload(`${prepared.prefix}audio.wav`, audio, {
          access: 'public',
          handleUploadUrl: '/api/publish/blob',
          clientPayload: prepared.ticket,
          contentType: 'audio/wav',
        }),
        upload(
          `${prepared.prefix}sketch.mid`,
          new Blob([new Uint8Array(midiBytes)], { type: 'audio/midi' }),
          {
            access: 'public',
            handleUploadUrl: '/api/publish/blob',
            clientPayload: prepared.ticket,
            contentType: 'audio/midi',
          },
        ),
      ]);

      // Step 3: register the metadata. The server re-verifies the ticket and
      // checks both URLs live under the prefix it authorized.
      const createResponse = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ticket: prepared.ticket,
          title: title.trim(),
          bpm,
          mode,
          keyRoot,
          keyMode,
          instrumentId,
          durationSec,
          audioUrl: audioBlob.url,
          midiUrl: midiBlob.url,
          locale,
        }),
      });
      if (!createResponse.ok) throw await publishError(createResponse);

      const receipt = (await createResponse.json()) as PublishReceipt;
      rememberManageToken(receipt.sketch.id, receipt.manageToken);
      onPublished(receipt);
      track('publish_completed', { mode, instrument: instrumentId });
    } catch (error) {
      onError(toAppError(error, 'publish_upload_failed', 'retry'));
    } finally {
      setBusy(false);
    }
  }, [
    renderedAudio,
    onRender,
    onStart,
    instrumentId,
    bpm,
    meter,
    title,
    mode,
    drums,
    notes,
    keyRoot,
    keyMode,
    durationSec,
    locale,
    onPublished,
    onError,
  ]);

  const unpublish = useCallback(async () => {
    if (publishedId === null) return;
    setBusy(true);
    try {
      const token = getManageToken(publishedId);
      const response = await fetch(`/api/publish/${publishedId}`, {
        method: 'DELETE',
        headers: { 'x-manage-token': token ?? '' },
      });
      if (!response.ok) throw await publishError(response);
      forgetManageToken(publishedId);
      onUnpublished();
    } catch (error) {
      onError(toAppError(error, 'publish_rejected', 'retry'));
    } finally {
      setBusy(false);
    }
  }, [publishedId, onUnpublished, onError]);

  if (!enabled) {
    return (
      <Well as="section">
        <Stack gap={2}>
          <Text variant="heading" as="h3">
            {t.publish.title}
          </Text>
          <Text variant="micro" muted>
            {t.publish.disabled} {t.publish.disabledHint}
          </Text>
        </Stack>
      </Well>
    );
  }

  if (publishedId !== null && shareUrl !== null) {
    return (
      <Well as="section" tone="success">
        <Stack gap={3}>
          <Text variant="heading" as="h3">
            {t.publish.published}
          </Text>
          <Row gap={2}>
            {/* The URL is Latin inside possibly-Persian text: isolate it, or the
                slug can render reordered and the user copies a broken link. */}
            <Text>
              <Bdi dir="ltr">{shareUrl}</Bdi>
            </Text>
          </Row>
          <Row gap={2}>
            <Button
              kind="primary"
              onClick={() => {
                void navigator.clipboard.writeText(shareUrl).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? t.publish.copied : t.publish.copyLink}
            </Button>
            <Button kind="danger" busy={busy} onClick={() => void unpublish()}>
              {t.publish.unpublish}
            </Button>
          </Row>
          <Text variant="micro" muted>
            {t.publish.manageNote}
          </Text>
        </Stack>
      </Well>
    );
  }

  return (
    <Well as="section" aria-labelledby="publish-heading">
      <Stack gap={4}>
        <Stack gap={1}>
          <Text variant="heading" as="h3" id="publish-heading">
            {t.publish.title}
          </Text>
          <Text variant="micro" muted>
            {t.publish.body}
          </Text>
          <Text variant="micro" muted>
            {t.publish.privacyNote}
          </Text>
        </Stack>

        <Stack gap={2}>
          <label htmlFor="publish-title" style={{ fontSize: 'var(--text-label)' }}>
            {t.publish.titleLabel}
          </label>
          <input
            id="publish-title"
            type="text"
            value={title}
            maxLength={80}
            placeholder={t.publish.titlePlaceholder}
            onChange={(event) => onTitleChange(event.target.value)}
            style={{
              padding: 'var(--space-3)',
              borderRadius: 'var(--radius-md)',
              border: 'var(--border-hairline) solid var(--color-line-strong)',
              backgroundColor: 'var(--color-canvas)',
            }}
          />
        </Stack>

        <Button kind="accent" busy={busy} onClick={() => void publish()}>
          {busy ? t.publish.publishing : t.publish.action}
        </Button>
      </Stack>
    </Well>
  );
}

async function publishError(response: Response): Promise<AppError> {
  if (response.status === 429) return new AppError('publish_rate_limited', 'retry', '429');
  if (response.status === 503) return new AppError('publish_disabled', 'none', '503');
  let detail = String(response.status);
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) detail = body.error;
  } catch {
    // A non-JSON body is fine; the status code is the useful part.
  }
  return new AppError('publish_rejected', 'retry', detail);
}
