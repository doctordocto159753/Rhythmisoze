'use client';

import { useEffect } from 'react';
import { retouchLabel } from '@retouch';
import { Button } from '@/components/Button';
import { Choice } from '@/components/Choice';
import { ErrorPanel } from '@/components/ErrorPanel';
import { Raised, Row, Stack, Well } from '@/components/Layout';
import { StageLabel, Text } from '@/components/Text';
import { track } from '@/features/analytics/track';
import { ExportPanel } from '@/features/export/ExportPanel';
import { PublishPanel } from '@/features/publish/PublishPanel';
import { RecordStage } from '@/features/recording/RecordStage';
import { SourceInput } from '@/features/recording/SourceInput';
import { ReviewStage } from '@/features/review/ReviewStage';
import { canExport, hasResult, isRecordingPhase, stageOf } from '@/features/state/machine';
import { TempoPanel } from '@/features/tempo/TempoPanel';
import { useCoreSupport } from '@/features/shell/useCapabilities';
import { warmModel } from '@/features/transcription/client';
import { ProcessStage } from '@/features/transcription/ProcessStage';
import { ResonantBody } from '@/features/visual/ResonantBody';
import { useLocale } from '@/i18n/provider';
import { useCreationFlow, MAX_RECORDING_SEC } from './useCreationFlow';
import styles from './CreationPage.module.css';

export interface CreationPageProps {
  /** Whether the deployment has storage and a database configured. */
  publishEnabled: boolean;
}

/**
 * The creation screen.
 *
 * The composition follows the PRD's sequence exactly, top to bottom, with no
 * hidden mandatory screens (D-0201). Stages appear as they become relevant and
 * earlier ones stay visible but recede - a user who wants to retap their tempo
 * mid-review can, without navigating anywhere.
 *
 * Only one thing is ever the focal object (design invariant 2): the tap pad
 * during setup, the record control during a take, the sketch during review.
 */
