/**
 * Direct port of `humtool.py`.
 *
 * ------------------------------------------------------------------------
 * RULE FOR THIS FILE: it mirrors the Python source function-for-function.
 * No algorithmic improvement belongs here (Playbook 8.5, US-0401:
 * "No algorithmic change is mixed into the first port"). Anything the product
 * needs beyond the reference behaviour lives in `extensions.ts` and is applied
 * by `pipeline.ts` around these functions, never inside them.
 * ------------------------------------------------------------------------
 *
 * Python source of record: `Rhythmisoze_Agent_Development_Package/humtool.py`.
 * Each function below names the Python function it corresponds to.
 */

import {
  PITCH_CLASS_NAMES,
  type GridNote,
  type KeyMode,
  type MusicalKey,
  type NoteEvent,
  type PitchClassName,
} from '@contracts';
import { floorDiv, mod, pearson, pyMedian, pyRound, roll, sum } from './numeric';

/** `MAJ` / `MIN` - Krumhansl-Schmuckler key profiles, verbatim from the source. */
export const KS_MAJOR_PROFILE: readonly number[] = Object.freeze([
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
]);

export const KS_MINOR_PROFILE: readonly number[] = Object.freeze([
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
]);

export const MAJOR_SCALE_DEGREES: readonly number[] = Object.freeze([0, 2, 4, 5, 7, 9, 11]);
export const MINOR_SCALE_DEGREES: readonly number[] = Object.freeze([0, 2, 3, 5, 7, 8, 10]);

/**
 * `load()` - the Python tool reads a MIDI file and sorts notes by start time.
 * In the browser the notes already arrive as a `NoteEvent[]` from the
 * transcriber contract, so only the sort survives. It matters: `estimate_tempo`
 * walks the list assuming ascending onsets.
 */
export function sortNotes(notes: readonly NoteEvent[]): NoteEvent[] {
  return [...notes].sort((a, b) => a.startSec - b.startSec);
}

export interface OctaveFilterResult {
  kept: NoteEvent[];
  dropped: number;
}

/**
 * `strip_octave_errors(notes, tol=12)`
 *
 * "Pitch trackers commonly report harmonics an octave or two up. Drop them."
 * Keeps notes within `tol` semitones of the median pitch.
 */
export function stripOctaveErrors(
  notes: readonly NoteEvent[],
  tol = 12,
  trustedCenterPitch?: number,
): OctaveFilterResult {
  if (notes.length === 0) return { kept: [], dropped: 0 };
  const median =
    trustedCenterPitch !== undefined && Number.isFinite(trustedCenterPitch)
      ? trustedCenterPitch
      : pyMedian(notes.map((n) => n.pitch));
  const kept = notes.filter((n) => Math.abs(n.pitch - median) <= tol);
  return { kept, dropped: notes.length - kept.length };
}

export interface TempoEstimate {
  bpm: number;
  /** Mean distance from the 16th-note grid, in grid steps. <0.10 tight, >0.20 loose. */
  gridError: number;
}

/**
 * `estimate_tempo(notes, lo=50, hi=180)`
 *
 * "Pick the BPM whose 16th-note grid the onsets fall closest to."
 *
 * Product note: this is *diagnostic only*. Rhythmisoze takes its tempo from the
 * user's taps and metronome (PRD R-02/R-03, Playbook 2.5) precisely because
 * this search was measured oscillating between 68, 84 and 174 BPM on real
 * input. The value is shown as "what the app heard", never used to quantize.
 */
export function estimateTempo(notes: readonly NoteEvent[], lo = 50, hi = 180): TempoEstimate {
  const onsets: number[] = [];
  for (const note of notes) {
    const last = onsets[onsets.length - 1];
    if (last === undefined || note.startSec - last > 0.06) onsets.push(note.startSec);
  }
  if (onsets.length < 4) return { bpm: 80, gridError: 1 };

  let best: TempoEstimate = { bpm: 80, gridError: 1 };
  // `range(lo*10, hi*10+1, 5)` - 0.5 BPM resolution, ascending, first match wins ties.
  for (let bpm10 = lo * 10; bpm10 <= hi * 10; bpm10 += 5) {
    const bpm = bpm10 / 10;
    const step = 60 / bpm / 4;
    // `mod`, not `%`: an onset can be negative when a transcriber places a note
    // slightly before zero, and JavaScript's remainder keeps the sign while
    // Python's modulo does not. Using `%` here silently changes the reported
    // grid error on exactly those takes.
    const err =
      sum(onsets.map((o) => Math.min(mod(o, step), step - mod(o, step)))) / onsets.length / step;
    if (err < best.gridError) best = { bpm, gridError: err };
  }
  return best;
}

