#!/usr/bin/env python3
"""
US-0401 - capture `humtool.py` behaviour as golden fixtures.

Runs the reference Python implementation (vendored at `reference/humtool.py`)
over a set of representative note sequences and writes the exact outputs to
`tests/fixtures/golden/`. The TypeScript port is then tested against these files
rather than against somebody's reading of the algorithm.

Reproducible from a clean checkout:

    python -m pip install numpy pretty_midi
    python scripts/generate-golden-fixtures.py

The fixtures are committed, so the test suite does not need Python.

IMPORTANT - the Python minor version matters.

`estimate_tempo` sums floats, and CPython 3.12 changed `sum()` to use
compensated (Neumaier) summation. Regenerating under 3.11 therefore produces a
last-bit difference in `gridError` - observed as 0.2062499999999999 against the
committed 0.20624999999999993 - and the CI diff check fails.

CI pins python-version 3.12 for exactly this reason. If that pin ever changes,
the fixtures must be regenerated in the same commit, and the change reviewed as
a deliberate one rather than accepted as noise.

Adding a case: append to CASES, regenerate, and commit the diff. A change to any
existing expected value is a change to the retouch algorithm and needs an ADR.
"""
from __future__ import annotations

import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "reference"))

import humtool  # noqa: E402

OUT_DIR = os.path.join(ROOT, "tests", "fixtures", "golden")

# Grid divisions the product exposes, as humtool's `div` argument.
# div = 2 -> eighths (1/8), div = 4 -> sixteenths (1/16), div = 8 -> (1/32).
DIVS = [2, 4, 8]


def note(start, end, pitch, velocity):
    return [round(start, 6), round(end, 6), int(pitch), int(velocity)]


def scale_line(rng, bpm, count, roots, jitter=0.0, base=60):
    """A melody on a 16th grid at `bpm`, optionally nudged off the grid."""
    step = 60.0 / bpm / 4
    notes = []
    t = 0.0
    for i in range(count):
        length = rng.choice([1, 1, 2, 2, 4])
        pitch = base + roots[i % len(roots)]
        offset = rng.uniform(-jitter, jitter)
        notes.append(note(t + offset, t + offset + length * step * 0.92, pitch,
                          rng.choice([48, 64, 72, 88, 104])))
        t += length * step
    return notes


def build_cases():
    rng = random.Random(20260819)
    cases = {}

    # 1. A clean diatonic phrase already on the grid.
    cases["clean-melody"] = {
        "bpm": 96,
        "mode": "pitched",
        "notes": scale_line(rng, 96, 16, [0, 2, 4, 5, 7, 5, 4, 2]),
    }

    # 2. The same phrase with harmonics an octave and two octaves up, which is
    #    the artefact strip_octave_errors exists for.
    rng = random.Random(11)
    base = scale_line(rng, 96, 16, [0, 2, 4, 5, 7, 5, 4, 2])
    polluted = [n[:] for n in base]
    for index in (2, 5, 9, 13):
        polluted[index] = note(base[index][0], base[index][1],
                               base[index][2] + (12 if index % 2 else 24), base[index][3])
    cases["octave-errors"] = {"bpm": 96, "mode": "pitched", "notes": polluted}

    # 3. Chromatic outsiders, so scale snapping has something to move.
    rng = random.Random(7)
    cases["off-key"] = {
        "bpm": 110,
        "mode": "pitched",
        "notes": scale_line(rng, 110, 20, [0, 1, 3, 4, 6, 8, 10, 11]),
    }

    # 4. Human timing: onsets scattered up to a 32nd either side of the grid.
    rng = random.Random(303)
    cases["human-timing"] = {
        "bpm": 84,
        "mode": "pitched",
        "notes": scale_line(rng, 84, 24, [0, 2, 3, 5, 7, 8, 7, 5], jitter=0.045),
    }

    # 5. Onsets sitting exactly halfway between grid steps. This is the case
    #    that separates Python's round-half-to-even from JavaScript's round-half-up,
    #    and it is the whole reason `pyRound` exists in the port.
    bpm = 120
    step = 60.0 / bpm / 4
    half_notes = []
    for i in range(12):
        start = (i + 0.5) * step
        half_notes.append(note(start, start + step * 1.5, 60 + (i % 5) * 2, 80))
    cases["half-step-rounding"] = {"bpm": bpm, "mode": "pitched", "notes": half_notes}

    # 6. Fewer than four onsets: estimate_tempo must take its documented fallback.
    cases["sparse"] = {
        "bpm": 80,
        "mode": "pitched",
        "notes": [note(0.0, 0.4, 62, 90), note(0.9, 1.6, 65, 84), note(2.1, 2.4, 69, 70)],
    }

    # 7. A single note: median, key histogram and report edge cases at once.
    cases["single-note"] = {"bpm": 100, "mode": "pitched", "notes": [note(0.31, 1.02, 57, 66)]}

    # 8. Nothing at all.
    cases["empty"] = {"bpm": 90, "mode": "pitched", "notes": []}

    # 9. Consecutive duplicates at the same onset and pitch, which quantize()
    #    collapses only when they are adjacent in input order.
    dup_step = 60.0 / 100 / 4
    dups = []
    for i in range(8):
        start = i * dup_step
        dups.append(note(start, start + dup_step, 60, 90))
        dups.append(note(start + 0.001, start + dup_step, 60, 70))
        dups.append(note(start + 0.002, start + dup_step, 64, 70))
    cases["duplicate-onsets"] = {"bpm": 100, "mode": "pitched", "notes": dups}

    # 10. Two-register vocal percussion for percussion_map.
    rng = random.Random(99)
    drum_step = 60.0 / 92 / 4
    drums = []
    pattern = [0, 4, 2, 6, 0, 0, 4, 6, 2, 4, 0, 6, 4, 2, 0, 4]
    for i, slot in enumerate(pattern):
        start = (i * 2 + (slot % 2)) * drum_step
        pitch = 45 if i % 3 == 0 else 62 if i % 3 == 1 else 48
        drums.append(note(start, start + drum_step * 0.6, pitch, rng.choice([70, 96, 112])))
    cases["percussion"] = {"bpm": 92, "mode": "drums", "notes": drums}

    return cases


