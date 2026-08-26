/**
 * Deciding which octave a note is in, when the engines disagree.
 *
 * ## The failure this exists to fix
 *
 * `diff-octave-leap` is a C4→C5→C4 phrase synthesised with exact ground truth.
 * The contour engine reports C4→C4→C4: 98.9% chroma accuracy, 32.6% octave
 * error. YIN locks onto the subharmonic of the middle note and is then entirely
 * confident about it, so nothing downstream that reads only its output can tell
 * the difference between a leap and a repeat.
 *
 * Until now the correct response was to do nothing. The Judge's octave repair
 * defers to the candidate's register on purpose — the contour engine voted with
 * frames the Judge cannot see — and a second opinion with *less* information
 * overruling it is how a good take gets moved to the wrong octave. So conflicts
 * were reported and left alone.
 *
 * What has changed is that there is now a second opinion with *different*
 * information rather than less: an independent model reading the same audio,
 * measured at 0% octave error on the very case the contour engine fails. That
 * makes a correction defensible for the first time.
 *
 * ## Why this is not a vote
 *
 * The obvious rule — "if the witness says an octave up, go an octave up" —
 * breaks a case that currently works, and the corpus says so plainly.
 *
 * On `diff-harmonic-heavy` the contour engine is completely correct (57, 60,
 * 64) and Basic Pitch emits harmonics as if they were notes:
 *
 * ```
 * span            witness says
 * 0.20–0.84       57  and  69          (57 + 12)
 * 0.88–1.09       79   +   72          (60 + 12), no 60 at all
 * 1.60–2.23       64  and  76          (64 + 12)
 * ```
 *
 * The middle span is the trap. The witness never reports the fundamental, and
 * one of the two things it does report is exactly an octave above the contour
 * engine's note — the same shape as a genuine subharmonic error, arrived at for
 * the opposite reason.
 *
 * Two measurements separate them, and both are needed:
 *
 *  1. **Coverage.** A real correction is a witness that hears the other octave
 *     *for the whole note*. On the octave leap the C5 covers 95% of the span;
 *     on the harmonic trap the octave-up candidate covers 26%.
 *  2. **Dominance.** A witness reporting harmonic clutter is not testifying
 *     about the octave at all. On the trap the loudest thing it reports over
 *     that span is 79 — a different pitch class entirely — which disqualifies
 *     the reading rather than merely outranking it.
 *
 * Both gates hold on all nine corpus cases, and `register.test.ts` pins the two
 * that matter in opposite directions: the leap must be corrected and the
 * harmonic case must be left alone.
 *
 * ## Why one witness is not enough
 *
 * The coverage and dominance gates were derived from synthesised audio, and on
 * synthesised audio they are sufficient. On the four pinned real recordings
 * they are not. Basic Pitch alone moved seven notes there, and the takes are
 * real performances by one person, so some of those moves could be checked
 * against a second model instead of against an assumption about what a singer
 * would plausibly do.
 *
 * ```
 * take               span      contour   basic-pitch   GAME
 * real-mouth-test3   1.07 s    60        48            48
 * real-mouth-test3   5.37 s    60        48            48
 * real-mouth-test3   8.84 s    59        47            47
 * real-recording-8   6.70 s    53        65            65
 * real-test22        1.56 s    57        45            53
 * real-test22        2.30 s    57        45            64
 * ```
 *
 * The first four are two independent models, both trained on real singing,
 * agreeing against a YIN-derived tracker — which is the case this whole
 * mechanism was built for, and the contour engine is very likely the one that
 * is wrong. The last two are the witnesses disagreeing with each other *and*
 * with the candidate, which is not evidence for any particular answer.
 *
 * A single witness cannot tell those two situations apart, because in both of
 * them it says the same thing with the same confidence. Corroboration can, and
 * it needs no assumption about which intervals a person is likely to sing.
 *
 * So a correction requires either two witnesses that agree, or one whose
 * register strength is high enough to stand alone. With Basic Pitch as the only
 * witness — the default configuration, and the only one available when the
 * optional transcription service is not deployed — disagreements are *reported
 * and not applied*. That is strictly more information than the product had
 * before, and it moves no note on evidence that has not been corroborated.
 *
 * ## What it will not do
 *
 * Move a note by anything other than one octave. A two-octave gap is not what a
 * subharmonic error looks like, and a non-octave disagreement is not a register
 * question — it is two engines hearing different notes, which is a real finding
 * that belongs in the record rather than a licence to overwrite one of them.
 */

