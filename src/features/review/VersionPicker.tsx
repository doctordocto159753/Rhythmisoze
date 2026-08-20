'use client';

import type { PerformanceRhythm, VersionId, VersionRecipe } from '@rhythm-extraction';
import type { TempoDisagreement } from '@rhythm-extraction';
import { Row, Stack, Well } from '@/components/Layout';
import { Bdi, Text } from '@/components/Text';
import { useMessages } from '@/i18n/provider';
import styles from './VersionPicker.module.css';

export interface VersionPickerProps {
  versions: readonly VersionRecipe[];
  activeId: VersionId | null;
  rhythm: PerformanceRhythm | null;
  disagreement: TempoDisagreement | null;
  onSelect(id: VersionId): void;
}

/**
 * The four readings of one performance.
 *
 * This is where the product stops being a transcriber. The user is not asked
 * "how much cleanup?" and given one answer — they are shown what their playing
 * actually was, and three increasingly tidy readings of it, and they choose by
 * ear.
 *
 * Two things the copy has to get right:
 *
 *  - **The original is first and is never framed as the raw/broken one.** It is
 *    "As performed", not "unprocessed". It is a legitimate choice.
 *  - **Where each tempo came from is stated.** A version built on the detected
 *    pulse says so; one built on the tapped value says that instead. The app
 *    must never imply it heard a tempo it did not.
 */
export function VersionPicker({
  versions,
  activeId,
  rhythm,
  disagreement,
  onSelect,
}: VersionPickerProps) {
  const t = useMessages();
  if (versions.length === 0) return null;

  const notice =
    disagreement && disagreement.kind === 'half-or-double'
      ? t.versions.halfOrDouble(Math.round(disagreement.detectedBpm), Math.round(disagreement.tappedBpm))
      : disagreement && disagreement.kind === 'different'
        ? t.versions.different(Math.round(disagreement.detectedBpm), Math.round(disagreement.tappedBpm))
        : rhythm !== null && !rhythm.reliable
          ? t.versions.tempoNotHeard
          : null;

  return (
    <Well as="section" aria-labelledby="versions-heading">
      <Stack gap={4}>
        <Stack gap={1}>
          <Text variant="heading" as="h3" id="versions-heading">
            {t.versions.title}
          </Text>
          <Text variant="micro" muted>
            {t.versions.help}
          </Text>
        </Stack>

        <ul className={styles.list}>
          {versions.map((version) => {
            const selected = version.id === activeId;
            return (
              <li key={version.id}>
                <button
                  type="button"
                  className={[styles.item, selected ? styles.itemSelected : null]
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={selected}
                  onClick={() => onSelect(version.id)}
                >
                  <span className={styles.name}>{t.versions.names[version.id]}</span>
                  <span className={styles.hint}>{t.versions.hints[version.id]}</span>
                  {/* Tempo and its provenance, isolated so the Latin BPM value
                      cannot reorder the Persian sentence around it. */}
                  <span className={styles.tempo}>
                    <Bdi dir="auto">
                      {version.tempoSource === 'detected'
                        ? t.versions.heardTempo(Math.round(version.bpm))
                        : t.versions.tappedTempo(Math.round(version.bpm))}
                    </Bdi>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {notice ? (
          <Row gap={2}>
            <Text variant="micro" muted>
              {notice}
            </Text>
          </Row>
        ) : null}
      </Stack>
    </Well>
  );
}
