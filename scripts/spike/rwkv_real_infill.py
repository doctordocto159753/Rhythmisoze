"""Real MIDI-RWKV bar infilling, following the project's own inference protocol.

Closes AC-M05: the published checkpoint, its own MMM tokenizer, its own
bar-infill layout, its own sampling constraints, producing notes for a masked
bar from the material either side of it.

    RWKV_V7_ON=1 python scripts/spike/rwkv_real_infill.py <tokenizer.json> <weight-stem>

## Three things that are not guessable, and were each got wrong first

**`RWKV_V7_ON=1`.** The `rwkv` package's default class detects only v4/v5/v6 —
it looks for `time_decay` / `time_maa_x`, finds neither, leaves `version` at 4
and then dies on a missing `n_head`. MIDI-RWKV is RWKV-7 "Goose", and the
package gates that implementation behind the environment variable.

**The prompt does not stop at `FillBar_Start`.** From the fork's
`python/inference.py`, it continues with `Bar_None`, `TimeSig_4/4` and the
**attribute controls** for the bar being written. Those controls are the
conditioning signal that says how dense and how polyphonic the bar should be.
Ending the prompt at `FillBar_Start` leaves the model with no target: it emits
`Bar_None TimeSig_4/4` correctly at p=0.98 and then sits at roughly p=0.28 on
"end the fill" versus p=0.19 on a real note.

**The end token is banned until the bars are written.** The fork's
`StopLogitsProcessor` sets the EOS score to `-999999` while
`n_bar_none <= n_bars_to_infill`, and forces it once that is exceeded. Without
that constraint greedy decoding takes the p=0.28 exit and returns an empty bar —
which is not a model failure, it is a missing decode constraint.

It also bans `Track_Start`, `Track_End`, `Infill_Track`, `PAD_None`, token 797
(consecutive `Bar_None`) and token 663, which their source labels
"nonsense token???".
"""

from __future__ import annotations

import contextlib
import io as _io
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("RWKV_V7_ON", "1")
os.environ.setdefault("RWKV_JIT_ON", "1")
os.environ.setdefault("RWKV_CUDA_ON", "0")

import torch  # noqa: E402
import symusic  # noqa: E402
from miditok import MMM, TokSequence  # noqa: E402

TOKENIZER = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    "vendor/midi-rwkv/train/tokenizer/tokenizer_with_acs.json"
)
WEIGHT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("models/midi_rwkv")
DEVICE = os.environ.get("SPIKE_DEVICE", "cpu")
DTYPE = os.environ.get("SPIKE_DTYPE", "fp32")

TPQ = 480
BPM = 120.0
BAR_TICKS = TPQ * 4

#: Derived from the *surrounding* bars, never from the bar that was removed.
#: Taking them from the masked content would be reading the answer.
ATTRIBUTE_CONTROLS = (
    "ACBarOnsetPolyphonyMin_1",
    "ACBarOnsetPolyphonyMax_1",
    "ACBarNoteDensity_4",
    "ACBarNoteDurationWhole_0",
    "ACBarNoteDurationHalf_0",
    "ACBarNoteDurationQuarter_1",
    "ACBarNoteDurationEight_0",
    "ACBarNoteDurationSixteenth_0",
)


def build_fixture() -> symusic.Score:
    """Four bars. Bar 3 is the one that gets masked."""
    bars = [
        [(60, 0), (62, 1), (64, 2), (65, 3)],   # C D E F
        [(67, 0), (65, 1), (64, 2), (62, 3)],   # G F E D
        [(64, 0), (65, 1), (67, 2), (69, 3)],   # E F G A   <- masked
        [(67, 0), (64, 1), (62, 2), (60, 3)],   # G E D C
    ]
    score = symusic.Score(TPQ)
    track = symusic.Track(program=0, is_drum=False, name="melody")
    for bar_index, bar in enumerate(bars):
        for pitch, beat in bar:
            track.notes.append(
                symusic.Note(
                    time=bar_index * BAR_TICKS + beat * TPQ,
                    duration=TPQ - 20,
                    pitch=pitch,
                    velocity=80,
                )
            )
    score.tracks.append(track)
    score.time_signatures.append(symusic.TimeSignature(time=0, numerator=4, denominator=4))
    score.tempos.append(symusic.Tempo(time=0, qpm=BPM))
    return score


def sample(logits: torch.Tensor, *, temperature: float, top_k: int, top_p: float, generator) -> int:
    probs = torch.softmax(logits.float() / max(temperature, 1e-6), dim=-1)
    if top_k > 0:
        cut = probs.topk(min(top_k, probs.numel()))
        mask = torch.zeros_like(probs)
        mask[cut.indices] = cut.values
        probs = mask / mask.sum()
    if 0 < top_p < 1:
        ordered, order = probs.sort(descending=True)
        keep = int(torch.searchsorted(ordered.cumsum(0), torch.tensor(top_p)).item()) + 1
        mask = torch.zeros_like(probs)
        mask[order[:keep]] = probs[order[:keep]]
        probs = mask / mask.sum()
    return int(torch.multinomial(probs, 1, generator=generator).item())


