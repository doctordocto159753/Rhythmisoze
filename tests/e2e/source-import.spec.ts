import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Midi } from '@tonejs/midi';
import { expect, test } from '@playwright/test';

const AUDIO_FIXTURE = resolve(__dirname, '../fixtures/audio/hum-melody.wav');

test('audio upload follows the real transcription path and packages the untouched WAV', async ({
  page,
}) => {
  await page.goto('/en');
  const audioInput = page.getByLabel('Choose a recording to upload');
  await expect(audioInput).toBeDisabled();
  await setBpm(page, 120);
  await expect(audioInput).toBeEnabled();
  await audioInput.setInputFiles(AUDIO_FIXTURE);

  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
    timeout: 90_000,
  });
  await page.getByRole('button', { name: /^Details$/ }).click();
  await expect(page.getByText(/human melody engine/i).first()).toBeVisible();

  await page.getByRole('button', { name: /Take it with you/i }).click();
  await expect(page.getByRole('heading', { name: /Complete package/i })).toBeVisible({
    timeout: 90_000,
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download complete package/i }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const entries = readStoredZip(readFileSync(path as string));
  // One MIDI per version that has notes, plus `notes.mid` at its original name
  // so an existing reader keeps working. The Musician was never asked here, so
  // its two versions must be absent -- an empty musician-refined.mid would
  // suggest a generation happened when none did.
  expect([...entries.keys()]).toEqual([
    'rendered.wav',
    'notes.mid',
    'unprocessed.mid',
    'judge.mid',
    'teacher.mid',
    'source/hum-melody.wav',
    'manifest.json',
  ]);
  expect([...entries.keys()].some((name) => name.startsWith('musician-'))).toBe(false);
  expect(entries.get('source/hum-melody.wav')).toEqual(readFileSync(AUDIO_FIXTURE));

  const midi = new Midi(entries.get('notes.mid'));
  const notes = midi.tracks.flatMap((track) => track.notes);
  expect(notes.length).toBeGreaterThan(2);
  expect(maxPolyphony(notes)).toBe(1);
  expect(notes.some((note) => note.midi === 33 || note.midi === 45)).toBe(false);

  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json'))) as {
    source: { kind: string; filename: string; bytes: number };
    selectedVersionId: string | null;
    versions: { id: string; file: string; derivedFrom: string | null; provenance: unknown }[];
  };

  // A package with several MIDI files gives no way to tell which one the WAV
  // was rendered from unless the manifest says so.
  expect(manifest.selectedVersionId).toBeTruthy();
  expect(manifest.versions.map((version) => version.id)).toEqual([
    'unprocessed',
    'judge',
    'teacher',
  ]);

  // The pipeline relationships, so a reader can reconstruct how each version
  // came to exist without knowing the product.
  expect(manifest.versions.find((version) => version.id === 'unprocessed')?.derivedFrom).toBeNull();
  expect(manifest.versions.find((version) => version.id === 'judge')?.derivedFrom).toBe(
    'unprocessed',
  );
  expect(manifest.versions.find((version) => version.id === 'teacher')?.derivedFrom).toBe('judge');
  // No AI ran, so there is no model provenance to record.
  expect(manifest.versions.every((version) => version.provenance === null)).toBe(true);
  expect(manifest.source).toEqual(
    expect.objectContaining({
      kind: 'audio-upload',
      filename: 'hum-melody.wav',
      bytes: readFileSync(AUDIO_FIXTURE).length,
    }),
  );
});

test('a rejected audio file can be replaced without losing the configured tempo', async ({
  page,
}) => {
  await page.goto('/en');
  await setBpm(page, 120);
  const audioInput = page.getByLabel('Choose a recording to upload');
  await audioInput.setInputFiles({
    name: 'not-a-recording.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not audio'),
  });

  await expect(page.getByRole('alert').filter({ hasText: /supported format/i })).toBeVisible();
  await page.getByRole('button', { name: /Try again/i }).click();
  await expect(audioInput).toBeEnabled();
  await audioInput.setInputFiles(AUDIO_FIXTURE);
  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
    timeout: 90_000,
  });
});

test('audio routing is automatic and its decision is visible in review', async ({ page }) => {
  await page.goto('/en');
  await setBpm(page, 120);
  await page.getByLabel('Choose a recording to upload').setInputFiles(AUDIO_FIXTURE);

  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByRole('heading', { name: /Detected material/i })).toBeVisible();
  await expect(page.getByText(/Melody.*confidence/i)).toBeVisible();
  await page.getByRole('button', { name: /^Details$/ }).click();
  await expect(page.getByText(/Input classifier/i)).toBeVisible();
  await expect(page.getByText(/Classifier reasoning/i)).toBeVisible();
});

