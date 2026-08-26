'use client';

import { useEffect } from 'react';
import { retouchLabel } from '@retouch';
import { Button } from '@/components/Button';
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
import { useCoreSupport } from '@/features/shell/useCapabilities';
import { warmModel } from '@/features/transcription/client';
import { ProcessStage } from '@/features/transcription/ProcessStage';
import { ResonantBody } from '@/features/visual/ResonantBody';
import { useLocale } from '@/i18n/provider';
import { encodingBpm } from '@rhythm-extraction';
import { useCreationFlow, MAX_RECORDING_SEC } from './useCreationFlow';
import styles from './CreationPage.module.css';

export interface CreationPageProps {
  /** Whether the deployment has storage and a database configured. */
  publishEnabled: boolean;
}

/**
 * The creation screen.
 *
 * Stages appear as they become relevant and earlier ones stay visible but
 * recede, with no hidden mandatory screens (D-0201).
 *
 * The first screen is the shortest it can be: record, or bring a file. There
 * used to be a setup step above it — tempo, meter, a metronome, a tap pad — and
 * it was not merely an extra click. It asked the user to state a fact about
 * music that did not exist yet, and then let that statement reach the
 * interpretation of the performance they went on to give.
 *
 * Only one thing is ever the focal object (design invariant 2): the record
 * control before and during a take, the sketch during review.
 */
export function CreationPage({ publishEnabled }: CreationPageProps) {
  const { locale, t } = useLocale();
  const {
    state,
    refined,
    rhythm,
    versions,
    activeVersion,
    lesson,
    performanceTempo,
    musicalDurationSec,
    musician,
    versionNotes,
    versionProvenance,
    actions,
  } =
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

  /**
   * The tempo to write down, for everything downstream of the review screen.
   *
   * The piano roll's bar lines, the exported MIDI's stamp and the published
   * metadata all need a number. It is the performance's own pulse whenever
   * there was one; for a freely-timed take it is the encoding constant, and
   * `freeTiming` is carried alongside so the interface can say so rather than
   * present the constant as something the app heard.
   */
  const musicalBpm = activeVersion?.bpm ?? encodingBpm(performanceTempo);
  const freeTiming = activeVersion?.freeTiming ?? performanceTempo.freeTiming;
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

        {/* --- Start ------------------------------------------------------ */}
        {!recording && machineState !== 'armed' && !showReview ? (
          <section aria-labelledby="start-heading">
            <Stack gap={5}>
              <Raised as="section">
                <Text variant="heading" as="h2" id="start-heading" className={styles.srHeading}>
                  {t.landing.steps.start.title}
                </Text>
                <Row justify="center">
                  <Button
                    kind="accent"
                    size="large"
                    onClick={() => void actions.arm()}
                    // Warming the model on hover costs nothing if the user never
                    // presses, and buys back most of the load if they do. It used
                    // to happen while they set a tempo; there is no such pause
                    // left to hide it in.
                    onPointerEnter={() => void warmModel()}
                  >
                    {t.landing.start}
                  </Button>
                </Row>
              </Raised>

              <SourceInput
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
          >
            <RecordStage
              phase={machineState as 'armed' | 'recording'}
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
            judge={state.judge}
            lesson={lesson}
            onVersionChange={actions.setVersion}
            musician={{
              phase: musician.phase,
              busy: musician.busy,
              hasResult: musician.result !== null,
              hasPending: musician.pending !== null,
              error: musician.error,
              available: musician.available,
              withheld: musician.withheld,
              onGenerate: musician.generate,
              onRegenerate: musician.regenerate,
              onCancel: musician.cancel,
              onKeepPending: musician.keepPending,
              onDiscardPending: musician.discardPending,
            }}
            refined={refined}
            rawNotes={state.rawNotes}
            diagnostics={state.diagnostics}
            melodyQuality={state.melodyQuality}
            mode={state.mode}
            bpm={musicalBpm}
            freeTiming={freeTiming}
            onCorrectRoute={(type) => void actions.correctInputRoute(type)}
            sourceKind={state.source?.kind}
            meter={state.meter}
            durationSec={musicalDurationSec}
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
              bpm={musicalBpm}
              meter={state.meter}
              instrumentId={state.instrumentId}
              notes={refined.notes}
              drums={refined.drums}
              renderedAudio={state.renderedAudio}
              source={state.source}
              cleanupLabel={t.review.cleanupLevels[retouchLabel(state.retouchAmount)]}
              versionNotes={versionNotes}
              selectedVersionId={activeVersion?.id ?? undefined}
              versionProvenance={versionProvenance}
              analysis={
                refined.analysis
                  ? { keyRoot: refined.analysis.keyRoot, keyMode: refined.analysis.keyMode }
                  : null
              }
              onRender={() => actions.render()}
              onError={actions.fail}
            />

            <PublishPanel
              enabled={publishEnabled}
              title={state.title}
              mode={state.mode}
              bpm={musicalBpm}
              meter={state.meter}
              instrumentId={state.instrumentId}
              notes={refined.notes}
              drums={refined.drums}
              keyRoot={refined.keyIsReliable ? refined.key.root : null}
              keyMode={refined.keyIsReliable ? refined.key.mode : null}
              // The length of the audio being published, which is the render,
              // which is the version — not the recording it grew from.
              durationSec={musicalDurationSec}
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
