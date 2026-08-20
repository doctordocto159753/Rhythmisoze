'use client';

import type { TranscriptionProgress } from '@contracts';
import { Button } from '@/components/Button';
import { Stack, Well } from '@/components/Layout';
import { LiveStatus, Text } from '@/components/Text';
import { useMessages } from '@/i18n/provider';
import styles from './ProcessStage.module.css';

export interface ProcessStageProps {
  progress: TranscriptionProgress | null;
  onCancel(): void;
}

/**
 * D-0401 - processing as transformation, not a spinner.
 *
 * The bar shows the model's own reported progress and nothing else. Inventing a
 * smooth interpolation would look better and would be a lie about how far along
 * the work is, which the story rules out explicitly ("never implies false
 * precision"). When a stage genuinely has no measurable progress, the bar shows
 * the stage boundary it has reached and stops there.
 *
 * The visual is the raw-to-ordered relationship the whole product is about:
 * scattered marks settling onto a line. It is CSS on a handful of elements, so
 * it costs nothing on a phone that is already running inference.
 */
export function ProcessStage({ progress, onCancel }: ProcessStageProps) {
  const t = useMessages();
  const stage = progress?.stage ?? 'preparing_audio';
  const fraction = progress?.progress ?? 0;
  const percent = Math.round(fraction * 100);
  const stageLabel = t.process.stages[stage];

  return (
    <Well as="section" tone="processing" aria-labelledby="process-heading">
      <Stack gap={5} align="center">
        <Text variant="heading" as="h2" id="process-heading">
          {t.process.title}
        </Text>

        <div className={styles.field} aria-hidden="true">
          {Array.from({ length: 14 }, (_, index) => (
            <span
              key={index}
              className={styles.mark}
              style={{
                ['--scatter-x' as string]: `${index * 7.14}%`,
                // Deterministic pseudo-scatter: the same picture on every run,
                // which is what makes it screenshot-testable.
                ['--scatter-y' as string]: `${6 + ((index * 37) % 60)}%`,
                // Each mark travels from its scattered position to the line as
                // the real progress rises. No independent animation loop.
                ['--settle' as string]: String(Math.max(0, Math.min(1, fraction * 1.15 - index * 0.02))),
              }}
            />
          ))}
          <span className={styles.line} />
        </div>

        <div className={styles.barTrack}>
          <div
            className={styles.barFill}
            style={{ inlineSize: `${percent}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={stageLabel}
          />
        </div>

        <Text variant="label" as="p">
          {stageLabel}
        </Text>

        {stage === 'loading_model' ? (
          <Text variant="micro" muted>
            {t.process.firstTimeNote}
          </Text>
        ) : null}

        {/* Announced once per stage rather than once per percent: a live region
            that fires forty times a second is unusable. */}
        <LiveStatus>{t.a11y.processing(stageLabel, percent)}</LiveStatus>

        <Button kind="ghost" onClick={onCancel}>
          {t.process.cancel}
        </Button>
      </Stack>
    </Well>
  );
}