test('MIDI import works before tempo setup, persists its source and renders a package', async ({
  page,
}) => {
  const sourceMidi = makeMidiFixture();
  await page.goto('/en');
  await page.getByLabel('Choose a MIDI file to import').setInputFiles({
    name: 'phrase.mid',
    mimeType: 'audio/midi',
    buffer: Buffer.from(sourceMidi),
  });

  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible();
  await page.getByRole('button', { name: /^Details$/ }).click();
  await expect(page.getByText(/imported MIDI/i).first()).toBeVisible();

  await expect
    .poll(
      async () =>
      page.evaluate(
        async () => {
          // Do not call indexedDB.open before the debounced autosave has
          // created the database: opening an absent database here would create
          // an empty v1 database and race Dexie's schema initialization.
          const databases = await indexedDB.databases();
          if (!databases.some((database) => database.name === 'rhythmisoze')) return 0;

          return new Promise<number>((resolveCount, reject) => {
            const open = indexedDB.open('rhythmisoze');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const request = db.transaction('blobs').objectStore('blobs').getAll();
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                resolveCount(
                  (request.result as Array<{ key: string }>).filter((row) =>
                    row.key.endsWith(':source'),
                  ).length,
                );
                db.close();
              };
            };
          });
        },
      ),
      { timeout: 15_000 },
    )
    .toBe(1);

  await page.getByRole('button', { name: /Take it with you/i }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download complete package/i }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const entries = readStoredZip(readFileSync(path as string));
  expect(entries.get('source/phrase.mid')).toEqual(sourceMidi);

  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json'))) as {
    bpm: number;
    source: { kind: string };
  };
  expect(manifest.bpm).toBe(126);
  expect(manifest.source.kind).toBe('midi-upload');
});

async function setBpm(page: import('@playwright/test').Page, bpm: number): Promise<void> {
  const slider = page.getByRole('slider', { name: /Beats per minute/i });
  await slider.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, bpm);
}

/**
 * The real failure, end to end.
 *
 * A rhythm exported from another application as pitched notes on channel 1 — no
 * General MIDI percussion channel anywhere in it. Rhythmisoze used to read the
 * absence of channel 10 as proof that the user's rhythm was really a melody,
 * and quietly moved them into Melody mode.
 */
test('an ambiguous pitched rhythm preserves both readings and can be corrected without re-uploading', async ({ page }) => {
  await page.goto('/en');

  await page.getByLabel('Choose a MIDI file to import').setInputFiles({
    name: 'pitched-rhythm.mid',
    mimeType: 'audio/midi',
    buffer: Buffer.from(readFileSync(resolve(__dirname, '../fixtures/midi/pitched-rhythm-export.mid'))),
  });

  await expect(page.getByRole('heading', { name: /Your sketch/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Mixed melody and rhythm.*confidence/i)).toBeVisible();

  // Mixed is preservation-first: the same pitched events remain available as
  // notes and as rhythmic layers instead of being destructively split by a
  // duration threshold.
  await page.getByRole('button', { name: /Unprocessed/i }).click();
  const rawNotes = page.getByText(/\d+ notes/i).first();
  await expect(rawNotes).toBeVisible();
  // Review applies the cleanup preview to the selected recipe; exact 145-event
  // source preservation is asserted at the import-plan boundary in unit tests.
  expect(Number(/(\d+)/.exec((await rawNotes.textContent()) ?? '')?.[1] ?? 0)).toBeGreaterThan(120);
  const hits = page.getByText(/\d+ hits/i).first();
  await expect(hits).toBeVisible();
  expect(Number(/(\d+)/.exec((await hits.textContent()) ?? '')?.[1] ?? 0)).toBeGreaterThan(120);

  // Classification is advice, not destructive authority. The same source can
  // be re-read from Review and the correction is recorded in diagnostics.
  await page.getByRole('button', { name: /Correct: rhythm/i }).click();
  const correctedHits = page.getByText(/\d+ hits/i).first();
  await expect(correctedHits).toBeVisible();
  expect(Number(/(\d+)/.exec((await correctedHits.textContent()) ?? '')?.[1] ?? 0)).toBeGreaterThan(140);
  await expect(page.getByText(/\d+ notes/i)).toHaveCount(0);
  await expect(page.getByText(/Route corrected after review/i)).toBeVisible();
});

function makeMidiFixture(): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(126);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] });
  const track = midi.addTrack();
  track.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 });
  track.addNote({ midi: 62, time: 0.5, duration: 0.5, velocity: 0.82 });
  track.addNote({ midi: 64, time: 1, duration: 0.5, velocity: 0.84 });
  track.addNote({ midi: 65, time: 1.5, duration: 0.5, velocity: 0.86 });
  return midi.toArray();
}

function maxPolyphony(notes: Array<{ time: number; duration: number }>): number {
  const points = notes.flatMap((note) => [
    { time: note.time, delta: 1 },
    { time: note.time + note.duration, delta: -1 },
  ]);
  points.sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}