/**
 * `detect_key(notes)`
 *
 * Weighted pitch-class histogram correlated against the 12 rotations of both
 * Krumhansl-Schmuckler profiles. Short notes are floored at 50 ms so a flurry of
 * transcription specks cannot outvote a held note.
 *
 * Returns NaN confidence when the histogram is flat, mirroring `np.corrcoef`.
 * `pipeline.ts` - not this function - decides what an undefined key means for
 * the user.
 */
export function detectKey(notes: readonly NoteEvent[]): MusicalKey {
  const hist = new Array<number>(12).fill(0);
  for (const note of notes) {
    const pc = mod(note.pitch, 12);
    hist[pc] = (hist[pc] as number) + Math.max(note.endSec - note.startSec, 0.05);
  }
  const total = sum(hist);
  if (total === 0) return { root: 'D', mode: 'minor', confidence: 0 };

  const normalized = hist.map((h) => h / total);
  const profiles: ReadonlyArray<readonly [readonly number[], KeyMode]> = [
    [KS_MAJOR_PROFILE, 'major'],
    [KS_MINOR_PROFILE, 'minor'],
  ];

  let best: MusicalKey | null = null;
  for (let i = 0; i < 12; i += 1) {
    for (const [profile, mode] of profiles) {
      const profileTotal = sum(profile);
      const rotated = roll(
        profile.map((p) => p / profileTotal),
        i,
      );
      const r = pearson(normalized, rotated);
      // Strict `>` and NaN comparisons both mirror the Python control flow.
      if (best === null || r > best.confidence) {
        best = { root: PITCH_CLASS_NAMES[i] as PitchClassName, mode, confidence: r };
      }
    }
  }
  return best as MusicalKey;
}

export interface QuantizeResult {
  notes: GridNote[];
  /** Duration of one grid step in seconds. */
  stepSec: number;
}

/**
 * `quantize(notes, bpm, div=4, min_len=1)`
 *
 * "Snap onsets and durations to a 1/(4*div) grid. div=4 -> sixteenths."
 *
 * Two details are load-bearing and easy to lose in translation:
 *  - rounding is Python's round-half-to-even, see `pyRound`;
 *  - the duplicate check compares against the *last appended* note in input
 *    order, before the final sort, so it only collapses runs, not every
 *    same-step/same-pitch pair.
 */
export function quantize(
  notes: readonly NoteEvent[],
  bpm: number,
  div = 4,
  minLen = 1,
): QuantizeResult {
  const stepSec = 60 / bpm / div;
  const out: GridNote[] = [];
  for (const note of notes) {
    const step = pyRound(note.startSec / stepSec);
    const lengthSteps = Math.max(minLen, pyRound((note.endSec - note.startSec) / stepSec));
    const last = out[out.length - 1];
    if (last !== undefined && last.step === step && last.pitch === note.pitch) continue;
    out.push({ step, lengthSteps, pitch: note.pitch, velocity: note.velocity });
  }
  // Python's sort is stable; the ES spec has required a stable sort since 2019.
  out.sort((a, b) => a.step - b.step || a.pitch - b.pitch);
  return { notes: out, stepSec };
}

export interface ScaleSnapResult {
  notes: GridNote[];
  moved: number;
}

/**
 * `snap_to_scale(qnotes, root, mode)`
 *
 * Moves every out-of-scale pitch to the nearest scale degree, by the shortest
 * path around the octave. Full strength - `extensions.ts` adds the partial
 * behaviour the Raw-to-Clean control needs.
 */
export function snapToScale(
  notes: readonly GridNote[],
  root: PitchClassName,
  mode: KeyMode,
): ScaleSnapResult {
  const scale = mode === 'major' ? MAJOR_SCALE_DEGREES : MINOR_SCALE_DEGREES;
  const rootIndex = PITCH_CLASS_NAMES.indexOf(root);
  let moved = 0;
  const out = notes.map((note) => {
    const pc = mod(note.pitch - rootIndex, 12);
    if (scale.includes(pc)) return { ...note };
    const delta = scaleSnapDelta(pc, scale);
    moved += 1;
    return { ...note, pitch: note.pitch + delta };
  });
  return { notes: out, moved };
}

/**
 * The pitch offset `snap_to_scale` would apply to a pitch class.
 * Extracted so the partial-strength variant can rank candidates without
 * duplicating the wrap-around arithmetic.
 */