def key_to_json(key):
    root, mode, confidence = key
    value = float(confidence)
    return {
        "root": root,
        "mode": mode,
        # JSON has no NaN; the port is expected to produce a non-finite value
        # here too, and the test asserts that rather than a number.
        "confidence": None if value != value else value,
    }


def run_case(name, case):
    raw = [n[:] for n in case["notes"]]
    raw.sort(key=lambda x: x[0])

    kept, dropped = humtool.strip_octave_errors([n[:] for n in raw])
    bpm, err = humtool.estimate_tempo([n[:] for n in kept])
    key = humtool.detect_key([n[:] for n in kept])

    result = {
        "name": name,
        "bpm": case["bpm"],
        "mode": case["mode"],
        "input": raw,
        "stripOctaveErrors": {"kept": kept, "dropped": dropped},
        "estimateTempo": {"bpm": bpm, "gridError": err},
        "detectKey": key_to_json(key),
        "quantize": {},
        "snapToScale": {},
        "percussionMap": {},
        "report": {},
        "gridView": {},
    }

    for div in DIVS:
        qnotes, step = humtool.quantize([n[:] for n in kept], case["bpm"], div=div)
        result["quantize"][str(div)] = {
            "notes": [list(map(float, n)) for n in qnotes],
            "stepSec": step,
        }

        snapped, moved = humtool.snap_to_scale([n[:] for n in qnotes], key[0], key[1])
        result["snapToScale"][str(div)] = {
            "notes": [list(map(float, n)) for n in snapped],
            "moved": moved,
        }

        percussion = humtool.percussion_map([n[:] for n in qnotes])
        result["percussionMap"][str(div)] = [list(map(float, n)) for n in percussion]

        # The reference raises on an empty note list (min() over an empty
        # sequence). A web app cannot crash on a silent take, so the port
        # returns zeroed metrics instead; `null` here records that the
        # reference has no defined behaviour to match against.
        try:
            text = humtool.report(raw, kept, dropped, bpm, err, key, qnotes)
        except ValueError:
            text = None
        result["report"][str(div)] = text
        result["gridView"][str(div)] = humtool.grid_view(qnotes, div=div)

    return result


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cases = build_cases()
    index = []
    for name, case in sorted(cases.items()):
        data = run_case(name, case)
        path = os.path.join(OUT_DIR, f"{name}.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
        index.append(name)
        print(f"wrote {os.path.relpath(path, ROOT)}  ({len(case['notes'])} notes)")

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "generatedBy": "scripts/generate-golden-fixtures.py",
                "reference": "reference/humtool.py",
                "divisions": DIVS,
                "cases": index,
            },
            handle,
            indent=2,
        )
        handle.write("\n")
    print(f"\n{len(index)} golden cases written to {os.path.relpath(OUT_DIR, ROOT)}")


if __name__ == "__main__":
    main()
