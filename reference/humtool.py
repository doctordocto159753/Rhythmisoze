#!/usr/bin/env python3
"""
humtool - voice sketch to usable musical material.

Stage 4-6 of the pipeline: clean, quantize, analyse, render.
Input: a raw MIDI file from a hum-to-MIDI transcriber (Basic Pitch, Melodyne, etc.)
Output: cleaned MIDI, rendered WAV, and a text report describing the material.
"""
import sys, json, math, statistics, collections
import numpy as np
import pretty_midi

NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']

# Krumhansl-Schmuckler key profiles
MAJ = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
MIN = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])


def load(path):
    pm = pretty_midi.PrettyMIDI(path)
    notes = []
    for inst in pm.instruments:
        for n in inst.notes:
            notes.append([n.start, n.end, n.pitch, n.velocity])
    notes.sort(key=lambda x: x[0])
    return notes


def strip_octave_errors(notes, tol=12):
    """Pitch trackers commonly report harmonics an octave or two up. Drop them."""
    if not notes:
        return notes, 0
    med = statistics.median(n[2] for n in notes)
    keep = [n for n in notes if abs(n[2] - med) <= tol]
    return keep, len(notes) - len(keep)


def estimate_tempo(notes, lo=50, hi=180):
    """Pick the BPM whose 16th-note grid the onsets fall closest to."""
    ons = []
    for n in notes:
        if not ons or n[0] - ons[-1] > 0.06:
            ons.append(n[0])
    if len(ons) < 4:
        return 80.0, 1.0
    best = (80.0, 1.0)
    for bpm10 in range(lo * 10, hi * 10 + 1, 5):
        bpm = bpm10 / 10
        step = 60.0 / bpm / 4
        err = sum(min(o % step, step - o % step) for o in ons) / len(ons) / step
        if err < best[1]:
            best = (bpm, err)
    return best


def detect_key(notes):
    hist = np.zeros(12)
    for s, e, p, v in notes:
        hist[p % 12] += max(e - s, 0.05)
    if hist.sum() == 0:
        return 'D', 'minor', 0.0
    hist = hist / hist.sum()
    best = None
    for i in range(12):
        for prof, mode in ((MAJ, 'major'), (MIN, 'minor')):
            r = np.corrcoef(hist, np.roll(prof / prof.sum(), i))[0, 1]
            if best is None or r > best[2]:
                best = (NAMES[i], mode, r)
    return best


def quantize(notes, bpm, div=4, min_len=1):
    """Snap onsets and durations to a 1/(4*div) grid. div=4 -> sixteenths."""
    step = 60.0 / bpm / div
    out = []
    for s, e, p, v in notes:
        qs = round(s / step)
        qd = max(min_len, round((e - s) / step))
        if out and out[-1][0] == qs and out[-1][2] == p:
            continue
        out.append([qs, qd, p, v])
    out.sort(key=lambda x: (x[0], x[2]))
    return out, step


def snap_to_scale(qnotes, root, mode):
    scale = [0,2,4,5,7,9,11] if mode == 'major' else [0,2,3,5,7,8,10]
    r = NAMES.index(root)
    moved = 0
    for n in qnotes:
        pc = (n[2] - r) % 12
        if pc not in scale:
            best = min(scale, key=lambda s: min(abs(s - pc), 12 - abs(s - pc)))
            delta = best - pc
            if delta > 6:  delta -= 12
            if delta < -6: delta += 12
            n[2] += delta
            moved += 1
    return qnotes, moved


def to_midi(qnotes, step, program=0, is_drum=False, bpm=80.0):
    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    inst = pretty_midi.Instrument(program=program, is_drum=is_drum)
    for qs, qd, p, v in qnotes:
        inst.notes.append(pretty_midi.Note(
            velocity=int(max(20, min(127, v))),
            pitch=int(max(0, min(127, p))),
            start=qs * step,
            end=(qs + qd) * step))
    pm.instruments.append(inst)
    return pm


def percussion_map(qnotes, split=None):
    """Two-register voice sketch -> GM drum map. Low = kick, high = snare."""
    if not qnotes:
        return qnotes
    if split is None:
        split = statistics.median(n[2] for n in qnotes)
    for n in qnotes:
        n[2] = 36 if n[2] < split else 38   # GM: 36 kick, 38 snare
    return qnotes


def report(raw, kept, dropped, bpm, err, key, qnotes):
    pitches = [n[2] for n in kept]
    ivs = [abs(qnotes[i][2] - qnotes[i-1][2]) for i in range(1, len(qnotes))]
    reps = sum(1 for i in ivs if i == 0)
    steps = sum(1 for i in ivs if i == 1)
    lines = [
        f"notes in        : {len(raw)}",
        f"octave errors   : {dropped} removed",
        f"tempo estimate  : {bpm:.1f} BPM  (grid error {err:.3f}; <0.10 tight, >0.20 loose)",
        f"key estimate    : {key[0]} {key[1]}  (confidence {key[2]:.2f})",
        f"range           : {NAMES[min(pitches)%12]}{min(pitches)//12-1} to {NAMES[max(pitches)%12]}{max(pitches)//12-1}",
    ]
    if ivs:
        lines.append(f"repeated notes  : {100*reps/len(ivs):.0f}% of moves")
        lines.append(f"semitone steps  : {100*steps/len(ivs):.0f}% of moves")
        lines.append(f"stepwise total  : {100*(reps+steps)/len(ivs):.0f}%  (high = creeping, low = leaping)")
    return "\n".join(lines)


def grid_view(qnotes, div=4, bars=8):
    per_bar = 4 * div
    rows = collections.defaultdict(list)
    for qs, qd, p, v in qnotes:
        rows[qs // per_bar].append((qs % per_bar, p, v))
    out = []
    for b in sorted(rows)[:bars]:
        cells = ['.'] * per_bar
        for pos, p, v in rows[b]:
            cells[pos] = 'X' if v >= 70 else 'x' if v >= 45 else 'o'
        names = ' '.join(f"{NAMES[p%12]}{p//12-1}" for _, p, _ in sorted(rows[b]))
        out.append(f"bar {b+1:2d} |{''.join(cells)}|  {names}")
    return "\n".join(out)


def run(path, mode='pitched', program=0, div=4, do_snap=True, out_prefix='out'):
    raw = load(path)
    kept, dropped = strip_octave_errors(raw) if mode == 'pitched' else (raw, 0)
    bpm, err = estimate_tempo(kept)
    key = detect_key(kept)
    qnotes, step = quantize(kept, bpm, div=div)
    moved = 0
    if mode == 'pitched' and do_snap:
        qnotes, moved = snap_to_scale(qnotes, key[0], key[1])
    if mode == 'drums':
        qnotes = percussion_map(qnotes)

    pm = to_midi(qnotes, step, program=program, is_drum=(mode == 'drums'), bpm=bpm)
    pm.write(f"{out_prefix}.mid")

    txt = report(raw, kept, dropped, bpm, err, key, qnotes)
    if moved:
        txt += f"\nscale snapping  : {moved} notes moved to the nearest scale tone"
    return pm, txt, qnotes, bpm, step


if __name__ == '__main__':
    p = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else 'pitched'
    prog = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    pm, txt, q, bpm, step = run(p, mode=mode, program=prog, out_prefix=sys.argv[4] if len(sys.argv) > 4 else 'out')
    print(txt)
    print()
    print(grid_view(q))
