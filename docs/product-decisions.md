# Frozen product decisions

**US-0001 / Gate G0.** The executable MVP scope, resolved from
`04_PRODUCT_QUESTIONNAIRE.md`. Anything not listed here is out of scope for v1.

Every row is either an **owner answer** taken from the questionnaire, or a
**default applied** where the questionnaire left the item open. Defaults are
marked, because Playbook §3 forbids production behaviour depending silently on
an unanswered question.

---

## A — Before the architecture gate

| Q | Question | Resolution | Source |
|---|---|---|---|
| A-1 | Latest `humtool.py` | Provided. Vendored at `reference/humtool.py` and used to generate the golden fixtures. | Owner |
| A-2 | Golden examples | Owner will provide; **none were available**. A synthetic fixture corpus was built instead, which verifies correctness rather than accuracy on human input. | Owner, gap open |
| A-3 | Target devices | **Not answered.** Default applied: browser families per the PRD, with the performance gate to be judged on one mid-range Android and one recent iPhone rather than flagship hardware. | Default |
| A-4 | Self-hosted server | **Not answered.** Default applied: the server adapter is designed (`AudioTranscriber` accepts a `server` backend) and nothing is provisioned. | Default |

## B — MVP scope

| Q | Question | Resolution | Where it lives |
|---|---|---|---|
| B-1 | Recording limit | **60 seconds.** | `MAX_RECORDING_SEC`, enforced by the recorder and again server-side at publish |
| B-2 | Rhythm mode | **Melody and Rhythm both in MVP**, not feature-flagged. | `CreationMode`, the separate rhythm pipeline in `audio-core` |
| B-3 | Meter | **User-selectable from day one.** 3, 4 and 6 beats per bar. | `TempoPanel`, `Meter` |
| B-4 | Key behaviour | **Detected automatically, with optional user correction.** A key the engine does not believe is shown as unknown and is never used to move pitches. | `RefineOptions.keyOverride`, `KEY_CONFIDENCE_FLOOR` |

## C — Publishing

| Q | Question | Resolution | Where it lives |
|---|---|---|---|
| C-1 | Ownership | **Anonymous publish with a secret management token.** No accounts anywhere in the product. | ADR-004 |
| C-2 | Auth provider | **No preference** → under C-1, none is required. | — |
| C-3 | Retention on delete | **Keep files privately for recovery.** Implemented as: immediate tombstone, objects purged after a retention window. The stated limitation is in ADR-004 and `runbooks/publish-retention.md`. | `PURGE_DELETED_AFTER_DAYS` |
| C-4 | Public reporting | **No public action; internal process only.** | `runbooks/abuse-and-moderation.md` |

## D — Brand and content

| Q | Question | Resolution |
|---|---|---|
| D-1 | Spelling | **Rhythmisoze** / **ریتمیسوز** |
| D-2 | Domain | `Rhythmisoze.behsazangame.info`. Misspelling redirects: **not answered**; the PRD's warning about the spelling stands unaddressed. |
| D-3 | Tone | **Minimal and direct.** Applied in both catalogs: say the thing, offer the next action, stop. |
| D-4 | Instrument direction | **Realistic / acoustic.** **Not met by the shipped default engine** — see ADR-002. |

## E — Design

| Q | Question | Resolution |
|---|---|---|
| E-1 | Visual references | **Not provided.** The three territories in DD-001 were derived from the design package's own brief instead. |
| E-2 | Light or dark | **Light** primary creation environment, with a restrained dark inversion. |
| E-3 | 3D prominence | **No preference — prototype all three.** All three considered; one central audio-reactive object chosen. DD-002. |
| E-4 | Visual/music ranking | **Not answered.** Default applied, in order: transformation raw→clean, pulse, energy, register, instrument character. |

## F — Data and privacy

| Q | Question | Resolution |
|---|---|---|
| F-1 | Analytics stack | **Not answered.** Default applied: a minimal first-party event sender, inert unless `NEXT_PUBLIC_ANALYTICS_ENDPOINT` is set. No third-party script ships. |
| F-2 | Jurisdiction | **Not answered.** No privacy policy or terms text is shipped. **Release blocker if the service goes public.** |
| F-3 | Cross-device sync | Post-MVP. The published schema is extensible without changing public ids. |

## G — Release and operations

| Q | Question | Resolution |
|---|---|---|
| G-1 | Expected traffic | **Not answered.** Cost target assumed from the PRD (<$20/month to 10k visits), met by construction since there is no server compute. |
| G-2 | Deployment ownership | **Not answered.** `runbooks/deployment.md` documents what must be provisioned and by whom. |
| G-3 | Error monitoring | **Not answered.** Default applied: no error tracker ships. **Recommended before public publish release.** |

---

## Open items that block a public release

Collected in one place so they are not spread across four documents:

1. **The architecture quality gate has not been run** (ADR-001). No corpus, no
   device measurements, no blinded listening comparison.
2. **The instrument sounds are synthesised, not recorded** (ADR-002). Q-D4 asked
   for realistic acoustic instruments.
3. **No privacy policy or terms** (Q-F2). The product collects almost nothing,
   which is a good position to write from, but the text does not exist.
4. **No error monitoring** (Q-G3).
5. **Real-device manual verification has not been performed** (US-1203). No
   microphone path has been exercised on real hardware by this implementation.

Everything else in the MVP scope above is implemented.
