/**
 * The rules, in the order a teacher would raise them.
 *
 * The order is pedagogical rather than arbitrary, and it is **fixed rather than
 * searched**:
 *
 *  1. **Notes first.** There is no point discussing rhythm while a note is in
 *     the wrong key — the student would have to relearn the phrase twice.
 *  2. **Then the beat**, once the notes are settled.
 *  3. **Then note lengths**, which only read as uneven after the beat is clear.
 *  4. **Then the shape** — motif consistency and phrase endings, the polish
 *     that only makes sense on a phrase which is otherwise correct.
 *
 * ## Why no search here, when the Judge uses one
 *
 * The Judge searches because it has a measurable target: faithfulness to the
 * audio, which can be scored against ground truth. The Teacher has no ground
 * truth — "would a teacher suggest this?" is a judgement, and its coherence
 * score is a proxy rather than an answer.
 *
 * Searching over rule orderings would therefore be finding the ordering that
 * scores best *against the proxy*, which is exactly how a layer like this
 * starts optimising for its own metric instead of for music. A fixed,
 * explainable order is both safer and faster.
 */

export * from './types';
export * from './key-coherence';
export * from './rhythm-refinement';
export * from './phrase-shaping';
export * from './motif-consistency';

import { keyCoherenceRule } from './key-coherence';
import { motifConsistencyRule } from './motif-consistency';
import { phraseShapingRule } from './phrase-shaping';
import { durationRegularityRule, rhythmRefinementRule } from './rhythm-refinement';
import type { TeacherRule } from './types';

export const TEACHER_RULES: readonly TeacherRule[] = [
  keyCoherenceRule,
  rhythmRefinementRule,
  durationRegularityRule,
  motifConsistencyRule,
  phraseShapingRule,
];