def main() -> int:
    from rwkv.model import RWKV

    print("=" * 70)
    print("REAL MIDI-RWKV BAR INFILL")
    print("=" * 70)

    tokenizer = MMM(params=str(TOKENIZER))
    vocab = tokenizer.vocab
    print(f"tokenizer    : MMM, {len(vocab)} base tokens -> {len(tokenizer)} after BPE")

    started = time.time()
    with contextlib.redirect_stdout(_io.StringIO()):
        model = RWKV(model=str(WEIGHT), strategy=f"{DEVICE} {DTYPE}")
    cold = time.time() - started
    print(f"model        : RWKV-7, {model.args.n_layer}L x {model.args.n_embd}d, "
          f"{model.n_head}x{model.head_size} heads")
    print(f"cold load    : {cold:.2f}s on {DEVICE}/{DTYPE}")

    def to_base(bpe_ids) -> list[int]:
        if not bpe_ids:
            return []
        seq = TokSequence(ids=list(bpe_ids), are_ids_encoded=True)
        tokenizer.decode_token_ids(seq)
        return list(seq.ids)

    def to_bpe(base_ids) -> list[int]:
        seq = TokSequence(ids=list(base_ids), are_ids_encoded=False)
        tokenizer.encode_token_ids(seq)
        return list(seq.ids)

    score = build_fixture()
    sequence = tokenizer.encode(score, concatenate_track_sequences=False)[0]
    tokenizer.decode_token_ids(sequence)
    base_ids = list(sequence.ids)

    bar_id = vocab["Bar_None"]
    bars = [i for i, t in enumerate(base_ids) if t == bar_id]
    print(f"fixture      : 4 bars, 16 notes -> {len(base_ids)} base tokens, bars at {bars}")
    if len(bars) < 4:
        print("!! tokenizer merged bars")
        return 1

    removed = base_ids[bars[2]:bars[3]]
    removed_pitches = [
        int(tokenizer[t].split("_")[1]) for t in removed if tokenizer[t].startswith("Pitch_")
    ]

    controls = [c for c in ATTRIBUTE_CONTROLS if c in vocab]
    prompt_base = (
        base_ids[:bars[2]]
        + [vocab["Infill_Bar"]]
        + base_ids[bars[3]:]
        + [vocab["FillBar_Start"], vocab["Bar_None"], vocab["TimeSig_4/4"]]
        + [vocab[c] for c in controls]
    )
    prompt = to_bpe(prompt_base)
    print(f"masked bar 3 : removed {len(removed)} tokens (pitches {removed_pitches})")
    print(f"prompt       : {len(prompt_base)} base -> {len(prompt)} model tokens, "
          f"{len(controls)} attribute controls")

    banned = {vocab[n] for n in ("Track_Start", "Track_End", "Infill_Track", "PAD_None") if n in vocab}
    banned |= {797, 663, 0}
    stop_base = vocab["FillBar_End"]
    n_bars_to_infill = 1

    generator = torch.Generator().manual_seed(20260821)
    started = time.time()
    logits, state = model.forward(prompt, None)
    prefill = time.time() - started

    generated: list[int] = []
    stopped_by = "token budget"
    started = time.time()
    for _ in range(320):
        base_so_far = to_base(generated)
        bars_seen = sum(1 for t in base_so_far if t == bar_id)
        if bars_seen > n_bars_to_infill:
            stopped_by = f"bar count reached ({bars_seen} Bar_None)"
            break

        scored = logits.float().clone()
        for bad in banned:
            if bad < scored.numel():
                scored[bad] = -1e9
        # A bar cannot be finished before it is written.
        scored[stop_base] = -1e9

        token = sample(scored, temperature=1.0, top_k=24, top_p=0.9, generator=generator)
        generated.append(token)
        logits, state = model.forward([token], state)
    elapsed = time.time() - started

    print(f"\nprefill      : {prefill:.2f}s")
    print(f"generation   : {elapsed:.2f}s, {len(generated)} model tokens"
          f"{f' ({elapsed/len(generated)*1000:.1f} ms/token)' if generated else ''}")
    print(f"stopped by   : {stopped_by}")

    filled_base = to_base(generated)
    names = [tokenizer[i] for i in filled_base]
    print(f"\nfill         : {len(filled_base)} base tokens")
    print("  " + " ".join(names[:40]) + (" ..." if len(names) > 40 else ""))

    pitches = [int(n.split("_")[1]) for n in names if n.startswith("Pitch_")]
    positions = [n for n in names if n.startswith("Position_")]

    print(f"\nGENERATED    : pitches {pitches}")
    print(f"  positions  : {positions}")
    print(f"  removed    : {removed_pitches}  (the bar that was masked out)")
    print(f"  left ctx   : bar 2 ends G F E D (67 65 64 62)")
    print(f"  right ctx  : bar 4 begins G E D C (67 64 62 60)")

    ok = True
    checks: list[tuple[str, bool, str]] = []
    checks.append(("produced notes", bool(pitches), f"{len(pitches)} pitches"))
    checks.append((
        "all pitches in MIDI range",
        all(0 <= p <= 127 for p in pitches) if pitches else False,
        f"{min(pitches)}..{max(pitches)}" if pitches else "n/a",
    ))
    checks.append((
        "density is plausible for one bar",
        0 < len(pitches) <= 32,
        f"{len(pitches)} notes",
    ))
    if pitches:
        span = max(pitches) - min(pitches)
        checks.append(("range is plausible", span <= 36, f"{span} semitones"))
        # Musical relevance: does the fill sit near the surrounding material
        # rather than in an unrelated register?
        context = [67, 65, 64, 62, 67, 64, 62, 60]
        centre = sum(pitches) / len(pitches)
        context_centre = sum(context) / len(context)
        checks.append((
            "sits in the same register as its context",
            abs(centre - context_centre) <= 12,
            f"fill centre {centre:.1f} vs context {context_centre:.1f}",
        ))

    print()
    for label, passed, detail in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label:42} {detail}")
        ok = ok and passed

    print("\n" + "=" * 70)
    print(f"AC-M05  REAL CONTEXT-CONDITIONED INFILL: {'PASS' if ok else 'FAIL'}")
    print("=" * 70)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