export function CreationPage({ publishEnabled }: CreationPageProps) {
  const { locale, t } = useLocale();
  const { state, refined, rhythm, versions, activeVersion, tempoDisagreement, actions } =
    useCreationFlow(locale);
  const support = useCoreSupport();

  useEffect(() => {
    track('landing_viewed');
  }, []);

  const machineState = state.machine.state;
  const stage = stageOf(machineState);
  const recording = isRecordingPhase(machineState);
  const showReview = hasResult(machineState) && refined !== null;
  const showDeliver = canExport(machineState) && refined !== null;

  // US-0105: the user is told which piece is missing, and why.
  //
  // `support.measured` gates the whole panel. Before the client has looked at
  // the browser the capability set is all-false, and rendering this during
  // prerender would put "this browser cannot run Rhythmisoze" into the static
  // HTML of every page — an accusation made before anything was checked.
  if (support.measured && !support.supported) {
    const insecure = support.reason === 'insecure_context';
    return (
      <div className="stage">
        <Well tone="danger" as="section">
          <Stack gap={3}>
            <Text variant="title" as="h1">
              {insecure ? t.capability.insecureTitle : t.capability.unsupportedTitle}
            </Text>
            <Text>{insecure ? t.capability.insecureBody : t.capability.unsupportedBody}</Text>
            {insecure ? (
              <Text variant="micro" muted>
                {t.capability.insecureHint}
              </Text>
            ) : (
              <>
                <Text variant="micro" muted>
                  {t.capability.missing}{' '}
                  {support.missing
                    .map((key) => t.capability.names[key as keyof typeof t.capability.names] ?? key)
                    .join('، ')}
                </Text>
                <Text variant="micro" muted>
                  {t.errors.hints.unsupported_browser}
                </Text>
              </>
            )}
          </Stack>
        </Well>
      </div>
    );
  }

  const beatSeconds = state.bpm !== null ? 60 / state.bpm : 0.6;
  // Register 0..1 from the current take's pitch range, used only to bias the
  // 3D object vertically. Falls back to the middle when there is nothing yet.
  const register =
    refined && refined.analysis.highestPitch > 0
      ? Math.max(0, Math.min(1, (refined.analysis.highestPitch - 40) / 50))
      : 0.5;

  return (
    <div className="stage">
      <Stack gap={7}>
        {/* --- Entry ------------------------------------------------------ */}
        {machineState === 'idle' ? (
          <header className={styles.intro}>
            <Text variant="display" as="h1">
              {t.landing.lead}
            </Text>
            <Text muted>{t.landing.body}</Text>
          </header>
        ) : null}

        {state.error ? (
          <ErrorPanel
            error={state.error}
            onRecover={(action) => {
              actions.clearError();
              if (action === 'reload') window.location.reload();
              else if (action === 'rerecord') actions.rerecord();
              else if (action === 'retry') {
                if (machineState === 'failed') actions.retry();
                if (state.audio !== null) actions.reprocess();
              } else actions.retry();
            }}
            // Dismissing a failed-state alert must also restore its last safe
            // state; otherwise the visible setup controls accept input while
            // the state machine silently rejects their events.
            onDismiss={machineState === 'failed' ? actions.retry : actions.clearError}
          />
        ) : null}

        {/* --- Setup ------------------------------------------------------ */}
        {!recording && !showReview ? (
          <section aria-labelledby="setup-heading">
            <Stack gap={5}>
              <Row gap={3} justify="between">
                <StageLabel>{t.landing.steps.tempo.title}</StageLabel>
              </Row>

              <Choice<'melody' | 'rhythm'>
                legend={t.mode.label}
                value={state.mode}
                options={[
                  { value: 'melody', title: t.mode.melody, hint: t.mode.melodyHint },
                  { value: 'rhythm', title: t.mode.rhythm, hint: t.mode.rhythmHint },
                ]}
                onChange={actions.setMode}
              />

              {state.mode === 'melody' ? (
                <Choice<'voice' | 'instrument'>
                  legend={t.melodyInput.label}
                  value={state.melodyInputMode}
                  options={[
                    {
                      value: 'voice',
                      title: t.melodyInput.voice,
                      hint: t.melodyInput.voiceHint,
                    },
                    {
                      value: 'instrument',
                      title: t.melodyInput.instrument,
                      hint: t.melodyInput.instrumentHint,
                    },
                  ]}
                  onChange={actions.setMelodyInputMode}
                />
              ) : null}

              <Raised as="section" aria-labelledby="setup-heading">
                <Text variant="heading" as="h2" id="setup-heading" className={styles.srHeading}>
                  {t.tempo.label}
                </Text>
                <TempoPanel
                  bpm={state.bpm}
                  tapCount={state.tapCount}
                  meter={state.meter}
                  metronomeMuted={state.metronomeMuted}
                  beat={state.beat}
                  onTap={actions.tap}
                  onBpmChange={actions.setBpm}
                  onMeterChange={actions.setMeter}
                  onToggleMetronome={actions.toggleMetronome}
                  onWarm={state.mode === 'melody' && state.melodyInputMode === 'instrument'
                    ? warmModel
                    : undefined}
                />
              </Raised>

              {state.bpm !== null ? (
                <Row justify="center">
                  <Button kind="accent" size="large" onClick={() => void actions.arm()}>
                    {t.landing.start}
                  </Button>
                </Row>
              ) : null}

              <SourceInput
                tempoReady={state.bpm !== null}
                onUploadAudio={actions.uploadAudio}
                onUploadMidi={actions.uploadMidi}
              />
            </Stack>
          </section>
        ) : null}

        {/* --- Record ----------------------------------------------------- */}
        {recording || machineState === 'armed' ? (
          <ResonantBody
            active={recording}
            level={state.level?.rms ?? 0}
            register={register}
            settled={0}
            beatIndex={state.beat?.index ?? 0}
            beatSeconds={beatSeconds}
          >
            <RecordStage
              phase={machineState as 'armed' | 'countdown' | 'recording'}
              beat={state.beat}
              beatsPerBar={state.meter.beatsPerBar}
              level={state.level}
              elapsedSec={state.elapsedSec}
              maxSec={MAX_RECORDING_SEC}
              onStart={() => void actions.arm()}
              onStop={() => void actions.stopRecording()}
              onCancel={actions.cancelRecording}
            />
          </ResonantBody>
        ) : null}

        {/* --- Process ---------------------------------------------------- */}
        {machineState === 'processing' ? (
          <ProcessStage progress={state.progress} onCancel={actions.cancelProcessing} />
        ) : null}

        {machineState === 'captured' ? (
          <Well as="section">
            <Row gap={3} justify="between">
              <Text>{t.review.title}</Text>
              <Row gap={2}>
                <Button kind="quiet" onClick={actions.rerecord}>
                  {t.record.again}
                </Button>
                <Button kind="primary" onClick={actions.reprocess}>
                  {t.process.retry}
                </Button>
              </Row>
            </Row>
          </Well>
        ) : null}

        {/* --- Review ----------------------------------------------------- */}
        {showReview && refined ? (
          <ReviewStage
            versions={versions}
            activeVersionId={activeVersion?.id ?? null}
            rhythm={rhythm}
            tempoDisagreement={tempoDisagreement}
            judge={state.judge}
            onVersionChange={actions.setVersion}
            refined={refined}
            rawNotes={state.rawNotes}
            diagnostics={state.diagnostics}
            melodyQuality={state.melodyQuality}
            mode={state.mode}
            bpm={state.bpm ?? 100}
            meter={state.meter}
            durationSec={state.durationSec}
            retouchAmount={state.retouchAmount}
            instrumentId={state.instrumentId}
            playing={state.playing}
            playheadOrigin={state.playheadOrigin}
            onRetouchChange={actions.setRetouch}
            onInstrumentChange={actions.setInstrument}
            onPlay={() => void actions.play()}
            onStop={actions.stopPlayback}
            onRerecord={actions.rerecord}
            onError={actions.fail}
          />
        ) : null}

        {/* --- Deliver ---------------------------------------------------- */}
        {showReview && refined && machineState !== 'rendering' && !showDeliver ? (
          <Row justify="center">
            <Button kind="accent" size="large" onClick={() => void actions.render()}>
              {t.exportPanel.title}
            </Button>
          </Row>
        ) : null}

        {machineState === 'rendering' ? (
          <Well tone="processing" as="section" aria-live="polite">
            <Text>{t.exportPanel.preparing}</Text>
          </Well>
        ) : null}

        {showDeliver && refined ? (
          <Stack gap={5}>
            <ExportPanel
              title={state.title}
              mode={state.mode}
              bpm={state.bpm ?? 100}
              meter={state.meter}
              instrumentId={state.instrumentId}
              notes={refined.notes}
              drums={refined.drums}
              renderedAudio={state.renderedAudio}
              source={state.source}
              cleanupLabel={t.review.cleanupLevels[retouchLabel(state.retouchAmount)]}
              onRender={() => actions.render()}
              onError={actions.fail}
            />

            <PublishPanel
              enabled={publishEnabled}
              title={state.title}
              mode={state.mode}
              bpm={state.bpm ?? 100}
              meter={state.meter}
              instrumentId={state.instrumentId}
              notes={refined.notes}
              drums={refined.drums}
              keyRoot={refined.keyIsReliable ? refined.key.root : null}
              keyMode={refined.keyIsReliable ? refined.key.mode : null}
              durationSec={state.durationSec}
              renderedAudio={state.renderedAudio}
              publishedId={state.publishedId}
              shareUrl={state.shareUrl}
              onTitleChange={actions.setTitle}
              onRender={() => actions.render()}
              onStart={actions.startPublish}
              onPublished={(receipt) =>
                actions.published(receipt.sketch.id, receipt.shareUrl, receipt.manageToken)
              }
              onUnpublished={actions.unpublished}
              onError={actions.fail}
            />
          </Stack>
        ) : null}

        {state.storageWarning ? (
          <Well tone="danger" as="section">
            <Stack gap={2}>
              <Text variant="heading" as="h3">
                {t.workspace.storageWarning}
              </Text>
              <Text variant="micro" muted>
                {t.workspace.storageWarningBody}
              </Text>
            </Stack>
          </Well>
        ) : null}

        {/* A quiet stage indicator, not a wizard: it reports where the user is,
            and is never something they have to click through. */}
        <Row gap={2} justify="center">
          <StageLabel>{stage}</StageLabel>
        </Row>
      </Stack>
    </div>
  );
}
