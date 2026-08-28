'use client';

import { useEffect, useState } from 'react';
import type {
  JudgeVerdict,
  MelodyConfidence,
  Meter,
  ProcessingDiagnostics,
  SourceKind,
} from '@contracts';
import { RETOUCH_AMOUNT_MAX, RETOUCH_AMOUNT_MIN, pitchName, retouchLabel, type RefineResult } from '@retouch';
import { getAudioContext } from '@audio-core';
import { Button } from '@/components/Button';
import { Row, Stack, Well } from '@/components/Layout';
import { Slider } from '@/components/Slider';
import { Bdi, Readout, Text } from '@/components/Text';
import { InstrumentGallery } from '@/features/synthesis/InstrumentGallery';
import { useLocale } from '@/i18n/provider';
import { PianoRoll } from './PianoRoll';
import styles from './ReviewStage.module.css';

import type { PerformanceRhythm, VersionId, VersionRecipe } from '@rhythm-extraction';
import { MusicianPanel, type MusicianPanelProps } from '@/features/musician';
import { VersionPicker } from './VersionPicker';

export interface ReviewStageProps {
  versions: readonly VersionRecipe[];
  activeVersionId: VersionId | null;
  rhythm: PerformanceRhythm | null;
  onVersionChange(id: VersionId): void;
  /**
   * Everything the Musician area needs, passed through rather than reached for.
   *
   * The review screen does not own the generation - it outlives this screen -
   * so it receives a description of it and renders that. Omitted entirely when
   * the deployment has no Musician, which is why the type allows undefined
   * rather than requiring a disabled stub.
   */
  musician?: MusicianPanelProps;
  refined: RefineResult;
  rawNotes: RefineResult['notes'];
  diagnostics: ProcessingDiagnostics | null;
  melodyQuality: MelodyConfidence | null;
  mode: 'melody' | 'rhythm';
  /**
   * The tempo the music is written down at.
   *
   * The performance's own pulse when it had one. When it did not, this is the
   * encoding constant and `freeTiming` is true — the bar ruler still needs
   * spacing, and the piano roll still has to draw something.
   */
  bpm: number;
  /** `true` when the performance had no measurable pulse. */
  freeTiming: boolean;
  /** Where the material came from, so the version copy can stay honest. */
  sourceKind: SourceKind | undefined;
  onCorrectRoute(type: 'melody' | 'rhythm'): void;
  meter: Meter;
  /**
   * How long the selected version runs — the *musical* duration, which for a
   * Musician version can be several times the length of the recording.
   */
  durationSec: number;
  retouchAmount: number;
  instrumentId: string;
  playing: boolean;
  playheadOrigin: number | null;
  onRetouchChange(amount: number): void;
  onInstrumentChange(id: string): void;
  onPlay(): void;
  onStop(): void;
  onRerecord(): void;
  onError(error: unknown): void;
}

/**
 * US-0701..US-0704 / D-0402 / D-0403 - the review stage.
 *
 * The one place the product's actual value is visible: the same take, moving
 * between raw and cleaned, heard and seen at the same time. Everything here is
 * arranged around that comparison - the piano roll draws the raw transcription
 * behind the current result, and the slider that moves them is directly under it.
 */
