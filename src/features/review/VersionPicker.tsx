'use client';

import type { JudgeVerdict } from '@contracts';
import type { TeacherResult } from '@music-teacher';
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
  /** The Judge's verdict, shown against the reading it produced. */
  judge: JudgeVerdict | null;
  /** The teacher's suggestions, shown against the reading they apply to. */
  lesson: TeacherResult | null;
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
  judge,
  lesson,
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
                  {/* What the Judge actually did, against the reading it
                      produced. A correction count with nothing behind it would
                      be a claim; naming the repairs makes it checkable. */}
                  {version.id === 'judge' && judge !== null ? (
                    <span className={styles.repairs}>
                      {judge.repairs.length === 0
                        ? t.versions.judgeClean
                        : t.versions.judgeRepaired(judge.repairs.length)}
                    </span>
                  ) : null}
                  {version.id === 'teacher' && lesson !== null ? (
                    <span className={styles.repairs}>
                      {lesson.edits.length === 0
                        ? t.versions.teacherNone
                        : t.versions.teacherSuggestions(lesson.edits.length)}
                    </span>
                  ) : null}
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

        {/* The suggestions in full, so a musician can disagree with a specific
            decision rather than with a black box. Only while the Teacher's
            reading is the one being heard. */}
        {activeId === 'teacher' && lesson !== null && lesson.edits.length > 0 ? (
          <ul className={styles.reasons}>
            {lesson.edits.map((edit, index) => (
              <li key={`${edit.kind}-${edit.noteIndex}-${index}`}>{edit.reason}</li>
            ))}
          </ul>
        ) : null}

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
