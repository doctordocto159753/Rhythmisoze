"""MIDI-RWKV's symbolic representation, as the trained model actually expects it.

## The mistake this file exists to correct

An earlier version of this worker invented a token language::

    <meter>4/4</meter> <left>n60:4 r2 n62:4</left> <mask>3</mask> <right>...</right> <fill>

and fed it to the published checkpoint. That is not a small inaccuracy. The
model has never seen any of those strings; every one of them would tokenise to
whatever the vocabulary happened to map the bytes to, and the output would be
noise that happens to parse. Fake-adapter tests passed throughout, because the
fake adapter accepted the invented language too — which is precisely how an
error like this survives a green suite.

## What the model actually expects

From `christianazinn/MIDI-RWKV` at the pinned revision, `train/src/dataset.py`
and `train/tokenizer/tokenizer_with_acs.json`:

* **Tokenizer:** miditok **MMM**, config `tokenizer_with_acs.json`, 663 tokens,
  `use_programs=True`, `one_token_stream_for_programs=False`,
  `beat_res={'0_1': 12, '1_2': 4, '2_4': 2, '4_8': 1}`, `num_velocities=24`,
  `use_time_signatures=True`.
* **Four infill tokens beyond stock miditok:** `Infill_Bar`, `Infill_Track`,
  `FillBar_Start`, `FillBar_End`. Stock miditok 3.0.5 does not define these —
  they are part of this project's vocabulary, which is why the tokenizer JSON
  must be loaded rather than a fresh MMM constructed.
* **Two vocabularies, not one.** The MMM base vocabulary has **663** tokens; the
  tokenizer then applies **BPE to 16000**. This is not a detail that can be
  skipped: the published checkpoint's `emb.weight` is `(16000, 384)`, so a
  sequence of base ids fed straight to the model indexes the wrong embeddings
  entirely. `_tokenize_score` upstream is explicit about it — it inserts the
  infill markers as *base* ids and then calls `encode_token_ids` to convert the
  whole sequence to BPE.

  So the order is fixed and one-way:

  ```text
  notes → symusic Score → MMM base ids (663) → BPE ids (16000) → model
                                             ← BPE ids ← model output
  ```

  :func:`to_model_ids` and :func:`from_model_ids` are that conversion, kept as
  named functions so the step cannot be forgotten at a call site.
* **Bar-infilling layout**, from `_tokenize_score`:

  ```text
  Track_Start … <bars before> … [Infill_Bar × N] … <bars after> … Track_End
  FillBar_Start <tokens of the N masked bars> FillBar_End
  ```

  The masked bars are *removed* from their position, replaced by exactly N
  `Infill_Bar` tokens, and their content is appended at the end between
  `FillBar_Start` and `FillBar_End`.

At inference the prompt is everything up to and including `FillBar_Start`, and
the model generates until it emits `FillBar_End`.

## Why this module holds no model

Building the token sequence is deterministic and testable; running RWKV is not.
Keeping them apart means the representation can be verified against the real
vocabulary without a GPU, a 70 MB checkpoint, or a compiled inference runtime —
and it is the representation that was wrong.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from musician_shared.contract import Meter, Note

logger = logging.getLogger(__name__)

#: The four tokens MIDI-RWKV adds on top of stock MMM.
INFILL_BAR = "Infill_Bar"
INFILL_TRACK = "Infill_Track"
FILL_BAR_START = "FillBar_Start"
FILL_BAR_END = "FillBar_End"

REQUIRED_INFILL_TOKENS = (INFILL_BAR, INFILL_TRACK, FILL_BAR_START, FILL_BAR_END)


class RepresentationError(RuntimeError):
    """The tokenizer is missing or does not match what the model was trained on."""


@dataclass(frozen=True)
class TokenizerInfo:
    tokenization: str
    miditok_version: str
    #: MMM base vocabulary, before BPE.
    vocab_size: int
    #: What the model actually embeds. Must match the checkpoint's emb rows.
    bpe_vocab_size: int
    path: Path


def load_vocabulary(tokenizer_path: Path) -> tuple[dict[str, int], TokenizerInfo]:
    """Read MIDI-RWKV's tokenizer config and check it is the one we expect.

    The check is not ceremony. A stock MMM tokenizer built from defaults will
    load, tokenize, and produce ids — none of which will mean what the
    checkpoint learned, because it lacks the four infill tokens entirely. So the
    absence of those tokens is treated as a hard error rather than something to
    work around.
    """
    if not tokenizer_path.exists():
        raise RepresentationError(
            f"{tokenizer_path} does not exist. It ships with the MIDI-RWKV "
            f"repository; run scripts/vendor/bootstrap.sh."
        )

    data = json.loads(tokenizer_path.read_text(encoding="utf-8"))
    vocab = data.get("_vocab_base") or {}
    if not vocab:
        raise RepresentationError(f"{tokenizer_path} has no _vocab_base")

    missing = [token for token in REQUIRED_INFILL_TOKENS if token not in vocab]
    if missing:
        raise RepresentationError(
            f"{tokenizer_path} is missing {missing}. That means it is a stock MMM "
            f"tokenizer rather than MIDI-RWKV's, and the model would be prompted "
            f"with a vocabulary it was not trained on."
        )

    # The BPE layer lives in `_model`, serialised as a JSON string.
    bpe_size = 0
    raw_model = data.get("_model")
    try:
        inner = json.loads(raw_model) if isinstance(raw_model, str) else (raw_model or {})
        bpe_size = len(inner.get("model", {}).get("vocab", {}))
    except (TypeError, ValueError):
        bpe_size = 0

    info = TokenizerInfo(
        tokenization=data.get("tokenization", "?"),
        miditok_version=data.get("miditok_version", "?"),
        vocab_size=len(vocab),
        bpe_vocab_size=bpe_size,
        path=tokenizer_path,
    )
    if info.tokenization != "MMM":
        raise RepresentationError(
            f"expected an MMM tokenizer, found {info.tokenization!r}"
        )
    return vocab, info


def notes_to_score(
    notes: tuple[Note, ...],
    *,
    meter: Meter,
    tempo_bpm: float,
    program: int = 0,
):
    """Build a symusic Score from canonical notes.

    symusic is miditok's score representation; going through it rather than
    writing a MIDI file keeps the conversion in memory and lossless at the tick
    level.
    """
    try:
        import symusic  # noqa: PLC0415
    except ImportError as error:  # pragma: no cover - environment dependent
        raise RepresentationError(
            "symusic is required to build MIDI-RWKV input; it installs with miditok"
        ) from error

    ticks_per_quarter = 480
    seconds_per_quarter = 60.0 / tempo_bpm

    def to_ticks(seconds: float) -> int:
        return max(0, round(seconds / seconds_per_quarter * ticks_per_quarter))

    score = symusic.Score(ticks_per_quarter)
    track = symusic.Track(program=program, is_drum=False, name="melody")

    origin = notes[0].start_sec if notes else 0.0
    for note in notes:
        start = to_ticks(note.start_sec - origin)
        duration = max(1, to_ticks(note.end_sec - note.start_sec))
        track.notes.append(
            symusic.Note(time=start, duration=duration, pitch=note.pitch, velocity=note.velocity)
        )

    score.tracks.append(track)
    score.time_signatures.append(
        symusic.TimeSignature(time=0, numerator=meter.numerator, denominator=meter.denominator)
    )
    score.tempos.append(symusic.Tempo(time=0, qpm=tempo_bpm))
    return score


#: Conditioning tokens appended after `FillBar_Start`.
#:
#: These are not optional decoration. They are the signal that tells the model
#: how dense and how polyphonic the bar should be, and the fork's
#: `python/inference.py` always appends them. Without them the model writes
#: `Bar_None TimeSig` and then sits at roughly p=0.28 on "end the fill" against
#: p=0.19 on a real note -- i.e. it produces an empty bar, which reads as a
#: model failure and is actually a missing prompt.
DEFAULT_ATTRIBUTE_CONTROLS = (
    "ACBarOnsetPolyphonyMin_1",
    "ACBarOnsetPolyphonyMax_1",
    "ACBarNoteDensity_4",
    "ACBarNoteDurationWhole_0",
    "ACBarNoteDurationHalf_0",
    "ACBarNoteDurationQuarter_1",
    "ACBarNoteDurationEight_0",
    "ACBarNoteDurationSixteenth_0",
)

#: Tokens the model must never emit mid-fill, from the fork's
#: `StopLogitsProcessor`. 797 is a consecutive `Bar_None`; 663 is labelled
#: "nonsense token???" in their source and is suppressed there too.
STRUCTURAL_BANS = ("Track_Start", "Track_End", "Infill_Track", "PAD_None")
EXTRA_BANNED_IDS = (797, 663, 0)


def build_infill_prompt(
    token_ids: list[int],
    bar_token_id: int,
    *,
    first_bar_index: int,
    bar_count: int,
    vocab: dict[str, int],
    time_signature: str = "TimeSig_4/4",
    attribute_controls: tuple[str, ...] = DEFAULT_ATTRIBUTE_CONTROLS,
) -> list[int]:
    """Assemble the bar-infilling prompt, in MIDI-RWKV's own layout.

    Mirrors `_tokenize_score` for the masking, and the fork's
    `python/inference.py` for the tail: the prompt does **not** stop at
    ``FillBar_Start``. It continues with ``Bar_None``, the time signature and
    the attribute controls for the bar being written, and the model generates
    the note content from there.
    """
    bar_positions = [index for index, token in enumerate(token_ids) if token == bar_token_id]
    if first_bar_index < 0 or first_bar_index >= len(bar_positions):
        raise RepresentationError(
            f"bar {first_bar_index} is outside this melody ({len(bar_positions)} bars)"
        )

    end_bar_index = min(first_bar_index + bar_count, len(bar_positions))
    start_token = bar_positions[first_bar_index]
    end_token = (
        len(token_ids) if end_bar_index >= len(bar_positions) else bar_positions[end_bar_index]
    )

    before = token_ids[:start_token]
    after = token_ids[end_token:]
    masked = [vocab[INFILL_BAR]] * (end_bar_index - first_bar_index)

    tail = [vocab[FILL_BAR_START], vocab["Bar_None"]]
    if time_signature in vocab:
        tail.append(vocab[time_signature])
    tail.extend(vocab[name] for name in attribute_controls if name in vocab)

    return [*before, *masked, *after, *tail]


def banned_token_ids(vocab: dict[str, int]) -> set[int]:
    """Ids the sampler must suppress while a fill is in progress."""
    banned = {vocab[name] for name in STRUCTURAL_BANS if name in vocab}
    return banned | set(EXTRA_BANNED_IDS)


def to_model_ids(tokenizer, base_ids: list[int]) -> list[int]:
    """Base MMM ids -> BPE ids, which is what the model embeds.

    Skipping this is not a performance shortcut; it is an index error that does
    not raise. The base vocabulary is 663 wide and the embedding is 16000, so
    every base id lands on some valid-looking row and the model produces fluent
    nonsense.
    """
    from miditok import TokSequence  # noqa: PLC0415

    sequence = TokSequence(ids=list(base_ids), are_ids_encoded=False)
    tokenizer.encode_token_ids(sequence)
    return list(sequence.ids)


def from_model_ids(tokenizer, model_ids: list[int]) -> list[int]:
    """BPE ids -> base MMM ids, for decoding back to a score."""
    from miditok import TokSequence  # noqa: PLC0415

    # `are_ids_encoded=True` is required, not cosmetic: decode_token_ids
    # checks the flag and silently no-ops otherwise, leaving BPE ids in place
    # where they look like base ids that are merely out of range.
    sequence = TokSequence(ids=list(model_ids), are_ids_encoded=True)
    tokenizer.decode_token_ids(sequence)
    return list(sequence.ids)


def check_vocabulary_matches_model(
    tokenizer_vocab_size: int, model_embedding_rows: int
) -> None:
    """Refuse a tokenizer/checkpoint pair that cannot belong together.

    Cheap, and it catches the exact failure above at load time rather than as
    unexplained output quality.
    """
    if tokenizer_vocab_size != model_embedding_rows:
        raise RepresentationError(
            f"tokenizer produces {tokenizer_vocab_size} ids but the checkpoint embeds "
            f"{model_embedding_rows}. These are not the same vocabulary; the model "
            f"would index unrelated embeddings and return plausible nonsense."
        )


def describe_layout(vocab: dict[str, int]) -> str:
    """Human-readable summary, for the runtime `/info` endpoint and the ADR."""
    return (
        "MMM bar-infilling: [track prefix] + Infill_Bar*N + [track suffix] + "
        f"FillBar_Start(id={vocab[FILL_BAR_START]}) -> model generates until "
        f"FillBar_End(id={vocab[FILL_BAR_END]})"
    )