export function scaleSnapDelta(pitchClass: number, scale: readonly number[]): number {
  let bestDegree = scale[0] as number;
  let bestDistance = Number.POSITIVE_INFINITY;
  // `min(..., key=...)` keeps the first minimum, so compare with strict `<`.
  for (const degree of scale) {
    const distance = Math.min(Math.abs(degree - pitchClass), 12 - Math.abs(degree - pitchClass));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestDegree = degree;
    }
  }
  let delta = bestDegree - pitchClass;
  if (delta > 6) delta -= 12;
  if (delta < -6) delta += 12;
  return delta;
}

/**
 * `percussion_map(qnotes, split=None)`
 *
 * "Two-register voice sketch -> GM drum map. Low = kick, high = snare."
 * Splits at the median pitch when no split is supplied.
 *
 * This is the reference two-way mapping. The product's Rhythm mode uses the
 * three-class onset classifier in `audio-core` instead (US-0501..US-0503);
 * this function stays as the golden reference and as the fallback used when a
 * pitched take is reinterpreted as percussion.
 */
export function percussionMap(notes: readonly GridNote[], split?: number): GridNote[] {
  if (notes.length === 0) return [];
  const threshold = split ?? pyMedian(notes.map((n) => n.pitch));
  return notes.map((note) => ({ ...note, pitch: note.pitch < threshold ? 36 : 38 }));
}

export interface MusicalReport {
  notesIn: number;
  octaveErrorsRemoved: number;
  bpm: number;
  gridError: number;
  key: MusicalKey;
  lowestPitch: number;
  highestPitch: number;
  /** Percentage of note-to-note moves that repeat the same pitch. */
  repeatedMovePercent: number;
  /** Percentage of moves that travel exactly one semitone. */
  semitoneStepPercent: number;
  /** repeated + semitone. High means creeping, low means leaping. */
  stepwiseTotalPercent: number;
}

/** `report(raw, kept, dropped, bpm, err, key, qnotes)` - the numbers, not the text. */
export function buildReport(
  rawCount: number,
  kept: readonly NoteEvent[],
  dropped: number,
  tempo: TempoEstimate,
  key: MusicalKey,
  qnotes: readonly GridNote[],
): MusicalReport {
  const pitches = kept.map((n) => n.pitch);
  const intervals: number[] = [];
  for (let i = 1; i < qnotes.length; i += 1) {
    intervals.push(Math.abs((qnotes[i] as GridNote).pitch - (qnotes[i - 1] as GridNote).pitch));
  }
  const repeats = intervals.filter((i) => i === 0).length;
  const steps = intervals.filter((i) => i === 1).length;
  const pct = (n: number) => (intervals.length === 0 ? 0 : (100 * n) / intervals.length);

  return {
    notesIn: rawCount,
    octaveErrorsRemoved: dropped,
    bpm: tempo.bpm,
    gridError: tempo.gridError,
    key,
    lowestPitch: pitches.length > 0 ? Math.min(...pitches) : 0,
    highestPitch: pitches.length > 0 ? Math.max(...pitches) : 0,
    repeatedMovePercent: pct(repeats),
    semitoneStepPercent: pct(steps),
    stepwiseTotalPercent: pct(repeats + steps),
  };
}

/** Scientific pitch name, e.g. MIDI 60 -> "C4". Matches the Python report format. */
export function pitchName(midi: number): string {
  return `${PITCH_CLASS_NAMES[mod(midi, 12)]}${floorDiv(midi, 12) - 1}`;
}

/**
 * `grid_view(qnotes, div=4, bars=8)`
 *
 * The Python tool's text grid. Kept because it is the fastest way to eyeball a
 * fixture in a failing test, and it is what the golden files record.
 */
export function gridView(notes: readonly GridNote[], div = 4, bars = 8): string {
  const perBar = 4 * div;
  const rows = new Map<number, GridNote[]>();
  for (const note of notes) {
    const bar = floorDiv(note.step, perBar);
    const list = rows.get(bar);
    if (list) list.push(note);
    else rows.set(bar, [note]);
  }
  const lines: string[] = [];
  for (const bar of [...rows.keys()].sort((a, b) => a - b).slice(0, bars)) {
    const cells = new Array<string>(perBar).fill('.');
    const inBar = rows.get(bar) as GridNote[];
    for (const note of inBar) {
      cells[mod(note.step, perBar)] = note.velocity >= 70 ? 'X' : note.velocity >= 45 ? 'x' : 'o';
    }
    const names = [...inBar]
      .sort((a, b) => a.step - b.step || a.pitch - b.pitch)
      .map((n) => pitchName(n.pitch))
      .join(' ');
    lines.push(`bar ${String(bar + 1).padStart(2, ' ')} |${cells.join('')}|  ${names}`);
  }
  return lines.join('\n');
}
