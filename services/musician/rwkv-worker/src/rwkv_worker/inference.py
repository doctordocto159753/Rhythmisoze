"""MIDI-RWKV infill, over the real MMM representation.

The token layout lives in :mod:`rwkv_worker.representation`, which explains what
the trained model expects and why the previous invented token language was
wrong. This module is the part that needs a checkpoint: loading it, sampling
from it, and turning the result back into canonical notes.

## Two runtimes, one adapter

* **rwkv.cpp** (upstream `RWKV/rwkv.cpp`) is the production baseline: CPU-first,
  quantisable, no torch. It needs the checkpoint converted to GGML by upstream's
  own `convert_model_to_cpp.sh`.
* **the `rwkv` pip package** loads the published `.pth` directly. Slower and
  heavier, but it needs no build step, which makes it the honest fallback when
  the C++ toolchain is not available.

Both are exercised through the same `_sample` seam so the representation is
identical either way, and `/info` reports which one is live rather than leaving
it to be inferred.

## The span boundary is imposed, not requested

`_fit_to_span` re-times whatever comes back so it occupies exactly the bars it
was asked about. A model is not a contract: a generation that ran long would
push every later note out of place and corrupt the melody it was asked to
repair, and nothing downstream would notice because the result is still valid
notation.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

from musician_shared.contract import Meter, Note

from .representation import (
    FILL_BAR_END,
    RepresentationError,
    build_infill_prompt,
    check_vocabulary_matches_model,
    describe_layout,
    from_model_ids,
    load_vocabulary,
    notes_to_score,
    to_model_ids,
)

logger = logging.getLogger(__name__)

MODEL_DIR = Path(os.environ.get("MUSICIAN_MODELS_DIR", "/models"))
VENDOR_DIR = Path(os.environ.get("MUSICIAN_VENDOR_DIR", "/vendor"))
RWKV_WEIGHT = MODEL_DIR / os.environ.get("MIDI_RWKV_WEIGHT", "midi_rwkv.pth")
RWKV_GGML = MODEL_DIR / os.environ.get("MIDI_RWKV_GGML", "midi_rwkv.bin")


def _tokenizer_path() -> Path:
    """MIDI-RWKV's own tokenizer, not a freshly-built MMM.

    Stock miditok does not define the four infill tokens, so a default MMM would
    prompt the model with a vocabulary it was never trained on.
    """
    override = os.environ.get("MIDI_RWKV_TOKENIZER")
    if override:
        return Path(override)
    return VENDOR_DIR / "midi-rwkv" / "train" / "tokenizer" / "tokenizer_with_acs.json"


class ModelNotLoaded(RuntimeError):
    pass


@dataclass
class RuntimeInfo:
    revision: str
    backend: str
    device: str
    python_version: str
    tokenizer: str
    vocab_size: int
    layout: str


class RwkvRuntime:
    def __init__(self, *, device_preference: str = "auto") -> None:
        self._lock = threading.Lock()
        self._model = None
        self._pipeline = None
        self._vocab: dict[str, int] = {}
        self._tokenizer = None
        self._tokenizer_info = None
        self._device = "cpu"
        self._backend = "not-loaded"
        self._device_preference = device_preference
        self._revision = os.environ.get("MIDI_RWKV_REVISION", "unknown")
        self._load_error: str | None = None

    def resolve_device(self) -> str:
        """CPU baseline; GPU when present and wanted (AC-M08, AC-M09)."""
        if self._device_preference == "cpu":
            return "cpu"
        try:
            import torch  # noqa: PLC0415

            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        if self._device_preference == "cuda":
            logger.warning("MUSICIAN_DEVICE=cuda requested but unavailable; using CPU")
        return "cpu"

    # -- loading -------------------------------------------------------

    def load(self) -> None:
        with self._lock:
            if self._model is not None:
                return
            self._load_vocabulary()
            self._load_tokenizer()
            self._load_model()

    def _load_vocabulary(self) -> None:
        try:
            self._vocab, self._tokenizer_info = load_vocabulary(_tokenizer_path())
        except RepresentationError as error:
            self._load_error = str(error)
            raise ModelNotLoaded(self._load_error) from error

    @property
    def _stop_id(self) -> int:
        """`FillBar_End`, in the vocabulary the model actually emits.

        Comparing against the base id would mean the stop token is never
        recognised and generation always runs to the token budget.
        """
        return to_model_ids(self._tokenizer, [self._vocab[FILL_BAR_END]])[-1]

    def _load_tokenizer(self) -> None:
        """Load MIDI-RWKV's MMM tokenizer from its saved config."""
        try:
            from miditok import MMM  # noqa: PLC0415
        except ImportError as error:
            self._load_error = f"miditok is required for the MMM representation: {error}"
            raise ModelNotLoaded(self._load_error) from error

        try:
            self._tokenizer = MMM(params=str(_tokenizer_path()))
        except Exception as error:
            # A tokenizer that will not load is a hard stop rather than
            # something to substitute around: the alternative is prompting the
            # model with tokens it has never seen.
            self._load_error = f"could not load the MMM tokenizer: {error}"
            raise ModelNotLoaded(self._load_error) from error

    def _load_model(self) -> None:
        self._device = self.resolve_device()

        # rwkv.cpp first: it is the CPU baseline and needs no torch.
        if RWKV_GGML.exists():
            try:
                import rwkv_cpp_model  # noqa: PLC0415
                import rwkv_cpp_shared_library  # noqa: PLC0415

                library = rwkv_cpp_shared_library.load_rwkv_shared_library()
                self._model = rwkv_cpp_model.RWKVModel(library, str(RWKV_GGML))
                self._backend = "rwkv.cpp"
                logger.info("loaded MIDI-RWKV via rwkv.cpp", extra={"weight": str(RWKV_GGML)})
                self._load_error = None
                return
            except ImportError as error:
                logger.info("rwkv.cpp bindings unavailable (%s); trying the pip runtime", error)
            except Exception as error:
                logger.warning("rwkv.cpp failed to load the GGML weight: %s", error)

        if not RWKV_WEIGHT.exists():
            self._load_error = (
                f"neither {RWKV_GGML} nor {RWKV_WEIGHT} exists. Weights are never "
                f"committed; run scripts/models/bootstrap.sh (or .ps1)."
            )
            raise ModelNotLoaded(self._load_error)

        try:
            from rwkv.model import RWKV  # noqa: PLC0415
            from rwkv.utils import PIPELINE  # noqa: PLC0415
        except ImportError as error:
            self._load_error = (
                f"no RWKV runtime available ({error}). Either build rwkv.cpp and convert "
                f"the checkpoint with the upstream script, or install the `rwkv` package."
            )
            raise ModelNotLoaded(self._load_error) from error

        # The checkpoint and the tokenizer must describe the same vocabulary.
        # Checked here because the failure is otherwise invisible: every id
        # lands on some valid-looking embedding row.
        try:
            import torch  # noqa: PLC0415

            rows = int(
                torch.load(RWKV_WEIGHT, map_location="meta", weights_only=True)["emb.weight"].shape[0]
            )
            check_vocabulary_matches_model(self._tokenizer_info.bpe_vocab_size, rows)
        except RepresentationError:
            raise
        except Exception as error:
            logger.warning("could not cross-check the checkpoint vocabulary: %s", error)

        strategy = "cuda fp16" if self._device == "cuda" else "cpu fp32"
        # The `rwkv` package appends `.pth` itself.
        self._model = RWKV(model=str(RWKV_WEIGHT).removesuffix(".pth"), strategy=strategy)
        # No text tokenizer: this model's vocabulary is MMM ids, so sampling is
        # driven directly rather than through PIPELINE's string interface.
        self._pipeline = PIPELINE(self._model, "rwkv_vocab_v20230424")
        self._backend = "rwkv-pip"
        logger.info(
            "loaded MIDI-RWKV via the pip runtime",
            extra={"weight": str(RWKV_WEIGHT), "strategy": strategy},
        )
        self._load_error = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def info(self) -> RuntimeInfo:
        return RuntimeInfo(
            revision=self._revision,
            backend=self._backend,
            device=self._device,
            python_version=sys.version.split()[0],
            tokenizer=str(self._tokenizer_info.path) if self._tokenizer_info else "not-loaded",
            vocab_size=self._tokenizer_info.bpe_vocab_size if self._tokenizer_info else 0,
            layout=describe_layout(self._vocab) if self._vocab else "not-loaded",
        )

    # -- generation ----------------------------------------------------

    def infill(
        self,
        *,
        left_context: tuple[Note, ...],
        right_context: tuple[Note, ...],
        span: tuple[Note, ...],
        meter: Meter,
        tempo_bpm: float,
        temperature: float,
        top_k: int,
        top_p: float,
        seed: int,
        max_new_tokens: int = 512,
    ) -> list[Note]:
        if self._model is None or self._tokenizer is None:
            raise ModelNotLoaded(self._load_error or "model not loaded")
        if not span:
            return []

        # The model reasons over whole bars, so the whole phrase is tokenised
        # and the span is located within it. Tokenising the span alone would
        # discard exactly the surrounding context that makes this infilling
        # rather than continuation.
        whole = (*left_context, *span, *right_context)
        score = notes_to_score(whole, meter=meter, tempo_bpm=tempo_bpm)

        with self._lock:
            sequences = self._tokenizer.encode(score, concatenate_track_sequences=False)
            if not sequences:
                raise ModelNotLoaded("the tokenizer produced no sequence for this melody")
            ids = list(sequences[0].ids)

            bar_id = self._vocab["Bar_None"]
            first_bar, bar_count = self._locate_span_bars(
                left_context=left_context, span=span, meter=meter, tempo_bpm=tempo_bpm
            )

            base_prompt = build_infill_prompt(
                ids, bar_id, first_bar_index=first_bar, bar_count=bar_count, vocab=self._vocab
            )
            # Base ids (663-wide) are not what the model embeds (16000-wide).
            # Skipping this conversion does not raise -- it silently indexes
            # unrelated embeddings and returns fluent nonsense.
            prompt = to_model_ids(self._tokenizer, base_prompt)
            generated = self._sample(
                prompt,
                stop_id=self._stop_id,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                seed=seed,
                max_new_tokens=max_new_tokens,
            )

        notes = self._decode_fill(
            from_model_ids(self._tokenizer, generated), tempo_bpm=tempo_bpm, span=span
        )
        return self._fit_to_span(notes, span)

    def _locate_span_bars(
        self,
        *,
        left_context: tuple[Note, ...],
        span: tuple[Note, ...],
        meter: Meter,
        tempo_bpm: float,
    ) -> tuple[int, int]:
        """Which bar the span starts in, and how many bars it covers."""
        seconds_per_bar = meter.beats_per_bar * 60.0 / tempo_bpm
        origin = (left_context[0].start_sec if left_context else span[0].start_sec)
        first_bar = int((span[0].start_sec - origin) / seconds_per_bar)
        last_bar = int((span[-1].end_sec - origin - 1e-6) / seconds_per_bar)
        return max(0, first_bar), max(1, last_bar - first_bar + 1)

    def _sample(
        self,
        prompt: list[int],
        *,
        stop_id: int,
        temperature: float,
        top_k: int,
        top_p: float,
        seed: int,
        max_new_tokens: int,
    ) -> list[int]:
        """Backend-specific sampling over MMM ids.

        Split out so the two runtimes differ in exactly one place, and so the
        compatibility spike can drive it without an HTTP hop.
        """
        if self._backend == "rwkv-pip":
            return self._sample_pip(
                prompt,
                stop_id=stop_id,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                seed=seed,
                max_new_tokens=max_new_tokens,
            )
        if self._backend == "rwkv.cpp":
            return self._sample_cpp(
                prompt,
                stop_id=stop_id,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                seed=seed,
                max_new_tokens=max_new_tokens,
            )
        raise ModelNotLoaded(f"no sampling path for backend {self._backend!r}")

    def _sample_pip(self, prompt, *, stop_id, temperature, top_k, top_p, seed, max_new_tokens):
        import torch  # noqa: PLC0415

        torch.manual_seed(seed)
        state = None
        logits = None
        for token in prompt:
            logits, state = self._model.forward([token], state)

        out: list[int] = []
        for _ in range(max_new_tokens):
            token = _sample_logits(logits, temperature=temperature, top_k=top_k, top_p=top_p)
            if token == stop_id:
                break
            out.append(token)
            logits, state = self._model.forward([token], state)
        return out

    def _sample_cpp(self, prompt, *, stop_id, temperature, top_k, top_p, seed, max_new_tokens):
        import numpy as np  # noqa: PLC0415

        rng = np.random.default_rng(seed)
        state = None
        logits = None
        for token in prompt:
            logits, state = self._model.eval(token, state, state, logits)

        out: list[int] = []
        for _ in range(max_new_tokens):
            token = _sample_logits(
                logits, temperature=temperature, top_k=top_k, top_p=top_p, rng=rng
            )
            if token == stop_id:
                break
            out.append(token)
            logits, state = self._model.eval(token, state, state, logits)
        return out

    def _decode_fill(self, ids: list[int], *, tempo_bpm: float, span: tuple[Note, ...]) -> list[Note]:
        """Turn generated MMM ids back into notes."""
        if not ids:
            return []
        try:
            from miditok import TokSequence  # noqa: PLC0415

            sequence = TokSequence(ids=list(ids))
            score = self._tokenizer.decode([sequence])
        except Exception as error:
            logger.warning("could not decode the generated fill: %s", error)
            return []

        seconds_per_tick = 60.0 / tempo_bpm / score.ticks_per_quarter
        origin = span[0].start_sec
        notes: list[Note] = []
        for track in score.tracks:
            for note in track.notes:
                start = origin + note.time * seconds_per_tick
                end = start + max(note.duration, 1) * seconds_per_tick
                if 0 <= note.pitch <= 127:
                    notes.append(
                        Note(
                            pitch=note.pitch,
                            start_sec=round(start, 6),
                            end_sec=round(end, 6),
                            velocity=max(1, min(127, note.velocity)),
                        )
                    )
        notes.sort(key=lambda note: note.start_sec)
        return notes

    @staticmethod
    def _fit_to_span(parsed: list[Note], span: tuple[Note, ...]) -> list[Note]:
        """Force the model's output into exactly the span it was given.

        Taking the model's own timing would let a long generation push every
        later note out of place -- the melody would be corrupted rather than
        repaired, and nothing downstream would notice because the result is
        still valid notation.
        """
        count = min(len(parsed), len(span))
        if count == 0:
            return []
        fitted = [
            Note(
                pitch=parsed[index].pitch,
                start_sec=span[index].start_sec,
                end_sec=span[index].end_sec,
                velocity=span[index].velocity,
            )
            for index in range(count)
        ]
        # A short generation keeps the original tail rather than shortening the
        # melody: the span must be filled, not truncated.
        fitted.extend(span[count:])
        return fitted


