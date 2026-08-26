'use client';

import { useState } from 'react';
import { RETOUCH_AMOUNT_MAX, RETOUCH_AMOUNT_MIN, retouchLabel } from '@retouch';
import { INSTRUMENTS, auditRegistry } from '@synthesis';
import { Button } from '@/components/Button';
import { Choice } from '@/components/Choice';
import { ErrorPanel } from '@/components/ErrorPanel';
import { Divider, Raised, Row, Stack, Well } from '@/components/Layout';
import { Slider } from '@/components/Slider';
import { Bdi, Readout, StageLabel, Text } from '@/components/Text';
import { PianoRoll } from '@/features/review/PianoRoll';
import { ProcessStage } from '@/features/transcription/ProcessStage';
import { RecordStage } from '@/features/recording/RecordStage';
import { useLocale } from '@/i18n/provider';
import styles from './DesignCatalog.module.css';

/**
 * D-0801 - the design-system catalog.
 *
 * ## Why this is a route rather than Storybook
 *
 * Recorded as a deliberate deviation in `docs/design-decisions/DD-003`, not an
 * omission. The story's requirement is that agents can inspect the real
 * components and their hard-to-reach states before inventing new patterns; this
 * route does that using the *production* components, in the production CSS
 * cascade, in both locales, with a live theme and reduced-motion switch. A
 * Storybook instance would add a second build, a second styling context and a
 * set of decorators that would need to reproduce the locale provider anyway.
 *
 * What it does not give up: every state below is reachable by URL, so a visual
 * regression tool can screenshot it directly (US-0802 / D-0802).
 *
 * The trade-off it does accept: no isolated per-component addon panel, and no
 * automatic docgen. If either becomes necessary, DD-003 records the path to
 * adding Storybook on top of the same components.
 */
