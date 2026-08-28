'use client';

import type { CreationMode, SourceKind } from '@contracts';
import type { PerformanceRhythm, VersionId, VersionRecipe } from '@rhythm-extraction';
import { Row, Stack, Well } from '@/components/Layout';
import { Bdi, Text } from '@/components/Text';
import { useMessages } from '@/i18n/provider';
import styles from './VersionPicker.module.css';

export interface VersionPickerProps {
  versions: readonly VersionRecipe[];
  activeId: VersionId | null;
  rhythm: PerformanceRhythm | null;
  /**
   * Where the material came from.
   *
   * Only the copy depends on it: a version list describing an imported file
   * must not talk about what the person sang.
   */
  sourceKind: SourceKind | undefined;
  /** Rhythm names its stages differently; see `rhythmNames`. */
  mode: CreationMode;
  onSelect(id: VersionId): void;
}

/**
 * The readings of one performance.
 *
 * The transcription itself, and whatever the Musician has made from it. There
 * were two tidied readings in between — a Judge repair and a Teacher
 * suggestion — and they are gone: both removed notes the transcriber had found
 * and flattened distinct pitches into one, and the Musician was fed the second
 * of them rather than the take.
 *
 * Two things the copy has to get right:
 *
 *  - **The original is first and is never framed as the raw/broken one.** It is
 *    "As performed", not "unprocessed". It is a legitimate choice.
 *  - **A tempo is only reported when one was heard.** There is no longer a
 *    second candidate to have come from somewhere else, so the only two honest
 *    statements left are "heard at N" — hedged when the estimate is uncertain —
 *    and "timed freely", which is what a take with no measurable pulse gets.
 *    The app must never imply it heard a tempo it did not.
 */
export function VersionPicker({
  versions,
  activeId,
  rhythm,
  sourceKind,
  mode,
  onSelect,
}: VersionPickerProps) {
  const t = useMessages();
  if (versions.length === 0) return null;

  // An imported file was not performed here, so two of the hints would be
  // describing work that never happened.
  const imported = sourceKind === 'midi-upload';
  const rhythm2 = mode === 'rhythm';
  const nameFor = (id: VersionId): string =>
    rhythm2 && id === 'unprocessed' ? t.versions.rhythmNames[id] : t.versions.names[id];
  const hintFor = (id: VersionId): string => {
    if (rhythm2 && id === 'unprocessed') return t.versions.rhythmHints[id];
    if (imported && id === 'unprocessed') return t.versions.importedHints[id];
    return t.versions.hints[id];
  };

  // Said once, above the list, when there was genuinely no pulse to hear. An
  // uncertain reading is still a reading, so this is not shown over one.
  const notice = rhythm !== null && !rhythm.measured ? t.versions.tempoNotHeard : null;

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
                  <span className={styles.name}>{nameFor(version.id)}</span>
                  <span className={styles.hint}>{hintFor(version.id)}</span>
                  {/* Tempo, isolated so the Latin BPM value cannot reorder the
                      Persian sentence around it.

                      Three states, because there are three: heard clearly,
                      heard but not certainly, and not heard at all. Collapsing
                      the middle one into either neighbour is how the app either
                      overclaims or hides how sure it is; collapsing the third
                      into the first is how a constant needed for encoding gets
                      presented as a measurement. */}
                  <span className={styles.tempo}>
                    <Bdi dir="auto">
                      {version.bpm === null
                        ? t.versions.freeTiming
                        : version.tempoReliable
                          ? t.versions.heardTempo(Math.round(version.bpm))
                          : t.versions.heardTempoUncertain(Math.round(version.bpm))}
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
