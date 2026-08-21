"""AC-02: a real MIDI-RWKV infill, accepted into a real candidate.

The full-pipeline run uses a clean scale, and correctly performs no infill on
it: the weak-span heuristics nominate nothing, because nothing is weak. That is
the right behaviour and it is also not evidence that the infill path works.

So this drives the same production code against material that genuinely needs a
repair -- a phrase with a 20-semitone leap dropped into the middle of stepwise
motion -- and reports whether the span was nominated, what the model returned,
and whether the acceptance rule took it.

    python scripts/spike/real_infill_accepted.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/musician/shared/src"))
sys.path.insert(0, str(ROOT / "services/musician/api/src"))

from musician_api.worker_clients import HttpRwkvAdapter  # noqa: E402
from musician_shared.adapters.base import InfillRequest  # noqa: E402
from musician_shared.contract import Key, Meter, Mode, MusicianInput, Note, Tempo  # noqa: E402
from musician_shared.pipeline import _local_coherence  # noqa: E402
from musician_shared.policies import DEVELOPED  # noqa: E402
from musician_shared.weak_spans import nominate_weak_spans  # noqa: E402

RWKV_URL = os.environ.get("MUSICIAN_RWKV_URL", "http://127.0.0.1:8082")


def defective_phrase() -> MusicianInput:
    """Stepwise motion with one wild leap, which is what the heuristics look for."""
    pitches = [60, 62, 64, 65, 84, 64, 62, 60, 62, 64, 65, 67, 65, 64, 62, 60]
    notes: list[Note] = []
    cursor = 0.0
    for pitch in pitches:
        notes.append(
            Note(pitch=pitch, start_sec=round(cursor, 6), end_sec=round(cursor + 0.45, 6), velocity=90)
        )
        cursor += 0.5
    return MusicianInput(
        source_id="infill-demo",
        notes=tuple(notes),
        tempo=Tempo(bpm=120.0, confidence=0.85),
        meter=Meter(numerator=4, denominator=4, confidence=0.8),
        key=Key(tonic="C", mode=Mode.MAJOR, confidence=0.8),
        duration_sec=round(cursor + 0.5, 6),
    )


def main() -> int:
    print("=" * 74)
    print("REAL MIDI-RWKV INFILL, ACCEPTED  (AC-02)")
    print("=" * 74)

    rwkv = HttpRwkvAdapter(base_url=RWKV_URL, timeout=600)
    if not rwkv.health():
        print(f"!! worker not ready at {RWKV_URL}")
        return 1
    print(f"worker      : {RWKV_URL}  revision {rwkv.revision}")

    source = defective_phrase()
    print(f"source      : {[n.pitch for n in source.notes]}")
    print(f"              the 84 is a 20-semitone leap in an otherwise stepwise line")

    spans = nominate_weak_spans(source.notes, limit=DEVELOPED.max_infill_spans)
    print(f"\nnominated   : {len(spans)} span(s)")
    for span in spans:
        print(f"  notes {span.start_index}..{span.end_index}  score={span.score:.2f}  {span.reason}")
    if not spans:
        print("!! nothing nominated; the heuristics did not see the defect")
        return 1

    span = spans[0]
    before = source.notes[span.start_index : span.end_index]
    baseline = _local_coherence(before)
    print(f"\ntarget span : {[n.pitch for n in before]}")
    print(f"coherence   : {baseline:.4f} before")

    accepted = False
    for attempt in range(DEVELOPED.infill_candidates):
        seed = 20260821 + attempt
        started = time.time()
        response = rwkv.infill(
            InfillRequest(
                left_context=source.notes[max(0, span.start_index - 6) : span.start_index],
                right_context=source.notes[span.end_index : span.end_index + 6],
                span=before,
                meter=source.meter,
                tempo_bpm=source.tempo.bpm,
                sampling=DEVELOPED.infill_sampling,
                seed=seed,
            )
        )
        elapsed = time.time() - started
        if not response.notes:
            print(f"\nattempt {attempt}: model returned nothing ({elapsed:.1f}s)")
            continue

        after = _local_coherence(response.notes)
        gain = after - baseline
        print(f"\nattempt {attempt} (seed {seed}, {elapsed:.1f}s)")
        print(f"  returned  : {[n.pitch for n in response.notes]}")
        print(f"  coherence : {after:.4f}  (gain {gain:+.4f}, "
              f"threshold {DEVELOPED.min_local_improvement:+.4f})")

        # AC-06 from the previous phase, re-checked on the real model: the fill
        # must occupy exactly the span it was given, or later notes get pushed
        # out of place and the melody is corrupted rather than repaired.
        contained = (
            len(response.notes) == len(before)
            and abs(response.notes[0].start_sec - before[0].start_sec) < 1e-6
            and abs(response.notes[-1].end_sec - before[-1].end_sec) < 1e-6
        )
        print(f"  contained : {contained}")

        if gain >= DEVELOPED.min_local_improvement and contained:
            accepted = True
            print(f"  ACCEPTED  : local structure improved and the span held")
            repaired = (
                source.notes[: span.start_index]
                + tuple(response.notes)
                + source.notes[span.end_index :]
            )
            print(f"\n  before    : {[n.pitch for n in source.notes]}")
            print(f"  after     : {[n.pitch for n in repaired]}")
            outside_changed = [
                index
                for index, (a, b) in enumerate(zip(source.notes, repaired))
                if a.pitch != b.pitch and not (span.start_index <= index < span.end_index)
            ]
            print(f"  changed outside the span: {outside_changed} (must be empty)")
            if outside_changed:
                accepted = False
            break

    print("\n" + "=" * 74)
    print(f"AC-02  REAL INFILL ACCEPTED: {'PASS' if accepted else 'FAIL'}")
    print("=" * 74)
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