export function ReviewStage({
  versions,
  activeVersionId,
  musician,
  rhythm,
  onVersionChange,
  refined,
  rawNotes,
  diagnostics,
  melodyQuality,
  mode,
  bpm,
  freeTiming,
  onCorrectRoute,
  sourceKind,
  meter,
  durationSec,
  retouchAmount,
  instrumentId,
  playing,
  playheadOrigin,
  onRetouchChange,
  onInstrumentChange,
  onPlay,
  onStop,
  onRerecord,
  onError,
}: ReviewStageProps) {
  const { locale, t } = useLocale();
  const [showDetail, setShowDetail] = useState(false);
  const playhead = usePlayhead(playing, playheadOrigin, durationSec);

  const label = retouchLabel(retouchAmount);
  const cleanupText = t.review.cleanupLevels[label];
  const analysis = refined.analysis;
  const mixedMaterial = diagnostics?.classification?.type === 'mixed';

  return (
    <Stack gap={5}>
      <Well as="section" padding="flush" aria-labelledby="review-heading">
        <div className={styles.header}>
          <Text variant="heading" as="h2" id="review-heading">
            {t.review.title}
          </Text>
          <Row gap={2}>
            <Button kind="ghost" size="small" onClick={onRerecord}>
              {t.review.title === '' ? '' : t.record.again}
            </Button>
          </Row>
        </div>

        <PianoRoll
          notes={refined.notes}
          drums={refined.drums}
          rawNotes={rawNotes}
          durationSec={durationSec}
          bpm={bpm}
          beatsPerBar={meter.beatsPerBar}
          playhead={playhead}
          showRaw={mode === 'melody' && retouchAmount > 0}
        />

        <div className={styles.transport}>
          <Button kind="primary" onClick={playing ? onStop : onPlay}>
            {playing ? t.review.pause : t.review.play}
          </Button>

          <span className={styles.counts}>
            {mixedMaterial
              ? `${t.review.notesHeard(refined.notes.length)} · ${t.review.hitsHeard(refined.drums.length)}`
              : mode === 'rhythm'
              ? t.review.hitsHeard(refined.drums.length)
              : t.review.notesHeard(refined.notes.length)}
          </span>

          {mode === 'melody' ? (
            <span className={styles.keyBadge}>
              {t.review.keyLabel}:{' '}
              {refined.keyIsReliable ? (
                <Bdi dir="ltr">
                  {refined.key.root} {refined.key.mode === 'major' ? 'major' : 'minor'}
                </Bdi>
              ) : (
                <span className={styles.keyUnknown}>{t.review.keyUnknown}</span>
              )}
            </span>
          ) : null}
        </div>

        {mode === 'melody' && melodyQuality && !melodyQuality.clear ? (
          <div className={styles.clarityNotice} role="status">
            <Text variant="micro">{t.review.unclearMelody}</Text>
          </div>
        ) : null}
      </Well>

      {diagnostics?.classification && diagnostics.classification.type !== 'unknown' ? (
        <Well as="section" aria-labelledby="classification-heading">
          <Stack gap={3}>
            <Text variant="heading" as="h3" id="classification-heading">
              {t.review.classification.title}
            </Text>
            <Text>
              {t.review.classification.detected(
                t.review.classification.types[diagnostics.classification.type],
                Math.round(diagnostics.classification.confidence * 100),
              )}
            </Text>
            <Text variant="micro" muted>
              {diagnostics.classification.method === 'user-corrected'
                ? t.review.classification.corrected
                : t.review.classification.help}
            </Text>
            <Row gap={2}>
              {diagnostics.classification.type !== 'melody' ? (
                <Button kind="ghost" size="small" onClick={() => onCorrectRoute('melody')}>
                  {t.review.classification.correctMelody}
                </Button>
              ) : null}
              {diagnostics.classification.type !== 'rhythm' ? (
                <Button kind="ghost" size="small" onClick={() => onCorrectRoute('rhythm')}>
                  {t.review.classification.correctRhythm}
                </Button>
              ) : null}
            </Row>
          </Stack>
        </Well>
      ) : null}

      <VersionPicker
        versions={versions}
        activeId={activeVersionId}
        rhythm={rhythm}
        sourceKind={sourceKind}
        mode={mode}
        onSelect={onVersionChange}
      />

      {/* Below the versions, because it is a way of getting two more of them
          rather than a competing feature. */}
      {musician ? <MusicianPanel {...musician} /> : null}

      <Well as="section" aria-labelledby="cleanup-heading">
        <Stack gap={3}>
          <Text variant="heading" as="h3" id="cleanup-heading">
            {t.review.cleanup}
          </Text>
          <Slider
            label={t.review.cleanup}
            value={retouchAmount}
            min={RETOUCH_AMOUNT_MIN}
            max={RETOUCH_AMOUNT_MAX}
            step={1}
            continuum
            valueText={cleanupText}
            startLabel={t.review.cleanupLevels.raw}
            endLabel={t.review.cleanupLevels.clean}
            onChange={onRetouchChange}
          />

          {refined.qualityGuard?.triggered ? (
            <div className={styles.qualityGuard} role="status">
              <Text variant="micro">{t.review.qualityGuard}</Text>
            </div>
          ) : null}

          <Text variant="micro" muted>
            {t.review.cleanupHelp}
          </Text>
        </Stack>
      </Well>

      <Well as="section" aria-labelledby="instrument-heading">
        <Stack gap={4}>
          <Text variant="heading" as="h3" id="instrument-heading">
            {t.instruments.title}
          </Text>
          <InstrumentGallery
            mode={mode}
            selectedId={instrumentId}
            onSelect={onInstrumentChange}
            onError={onError}
          />
        </Stack>
      </Well>

      {/* US-0408: diagnostics exist, and stay out of the way. */}
      <div>
        <Button kind="ghost" size="small" onClick={() => setShowDetail((value) => !value)}>
          {showDetail ? t.review.detailHide : t.review.detail}
        </Button>

        {showDetail ? (
          <Well as="dl" padding="tight" className={styles.detail}>
            <DetailRow
              label={t.review.analysis.range}
              value={
                <Bdi dir="ltr">
                  {pitchName(analysis.lowestPitch)} – {pitchName(analysis.highestPitch)}
                </Bdi>
              }
            />
            <DetailRow
              label={t.review.analysis.yourTempo}
              value={freeTiming ? t.versions.freeTiming : <Readout value={bpm} small />}
            />
            {melodyQuality ? (
              <DetailRow
                label={t.review.analysis.melodyConfidence}
                value={t.units.percent(Math.round(melodyQuality.melodyConfidence * 100))}
              />
            ) : null}
            <DetailRow
              label={t.review.analysis.detectedTempo}
              value={<Readout value={Math.round(analysis.detectedBpm)} small />}
            />
            <DetailRow
              label={t.review.analysis.octaveFixes}
              value={String(analysis.octaveErrorsRemoved)}
            />
            <DetailRow label={t.review.analysis.snapped} value={String(analysis.notesSnapped)} />
            <DetailRow label={t.review.analysis.merged} value={String(analysis.notesMerged)} />
            <DetailRow
              label={t.review.analysis.stepwise}
              value={t.units.percent(Math.round(analysis.stepwiseMovePercent))}
            />
            {diagnostics ? (
              <DetailRow
                label={t.privacy.processedBy('')}
                value={t.privacy.backends[diagnostics.transcriberId]}
              />
            ) : null}
            {diagnostics?.classification ? (
              <DetailRow
                label={t.review.classification.classifierLabel}
                value={`${diagnostics.classification.type} (${Math.round(
                  diagnostics.classification.confidence * 100,
                )}%)`}
              />
            ) : null}
            {diagnostics?.classification ? (
              <DetailRow
                label={t.review.classification.reasoningLabel}
                value={diagnostics.classification.reasoning.join(' · ')}
              />
            ) : null}
          </Well>
        ) : null}
      </div>
    </Stack>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>{value}</dd>
    </div>
  );
}

/**
 * The playhead position, read from the audio clock.
 *
 * Not from a `setInterval` counter and not from elapsed wall time: the audio
 * clock is the only thing that agrees with what the user is hearing, and a
 * cursor that drifts from the sound is worse than no cursor (interaction-motion
 * skill: "the audio clock is truth").
 */
function usePlayhead(
  playing: boolean,
  origin: number | null,
  durationSec: number,
): number | null {
  const [position, setPosition] = useState(0);
  const active = playing && origin !== null && durationSec > 0;

  useEffect(() => {
    if (!active || origin === null) return;
    let frame = 0;
    const context = getAudioContext();
    // The only setState here happens inside the animation callback, never in
    // the effect body: the idle case is derived below rather than assigned.
    const tick = (): void => {
      const elapsed = context.currentTime - origin;
      setPosition(Math.max(0, Math.min(1, elapsed / durationSec)));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, origin, durationSec]);

  return active ? position : null;
}