export function DesignCatalog() {
  const { locale, t } = useLocale();
  const [cleanup, setCleanup] = useState(55);
  const audit = auditRegistry();

  return (
    <div className="stage-wide">
      <Stack gap={7}>
        <Stack gap={2}>
          <Text variant="title" as="h1">
            Design catalog
          </Text>
          <Text muted>
            Every primitive and every hard-to-reach state, in the production CSS, in{' '}
            <Bdi>{locale}</Bdi>. Switch locale in the header to review the other direction.
          </Text>
        </Stack>

        <Section title="Tokens">
          <div className={styles.swatches}>
            {[
              ['canvas', '--color-canvas'],
              ['well', '--color-well'],
              ['raised', '--color-raised'],
              ['text', '--color-text'],
              ['muted', '--color-text-muted'],
              ['accent', '--color-accent'],
              ['recording', '--color-recording'],
              ['processing', '--color-processing'],
              ['success', '--color-success'],
              ['danger', '--color-danger'],
              ['raw', '--color-raw'],
              ['clean', '--color-clean'],
            ].map(([name, token]) => (
              <div key={token} className={styles.swatch}>
                <span
                  className={styles.chip}
                  style={{ backgroundColor: `var(${token as string})` }}
                />
                <span className={styles.swatchName}>{name}</span>
                <code className={styles.swatchToken}>{token}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type scale">
          <Stack gap={3}>
            <Text variant="display">Display — {t.landing.lead}</Text>
            <Text variant="title">Title — {t.review.title}</Text>
            <Text variant="heading">Heading — {t.instruments.title}</Text>
            <Text variant="body">Body — {t.app.description}</Text>
            <Text variant="label">Label — {t.review.play}</Text>
            <Text variant="micro">Micro — {t.exportPanel.noWatermark}</Text>
            <Row gap={4}>
              <Readout value={128} unit="BPM" />
              <Readout value="3.4" unit="s" small />
            </Row>
            {/* Mixed-direction specimen: the case bilingual QA has to look at. */}
            <Text>
              نمونه‌ی متن ترکیبی: <Bdi dir="ltr">C#4</Bdi> در <Bdi dir="ltr">128 BPM</Bdi>، فایل{' '}
              <Bdi dir="ltr">sketch.mid</Bdi> روی <Bdi dir="ltr">rhythmisoze.com/s/ab12cd34</Bdi>
            </Text>
          </Stack>
        </Section>

        <Section title="Buttons">
          <Stack gap={4}>
            {(['primary', 'quiet', 'ghost', 'accent', 'danger'] as const).map((kind) => (
              <Row key={kind} gap={3}>
                <StageLabel>{kind}</StageLabel>
                <Button kind={kind} size="small">
                  {t.common.next}
                </Button>
                <Button kind={kind}>{t.common.next}</Button>
                <Button kind={kind} size="large">
                  {t.common.next}
                </Button>
                <Button kind={kind} busy>
                  {t.common.next}
                </Button>
                <Button kind={kind} disabled>
                  {t.common.next}
                </Button>
              </Row>
            ))}
          </Stack>
        </Section>

        <Section title="Surfaces">
          <Stack gap={3}>
            <Well>Well — the default recess for grouped controls.</Well>
            <Well tone="recording">Well, recording tone.</Well>
            <Well tone="processing">Well, processing tone.</Well>
            <Well tone="success">Well, success tone.</Well>
            <Well tone="danger">Well, danger tone.</Well>
            <Well tone="accent">Well, accent tone.</Well>
            <Raised>Raised — one per screen, reserved for the focal object.</Raised>
            <Divider />
          </Stack>
        </Section>

        <Section title="Controls">
          <Stack gap={5}>
            <Slider
              label={t.review.cleanup}
              value={cleanup}
              min={RETOUCH_AMOUNT_MIN}
              max={RETOUCH_AMOUNT_MAX}
              continuum
              valueText={t.review.cleanupLevels[retouchLabel(cleanup)]}
              startLabel={t.review.cleanupLevels.raw}
              endLabel={t.review.cleanupLevels.clean}
              onChange={setCleanup}
            />
            <Slider
              label={t.sound.volume}
              value={70}
              min={0}
              max={100}
              valueText="70%"
              onChange={() => undefined}
            />
            <Slider
              label={t.sound.reverb}
              value={20}
              min={0}
              max={100}
              disabled
              valueText="disabled"
              onChange={() => undefined}
            />
          </Stack>
        </Section>

        <Section title="Recording states">
          <Stack gap={5}>
            {(['armed', 'recording'] as const).map((phase) => (
              <Well key={phase} padding="tight">
                <StageLabel>{phase}</StageLabel>
                <RecordStage
                  phase={phase}
                  level={{
                    rms: 0.22,
                    peak: 0.5,
                    clipping: false,
                    waveform: sampleWaveform(),
                  }}
                  elapsedSec={22}
                  maxSec={60}
                  onStart={() => undefined}
                  onStop={() => undefined}
                  onCancel={() => undefined}
                />
              </Well>
            ))}
          </Stack>
        </Section>

        <Section title="Processing">
          <Stack gap={4}>
            {[0.05, 0.35, 0.8].map((progress) => (
              <ProcessStage
                key={progress}
                progress={{ stage: progress < 0.1 ? 'loading_model' : 'inferring', progress }}
                onCancel={() => undefined}
              />
            ))}
          </Stack>
        </Section>

        <Section title="Piano roll">
          <Stack gap={4}>
            <PianoRoll
              notes={sampleNotes()}
              drums={[]}
              rawNotes={sampleNotes(0.03)}
              durationSec={6}
              bpm={100}
              beatsPerBar={4}
              playhead={0.4}
            />
            <PianoRoll
              notes={[]}
              drums={sampleDrums()}
              durationSec={4}
              bpm={100}
              beatsPerBar={4}
              playhead={null}
            />
            <PianoRoll
              notes={[]}
              drums={[]}
              durationSec={4}
              bpm={100}
              beatsPerBar={4}
              playhead={null}
            />
          </Stack>
        </Section>

        <Section title="Errors">
          <Stack gap={3}>
            {(
              [
                { code: 'mic_permission_denied', recovery: 'check_permissions' },
                { code: 'audio_silent', recovery: 'rerecord' },
                { code: 'model_load_failed', recovery: 'retry' },
                { code: 'storage_quota_exceeded', recovery: 'free_space' },
                { code: 'publish_rate_limited', recovery: 'retry' },
              ] as const
            ).map((error) => (
              <ErrorPanel key={error.code} error={error} onRecover={() => undefined} />
            ))}
          </Stack>
        </Section>

        <Section title="Instrument registry">
          <Stack gap={3}>
            <Text variant="micro" muted>
              {audit.ok
                ? `${INSTRUMENTS.length} instruments registered, licence ledger complete.`
                : `Registry problems: ${audit.problems.join('; ')}`}
            </Text>
            <ul className={styles.registry}>
              {INSTRUMENTS.map((instrument) => (
                <li key={instrument.id} className={styles.registryRow}>
                  <span>{instrument.name[locale]}</span>
                  <code>{instrument.id}</code>
                  <span>{instrument.mode}</span>
                  <span>
                    <Bdi dir="ltr">GM {instrument.gmProgram}</Bdi>
                  </span>
                  <span>{instrument.license.spdx}</span>
                </li>
              ))}
            </ul>
          </Stack>
        </Section>
      </Stack>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section} id={title.toLowerCase().replace(/\s+/g, '-')}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

/** Deterministic sample data, so catalog screenshots are stable. */
function sampleWaveform(): Float32Array {
  const points = new Float32Array(128);
  for (let i = 0; i < points.length; i += 1) {
    points[i] = Math.abs(Math.sin(i * 0.31)) * 0.6 + Math.abs(Math.sin(i * 0.07)) * 0.3;
  }
  return points;
}

function sampleNotes(offset = 0) {
  const pitches = [60, 62, 64, 65, 67, 65, 64, 62, 60, 67, 72, 71, 69, 67];
  return pitches.map((pitch, index) => ({
    startSec: index * 0.42 + offset * ((index % 3) - 1),
    endSec: index * 0.42 + 0.36 + offset,
    pitch: pitch + (offset > 0 && index % 4 === 0 ? 1 : 0),
    velocity: 60 + ((index * 13) % 60),
  }));
}

function sampleDrums() {
  const pattern: Array<[number, 'kick' | 'snare' | 'hat']> = [
    [0, 'kick'],
    [0.25, 'hat'],
    [0.5, 'snare'],
    [0.75, 'hat'],
    [1, 'kick'],
    [1.25, 'hat'],
    [1.5, 'snare'],
    [1.75, 'hat'],
  ];
  return pattern.flatMap(([time, drum]) =>
    [0, 2].map((bar) => ({
      timeSec: time + bar,
      drum,
      velocity: drum === 'hat' ? 62 : 108,
      confidence: 0.9,
    })),
  );
}
