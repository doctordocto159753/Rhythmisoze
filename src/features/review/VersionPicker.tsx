'use client';

import type { CreationMode, JudgeVerdict, SourceKind } from '@contracts';
import type { TeacherResult } from '@music-teacher';
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
  /** Rhythm names its two stages differently; see `rhythmNames`. */
  mode: CreationMode;
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
  judge,
  lesson,
  onSelect,
}: VersionPickerProps) {
  const t = useMessages();
  if (versions.length === 0) return null;

  // An imported file was not performed here, so two of the hints would be
  // describing work that never happened.
  const imported = sourceKind === 'midi-upload';
  const rhythm2 = mode === 'rhythm';
  const nameFor = (id: VersionId): string =>
    rhythm2 && (id === 'unprocessed' || id === 'teacher')
      ? t.versions.rhythmNames[id]
      : t.versions.names[id];
  const hintFor = (id: VersionId): string => {
    if (rhythm2 && (id === 'unprocessed' || id === 'teacher')) return t.versions.rhythmHints[id];
    if (imported && (id === 'unprocessed' || id === 'judge')) return t.versions.importedHints[id];
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