def _sample_logits(logits, *, temperature: float, top_k: int, top_p: float, rng=None) -> int:
    """Nucleus + top-k sampling over a logit vector.

    Written out rather than imported so both backends share one definition:
    rwkv.cpp and the pip runtime return different array types, and two sampling
    implementations would be two places for a reproducibility bug to hide.
    """
    import numpy as np  # noqa: PLC0415

    array = np.asarray(logits, dtype=np.float64).reshape(-1)
    if temperature <= 0:
        return int(array.argmax())

    array = array / max(temperature, 1e-6)
    array = array - array.max()
    probs = np.exp(array)
    probs /= probs.sum()

    if top_k and top_k > 0:
        cut = np.argsort(probs)[::-1][:top_k]
        mask = np.zeros_like(probs)
        mask[cut] = probs[cut]
        probs = mask / mask.sum()

    if 0 < top_p < 1:
        order = np.argsort(probs)[::-1]
        cumulative = np.cumsum(probs[order])
        keep = order[: max(1, int(np.searchsorted(cumulative, top_p)) + 1)]
        mask = np.zeros_like(probs)
        mask[keep] = probs[keep]
        probs = mask / mask.sum()

    generator = rng if rng is not None else np.random.default_rng()
    return int(generator.choice(len(probs), p=probs))
