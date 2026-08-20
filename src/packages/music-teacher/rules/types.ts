/**
 * What a rule is.
 *
 * Every rule is a pure function from a melody plus its analysis to a list of
 * *proposals*. Rules never apply their own changes — the pipeline decides what
 * survives, after checking the result against the identity constraints.
 *
 * That separation is what keeps the layer honest. A rule that could apply
 * itself would have to know about identity budgets, and four rules each
 * enforcing that separately is four chances to get it wrong.
 */

import type { NoteEvent } from '@contracts';
import type { MelodyAnalysis } from '../analysis';
import type { TeacherEdit } from '../types';

export interface RuleProposal {
  edit: TeacherEdit;
  /** The note as this rule would have it. */
  note: NoteEvent;
}

export interface TeacherRule {
  id: string;
  /** Why this rule exists, in one line, for the docs and the catalog. */
  purpose: string;
  propose(notes: readonly NoteEvent[], analysis: MelodyAnalysis): RuleProposal[];
}
