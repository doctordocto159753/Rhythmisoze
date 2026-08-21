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
    vocab_size: int
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

    info = TokenizerInfo(
        tokenization=data.get("tokenization", "?"),
        miditok_version=data.get("miditok_version", "?"),
        vocab_size=len(vocab),
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


def build_infill_prompt(
    token_ids: list[int],
    bar_token_id: int,
    *,
    first_bar_index: int,
    bar_count: int,
    vocab: dict[str, int],
) -> list[int]:
    """Assemble the bar-infilling prompt, in MIDI-RWKV's own layout.

    Returns the ids up to and including ``FillBar_Start``. The caller samples
    from there until ``FillBar_End``.

    Mirrors `_tokenize_score`: the masked bars are lifted out, replaced in place
    by exactly ``bar_count`` ``Infill_Bar`` tokens, and the remainder of the
    track follows. The extracted content is *not* appended here — at inference
    it is what the model has to produce.
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

    return [*before, *masked, *after, vocab[FILL_BAR_START]]


def describe_layout(vocab: dict[str, int]) -> str:
    """Human-readable summary, for the runtime `/info` endpoint and the ADR."""
    return (
        "MMM bar-infilling: [track prefix] + Infill_Bar*N + [track suffix] + "
        f"FillBar_Start(id={vocab[FILL_BAR_START]}) -> model generates until "
        f"FillBar_End(id={vocab[FILL_BAR_END]})"
    )
