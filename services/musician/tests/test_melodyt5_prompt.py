"""The MelodyT5 adapter must transport every ABC character it is given."""

from __future__ import annotations

import re
import sys
from pathlib import Path

from conftest import build_notes
from musician_shared.contract import Meter, Phrase

ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = ROOT / "services" / "musician" / "melodyt5-worker" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))

from melodyt5_worker.inference import (  # noqa: E402
    PATCH_PAYLOAD_SIZE,
    build_prompt,
    encode_prompt_losslessly,
)


class FakePatchilizer:
    """The published Patchilizer surface used by the local adapter."""

    delimiters = ["|:", "::", ":|", "[|", "||", "|]", "|"]
    pad_token_id = 0
    bos_token_id = 1
    eos_token_id = 2

    def __init__(self) -> None:
        self.pattern = "(" + "|".join(map(re.escape, self.delimiters)) + ")"

    def split_bars(self, body: str) -> list[str]:
        bars = list(filter(None, re.split(self.pattern, "".join(body))))
        if bars[0] in self.delimiters:
            bars[1] = bars[0] + bars[1]
            bars = bars[1:]
        return [bars[index * 2] + bars[index * 2 + 1] for index in range(len(bars) // 2)]

    def bar2patch(self, bar: str, patch_size: int = 64) -> list[int]:
        patch = [self.bos_token_id, *map(ord, bar), self.eos_token_id]
        patch = patch[:patch_size]
        return patch + [self.pad_token_id] * (patch_size - len(patch))


def decoded_payload(patches: list[list[int]]) -> str:
    special_bos = [1] * 63 + [2]
    special_eos = [1] + [2] * 63
    return "".join(
        "".join(chr(value) for value in patch[1:] if value > 2)
        for patch in patches
        if patch not in (special_bos, special_eos)
    )


def test_overlength_fractional_bars_are_split_without_losing_the_prompt() -> None:
    # Dense off-grid timing produces rational suffixes long enough to overflow
    # upstream's 62-byte bar payload. The old direct `encode` call silently
    # sliced the tail, so MelodyT5 never received several notes in each bar.
    notes = build_notes(list(range(60, 72)) * 4, duration=0.173, gap=0.019)
    prompt, _ = build_prompt(
        notes,
        meter=Meter(numerator=4, denominator=4, confidence=1.0),
        tempo_bpm=116.0,
        key=None,
        phrases=(
            Phrase(start_index=0, end_index=15),
            Phrase(start_index=16, end_index=31),
            Phrase(start_index=32, end_index=47),
        ),
    )
    logical_bars = [bar for bar in prompt.split("|") if bar.strip()]
    assert max(map(len, logical_bars)) > PATCH_PAYLOAD_SIZE

    patches = encode_prompt_losslessly(FakePatchilizer(), prompt, add_special_patches=True)

    assert all(len(patch) == 64 for patch in patches)
    assert decoded_payload(patches) == prompt
    assert prompt.count("(") == prompt.count(")") == 3


def test_a_single_token_larger_than_a_patch_is_rejected_not_sliced() -> None:
    patchilizer = FakePatchilizer()
    oversized = "%%" + "x" * PATCH_PAYLOAD_SIZE + "\n"

    try:
        encode_prompt_losslessly(patchilizer, oversized)
    except ValueError as error:
        assert "token exceeds" in str(error)
    else:  # pragma: no cover - the assertion explains the failure better
        raise AssertionError("an oversized token was silently accepted")