import type { NoteEvent } from '@contracts';
import type { EvidenceEngineId, EvidenceNote, EvidenceSource } from './types';
import { strengthsOf } from './types';

export interface RegisterArbitrationOptions {
  /**
   * How much of the note the other octave has to cover before it counts.
   *
   * 0.6 sits between the two measured populations with room on both sides: real
   * corrections covered 95% of their note, the harmonic artifact covered 26%.
   */
  minCoverage: number;
  /**
   * How far ahead of the runner-up the winning pitch has to be.
   *
   * Guards the case where a witness reports several things over one span. If it
   * cannot make up its mind, it is not evidence for moving anything.
   */
  minDominance: number;
  /**
   * Below this, a witness that merely *mentions* the candidate's pitch is not
   * treated as having confirmed it.
   *
   * Exists so a witness that fell silent for most of a note — Basic Pitch
   * reports 0.11 s of a 2 s hum — is neither agreement nor disagreement.
   */
  presenceFloor: number;
  /** Engines below this register strength are not consulted. */
  minRegisterStrength: number;
  /**
   * How many witnesses have to agree on the other octave before a note moves.
   *
   * Two, unless one of them is authoritative enough on its own — see
   * `soloRegisterStrength`. One witness cannot distinguish "the tracker is
   * wrong" from "this span is genuinely ambiguous", and the pinned recordings
   * contain both.
   */
  minWitnesses: number;
  /**
   * Register strength at which a single engine may correct unaided.
   *
   * The mechanism the guide describes — "a voice-specialist can legitimately
   * outweigh two weaker general systems on a clearly vocal span" — written as a
   * number, and deliberately set above every engine currently in the roster.
   *
   * The best of them measures 2.2% octave error on synthesised material and has
   * no measured register accuracy on real takes at all, because no ground truth
   * exists for the pinned recordings. Letting it act alone on that basis would
   * be asserting an authority nobody has demonstrated. So corroboration is
   * currently always required, and this threshold is what a future engine would
   * have to earn rather than a door standing open.
   */
  soloRegisterStrength: number;
}

export const DEFAULT_REGISTER_OPTIONS: RegisterArbitrationOptions = Object.freeze({
  minCoverage: 0.6,
  minDominance: 0.2,
  presenceFloor: 0.15,
  minRegisterStrength: 0.5,
  minWitnesses: 2,
  soloRegisterStrength: 0.95,
});

/** What happened to one note's register, and on what grounds. */
export type RegisterOutcome =
  /** A witness heard the candidate's own pitch over this note. */
  | 'agreed'
  /** A witness heard the other octave, clearly and for the whole note. */
  | 'corrected'
  /** An octave away, but only across part of the note. */
  | 'declined_partial'
  /** The witness reported several things, or something unrelated. */
  | 'declined_contested'
  /** Clear evidence, from too few engines to act on. */
  | 'declined_uncorroborated'
  /** No witness said anything about this span. */
  | 'no_evidence';

/**
 * One note's register decision, kept whether or not anything moved.
 *
 * The declines are the interesting half. A correction that fired is visible in
 * the notes; a correction that was considered and refused is invisible unless
 * it is written down, and those are exactly the cases where a take comes out
 * wrong and nobody can say why.
 */
