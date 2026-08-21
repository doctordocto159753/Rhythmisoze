"""The whole Musician pipeline, on the real models.

Closes AC-01 through AC-10: Teacher material in, real MelodyT5 candidates, the
deterministic Identity Guard, real MIDI-RWKV infill on nominated spans, and
three variants out. **No fake adapter participates.**

    python scripts/spike/real_pipeline.py

Expects the two workers to be reachable (defaults match compose):

    MUSICIAN_MELODYT5_URL=http://127.0.0.1:8081
    MUSICIAN_RWKV_URL=http://127.0.0.1:8082

Writes MIDI for Teacher and all three variants to `artifacts/real-pipeline/`
so they can be rendered through the app's own instrument engine and compared by
ear rather than only by numbers.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services/musician/shared/src"))
sys.path.insert(0, str(ROOT / "services/musician/api/src"))

from musician_api.worker_clients import HttpMelodyAdapter, HttpRwkvAdapter  # noqa: E402
from musician_shared.contract import (  # noqa: E402
    Key,
    Meter,
    Mode,
    Motif,
    MusicianInput,
    Note,
    Tempo,
    VariantKind,
)
from musician_shared.pipeline import generate_variant  # noqa: E402
from musician_shared.policies import policy_for  # noqa: E402

OUT = ROOT / "artifacts" / "real-pipeline"
MELODY_URL = os.environ.get("MUSICIAN_MELODYT5_URL", "http://127.0.0.1:8081")
RWKV_URL = os.environ.get("MUSICIAN_RWKV_URL", "http://127.0.0.1:8082")
SEED = int(os.environ.get("SPIKE_SEED", "20260821"))


def teacher_fixture() -> MusicianInput:
    """A Teacher-shaped phrase: in time, in key, and deliberately plain.

    Plain on purpose. A source with obvious defects would let a variant look
    good by fixing them; this one gives the models nothing to repair, so any
    difference between the three variants is the policy talking.
    """
    pitches = [60, 62, 64, 65, 67, 65, 64, 62, 60, 62, 64, 60]
    notes: list[Note] = []
    cursor = 0.0
    for pitch in pitches:
        notes.append(
            Note(pitch=pitch, start_sec=round(cursor, 6), end_sec=round(cursor + 0.45, 6), velocity=90)
        )
        cursor += 0.5
    return MusicianInput(
        source_id="real-pipeline",
        notes=tuple(notes),
        tempo=Tempo(bpm=120.0, confidence=0.85),
        meter=Meter(numerator=4, denominator=4, confidence=0.8),
        key=Key(tonic="C", mode=Mode.MAJOR, confidence=0.8),
        motifs=(Motif(intervals=(2, 2, 1), occurrences=(0,)),),
        duration_sec=round(cursor + 0.5, 6),
    )


def write_midi(name: str, notes, bpm: float) -> Path:
    """A minimal type-0 MIDI file, so the artifacts open anywhere.

    Written here rather than through the app's TypeScript exporter because this
    script is the Python side; the app renders from the same note data.
    """
    OUT.mkdir(parents=True, exist_ok=True)
    ticks = 480

    def varlen(value: int) -> bytes:
        out = bytearray([value & 0x7F])
        value >>= 7
        while value:
            out.insert(0, (value & 0x7F) | 0x80)
            value >>= 7
        return bytes(out)

    events: list[tuple[int, bytes]] = []
    for note in notes:
        on = round(note.start_sec * bpm / 60.0 * ticks)
        off = round(note.end_sec * bpm / 60.0 * ticks)
        events.append((on, bytes([0x90, note.pitch, note.velocity])))
        events.append((off, bytes([0x80, note.pitch, 0])))
    events.sort(key=lambda item: item[0])

    track = bytearray()
    tempo_us = int(60_000_000 / bpm)
    track += b"\x00\xff\x51\x03" + tempo_us.to_bytes(3, "big")
    previous = 0
    for when, payload in events:
        track += varlen(when - previous) + payload
        previous = when
    track += b"\x00\xff\x2f\x00"

    header = b"MThd" + (6).to_bytes(4, "big") + (0).to_bytes(2, "big") + (1).to_bytes(2, "big") + ticks.to_bytes(2, "big")
    chunk = b"MTrk" + len(track).to_bytes(4, "big") + bytes(track)
    path = OUT / f"{name}.mid"
    path.write_bytes(header + chunk)
    return path


def describe(notes) -> dict:
    pitches = [n.pitch for n in notes]
    span = notes[-1].end_sec - notes[0].start_sec if notes else 0.0
    return {
        "notes": len(notes),
        "span_sec": round(span, 2),
        "range": f"{min(pitches)}..{max(pitches)}" if pitches else "-",
        "pitches": pitches[:16],
    }


def main() -> int:
    print("=" * 74)
    print("REAL MUSICIAN PIPELINE  (no fake adapters)")
    print("=" * 74)

    melody = HttpMelodyAdapter(base_url=MELODY_URL, timeout=600)
    rwkv = HttpRwkvAdapter(base_url=RWKV_URL, timeout=600)

    if not melody.health():
        print(f"!! MelodyT5 worker not ready at {MELODY_URL}")
        return 1
    if not rwkv.health():
        print(f"!! MIDI-RWKV worker not ready at {RWKV_URL}")
        return 1
    print(f"MelodyT5   : {MELODY_URL}  revision {melody.revision}")
    print(f"MIDI-RWKV  : {RWKV_URL}  revision {rwkv.revision}")

    source = teacher_fixture()
    print(f"\nTeacher    : {describe(source.notes)}")
    teacher_path = write_midi("teacher", source.notes, source.tempo.bpm)
    print(f"             -> {teacher_path.relative_to(ROOT)}")

    summary: dict[str, dict] = {
        "seed": SEED,
        "melodyT5Revision": melody.revision,
        "midiRwkvRevision": rwkv.revision,
        "teacher": describe(source.notes),
        "variants": {},
    }
    ok = True

    for kind in (VariantKind.REFINED, VariantKind.DEVELOPED, VariantKind.EXPANDED):
        policy = policy_for(kind)
        print("\n" + "-" * 74)
        print(f"{kind.value.upper()}   temp={policy.melody_sampling.temperature} "
              f"candidates={policy.candidate_count} spans<={policy.max_infill_spans} "
              f"floor={policy.identity.aggregate_floor} grow={policy.identity.allow_growth}")
        print("-" * 74)

        started = time.time()
        variant, outcomes = generate_variant(
            source=source, kind=kind, melody=melody, rwkv=rwkv, base_seed=SEED
        )
        elapsed = time.time() - started

        accepted = sum(1 for o in outcomes if o.accepted)
        info = describe(variant.notes)
        ratio = (
            (variant.notes[-1].end_sec - variant.notes[0].start_sec)
            / (source.notes[-1].end_sec - source.notes[0].start_sec)
            if variant.notes
            else 0.0
        )
        changed = variant.notes != source.notes

        print(f"latency      : {elapsed:.1f}s")
        print(f"candidates   : {accepted}/{len(outcomes)} passed the guard")
        print(f"result       : {info}")
        print(f"length ratio : {ratio:.2f}x the Teacher span")
        print(f"infill spans : {len(variant.infill_spans)}"
              + ("".join(f'\n               - bars {s.start_index}..{s.end_index}: {s.reason}'
                         for s in variant.infill_spans)))
        identity = variant.identity
        print(f"identity     : aggregate={identity.aggregate:.3f} motif={identity.motif_survival:.2f} "
              f"contour={identity.contour_similarity:.2f} passed={identity.passed}")
        if identity.failures:
            print(f"               failures: {identity.failures}")

        path = write_midi(f"musician-{kind.value}", variant.notes, source.tempo.bpm)
        print(f"             -> {path.relative_to(ROOT)}")

        # Sanity, per brief section 13.
        checks = [
            ("produced notes", len(variant.notes) > 0),
            ("differs from Teacher", changed),
            ("no impossible pitches", all(0 <= n.pitch <= 127 for n in variant.notes)),
            ("no zero-length notes", all(n.end_sec > n.start_sec for n in variant.notes)),
            ("notes in order", all(
                a.start_sec <= b.start_sec for a, b in zip(variant.notes, variant.notes[1:])
            )),
            ("no runaway length", ratio <= policy.identity.max_duration_ratio + 0.01),
        ]
        for label, passed in checks:
            if not passed:
                print(f"  [FAIL] {label}")
                ok = False
        if all(p for _, p in checks):
            print(f"  [PASS] all {len(checks)} sanity checks")

        summary["variants"][kind.value] = {
            **info,
            "latencySec": round(elapsed, 2),
            "lengthRatio": round(ratio, 3),
            "infillSpans": len(variant.infill_spans),
            "identityAggregate": round(identity.aggregate, 4),
            "motifSurvival": round(identity.motif_survival, 4),
            "candidatesAccepted": accepted,
            "candidatesTotal": len(outcomes),
            "midi": str(path.relative_to(ROOT)),
        }

    # AC-07: the three must differ from each other, not just from Teacher.
    print("\n" + "=" * 74)
    variants = summary["variants"]
    lengths = {k: v["notes"] for k, v in variants.items()}
    print(f"note counts  : {lengths}")
    distinct = len({tuple(v["pitches"]) for v in variants.values()})
    print(f"distinct outputs among the three: {distinct}/3")
    if distinct < 3:
        print("  [FAIL] policies collapsed onto the same output")
        ok = False
    else:
        print("  [PASS] three genuinely different results")

    expanded_ratio = variants["expanded"]["lengthRatio"]
    refined_ratio = variants["refined"]["lengthRatio"]
    print(f"refined ratio {refined_ratio:.2f}x vs expanded ratio {expanded_ratio:.2f}x")

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nsummary -> {(OUT / 'summary.json').relative_to(ROOT)}")

    print("=" * 74)
    print(f"REAL PIPELINE: {'PASS' if ok else 'FAIL'}")
    print("=" * 74)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