export interface RegisterDecision {
  /** Index into the candidate note list. */
  noteIndex: number;
  startSec: number;
  fromPitch: number;
  /** Equal to `fromPitch` unless the outcome is `corrected`. */
  toPitch: number;
  outcome: RegisterOutcome;
  /** Which engine's reading drove it, when one did. */
  engineId: EvidenceEngineId | null;
  /** Every engine that reported the winning pitch over this note. */
  agreeingEngines: EvidenceEngineId[];
  /** The winning pitch's share of the note's duration, 0..1. */
  coverage: number;
  /** Winner's coverage minus the runner-up's, 0..1. */
  dominance: number;
  /** Human-readable, for the debug view and the diagnostics warnings. */
  reason: string;
}

export interface RegisterArbitration {
  /** The candidate notes, with corrected registers applied. */
  notes: NoteEvent[];
  decisions: RegisterDecision[];
  /** How many notes moved. */
  corrected: number;
  /** Notes where a witness disagreed but the evidence did not support acting. */
  unresolved: number;
}

/** Seconds of `[aStart, aEnd)` that also lie inside `[bStart, bEnd)`. */
function overlapSec(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

interface Tally {
  pitch: number;
  /** Summed across engines, so a pitch two engines heard outranks one. */
  coverage: number;
  /** The engine with the most coverage of this pitch, for attribution. */
  engineId: EvidenceEngineId;
  /** Every engine that reported this pitch over the note, best first. */
  engines: EvidenceEngineId[];
  /** The best single engine's register strength, for the solo rule. */
  bestStrength: number;
}

/**
 * How much of one note each pitch a witness reported covers.
 *
 * Pitches are rounded to the semitone here, and only here: fractional pitch is
 * what an engine measured, but the question being asked is which of twelve
 * names in which octave, and two readings 30 cents apart are the same answer.
 */
function tally(
  note: NoteEvent,
  sources: readonly EvidenceSource[],
  options: RegisterArbitrationOptions,
): Tally[] {
  const duration = Math.max(1e-6, note.endSec - note.startSec);
  const byPitch = new Map<number, Tally>();

  // Per engine first, then merged. Summing straight into one bucket would let a
  // single engine that reported the same pitch twice look like two witnesses,
  // which is exactly the distinction the corroboration rule turns on.
  const perEngine = new Map<EvidenceEngineId, Map<number, number>>();
  for (const source of sources) {
    if (strengthsOf(source.engineId).register < options.minRegisterStrength) continue;
    const engineCoverage = perEngine.get(source.engineId) ?? new Map<number, number>();
    perEngine.set(source.engineId, engineCoverage);
    for (const heard of source.notes as readonly EvidenceNote[]) {
      const seconds = overlapSec(note.startSec, note.endSec, heard.startSec, heard.endSec);
      if (seconds <= 0) continue;
      const pitch = Math.round(heard.pitch);
      engineCoverage.set(pitch, (engineCoverage.get(pitch) ?? 0) + seconds / duration);
    }
  }

  for (const [engineId, engineCoverage] of perEngine) {
    const strength = strengthsOf(engineId).register;
    for (const [pitch, coverage] of engineCoverage) {
      const capped = Math.min(1, coverage);
      const existing = byPitch.get(pitch);
      if (existing === undefined) {
        byPitch.set(pitch, {
          pitch,
          coverage: capped,
          engineId,
          engines: [engineId],
          bestStrength: strength,
        });
        continue;
      }
      // The reported coverage is the best single engine's rather than the sum:
      // two engines agreeing is corroboration, not twice the duration.
      if (capped > existing.coverage) {
        existing.coverage = capped;
        existing.engineId = engineId;
      }
      existing.engines.push(engineId);
      existing.bestStrength = Math.max(existing.bestStrength, strength);
    }
  }

  return [...byPitch.values()].sort(
    (a, b) => b.engines.length - a.engines.length || b.coverage - a.coverage,
  );
}

/**
 * Applies the register witnesses to a candidate transcription.
 *
 * Pure, and returns new notes rather than mutating: the candidate is evidence
 * in its own right and something downstream still needs to be able to see it
 * unchanged.
 */
export function arbitrateRegister(
  candidate: readonly NoteEvent[],
  sources: readonly EvidenceSource[],
  overrides: Partial<RegisterArbitrationOptions> = {},
): RegisterArbitration {
  const options = { ...DEFAULT_REGISTER_OPTIONS, ...overrides };
  const notes: NoteEvent[] = [];
  const decisions: RegisterDecision[] = [];
  let corrected = 0;
  let unresolved = 0;

  candidate.forEach((note, noteIndex) => {
    const ranked = tally(note, sources, options);
    const base = { noteIndex, startSec: note.startSec, fromPitch: note.pitch, toPitch: note.pitch };
    const best = ranked[0];
    const runnerUp = ranked[1];

    const record = (
      outcome: RegisterOutcome,
      reason: string,
      extra: Partial<RegisterDecision> = {},
    ): void => {
      decisions.push({
        ...base,
        outcome,
        engineId: best?.engineId ?? null,
        agreeingEngines: best?.engines ?? [],
        coverage: best?.coverage ?? 0,
        dominance: (best?.coverage ?? 0) - (runnerUp?.coverage ?? 0),
        reason,
        ...extra,
      });
    };

    if (best === undefined) {
      notes.push(note);
      record('no_evidence', 'no witness covered this note');
      return;
    }

    const localPitch = Math.round(note.pitch);
    const localCoverage = ranked.find((entry) => entry.pitch === localPitch)?.coverage ?? 0;

    // The witness heard this note where the candidate put it. Anything else it
    // reported over the same span is a harmonic or a second voice, not a claim
    // that the candidate is in the wrong octave.
    if (best.pitch === localPitch || localCoverage >= options.presenceFloor) {
      notes.push(note);
      record('agreed', `witness heard ${localPitch} over ${(localCoverage * 100).toFixed(0)}% of the note`);
      return;
    }

    const semitones = best.pitch - localPitch;
    if (Math.abs(semitones) !== 12) {
      // Two engines heard different notes. A real finding, and not one this
      // arbitration is entitled to resolve — it only knows about octaves.
      notes.push(note);
      unresolved += 1;
      record(
        'declined_contested',
        `witness heard ${best.pitch} against ${localPitch}, which is not an octave apart`,
      );
      return;
    }

    if (best.coverage < options.minCoverage) {
      notes.push(note);
      unresolved += 1;
      record(
        'declined_partial',
        `octave evidence covered only ${(best.coverage * 100).toFixed(0)}% of the note`,
      );
      return;
    }

    const dominance = best.coverage - (runnerUp?.coverage ?? 0);
    if (dominance < options.minDominance) {
      notes.push(note);
      unresolved += 1;
      record(
        'declined_contested',
        `witness reported ${ranked.length} pitches over this note without settling on one`,
      );
      return;
    }

    // Corroboration, last, because it is the only gate that is about *who* said
    // something rather than what was said. One witness saying this clearly is a
    // real observation and is recorded as one; it is just not enough to move a
    // note, because a lone witness reports an ambiguous span and a genuinely
    // mistracked one in exactly the same words.
    const corroborated =
      best.engines.length >= options.minWitnesses ||
      best.bestStrength >= options.soloRegisterStrength;
    if (!corroborated) {
      notes.push(note);
      unresolved += 1;
      record(
        'declined_uncorroborated',
        `only ${best.engines.join(', ')} heard ${best.pitch} here; a register correction needs corroboration`,
      );
      return;
    }

    notes.push({ ...note, pitch: localPitch + semitones });
    corrected += 1;
    decisions.push({
      ...base,
      toPitch: localPitch + semitones,
      outcome: 'corrected',
      engineId: best.engineId,
      agreeingEngines: best.engines,
      coverage: best.coverage,
      dominance,
      reason:
        `${best.engines.join(' and ')} heard ${best.pitch} across ` +
        `${(best.coverage * 100).toFixed(0)}% of the note while the contour engine read ${localPitch}`,
    });
  });

  return { notes, decisions, corrected, unresolved };
}

/** The decisions worth putting in the diagnostics warning list. */
export function notableDecisions(arbitration: RegisterArbitration): RegisterDecision[] {
  return arbitration.decisions.filter((decision) => decision.outcome !== 'agreed' && decision.outcome !== 'no_evidence');
}
