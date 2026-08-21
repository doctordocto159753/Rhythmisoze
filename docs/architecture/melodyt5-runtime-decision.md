# MelodyT5: architecture and runtime decision

**Status:** architecture settled and verified; runtime decision **pending the
real-weight spike**.
**Date:** 2026-08-21

---

## The finding that started this

The first implementation of the MelodyT5 worker loaded the checkpoint like this:

```python
AutoTokenizer.from_pretrained(weights)
T5ForConditionalGeneration.from_pretrained(weights)
```

That is wrong, and not marginally. **MelodyT5 is not a HuggingFace T5.** The
name is the only thing the two share.

It survived review because nothing tested it: the fake adapter satisfied the
same interface, so the whole suite was green while the real path could not have
loaded the weights at all.

---

## What MelodyT5 actually is

From `sanderwood/melodyt5` at `9fc0e7dd02ba10a77b46f9d4a669451f17885fbc`:

A **hierarchical bar-patching** model, in two levels.

| Component | What it does |
|---|---|
| `Patchilizer` | splits an ABC body on barline delimiters; encodes each bar as a fixed **64-byte patch** of raw character codepoints, bracketed BOS/EOS. Header lines (`L:`, `M:`, `K:`, `%%…`) each become their own patch. |
| `PatchLevelEnDecoder` | GPT-2 encoder/decoder over patch **embeddings** — `Linear(64 × 128, n_embd)` applied to one-hot bytes. 9 layers, encoder and decoder weights tied. |
| `CharLevelDecoder` | 3-layer GPT-2 that writes the characters **inside** one bar, conditioned on the last encoded patch. |

Configuration (`config.py`): `PATCH_SIZE=64`, `PATCH_LENGTH=256`,
`PATCH_NUM_LAYERS=9`, `CHAR_NUM_LAYERS=3`, `SHARE_WEIGHTS=True`.

Three consequences that make the generic T5 path impossible:

1. **The patch level has `vocab_size=1`.** It never embeds tokens; it embeds
   one-hot *bytes* through a `Linear`. There is no tokenizer to load.
2. **Generation is two-level and iterative.** One model call yields **one bar**,
   which is appended to the decoder patches before the next call. `generate()`
   on a T5 would produce a flat token sequence, which is a different object.
3. **`weights.pth` is a raw `torch.save` checkpoint** with the state dict nested
   under a `"model"` key — not a `from_pretrained` directory.

### The task prompt is load-bearing

Upstream derives the task from the input itself:

```python
task = input_abc.split("\n")[0][2:]
```

So the literal first line `%%variation` *is* the task selector. Its absence
does not fall back to a default — `task` silently becomes whatever the first
header line happens to be.

The prompt format is:

```text
%%input
%%variation
L:1/16
M:4/4
K:D
D4 E4 ^F4 G4 | A4 G4 ^F4 E4 | ...
%%output
<headers seeding the decoder>
```

### Sampling scale

Upstream defaults are `top_p=0.8`, `top_k=8`, **`temperature=2.6`**. That looks
extreme only against normal LM logits — here it is applied to *character*
probabilities inside a bar, after top-p and top-k have already cut the tail. Our
policy temperatures are expressed on this scale.

---

## A second bug this exposed

Our ABC emitter wrote **no barlines**. For a model that patches *by bar*, that
collapses an entire melody into one patch — nothing like the training
distribution, and a silent quality cliff rather than an error.

Fixed: `to_abc` now emits real bars derived from the detected meter.

---

## What has been verified, without weights

Run against the real upstream `Patchilizer` with `transformers 4.40.2`:

| Check | Result |
|---|---|
| our prompt parses to the intended task under upstream's own rule | `'variation'` ✓ |
| a 12-note phrase produces bar patches | **9 patches × 64 bytes** ✓ |
| barlines produce separate patches | 3 bars → 3 patches ✓ |
| `Patchilizer.decode(encode(x)) == x` | lossless ✓ |

This settles the *representation*. It does not settle the runtime.

---

## The runtime question — still open

Upstream documents Python 3.7.9 / PyTorch 1.13.1 / CUDA 11.6, and pins
`transformers==4.18.0`.

Two options:

1. **Modern runtime, same architecture and weights.** Cheaper to operate and to
   patch. Risk: `PatchLevelEnDecoder` calls
   `EncoderDecoderModel.from_encoder_decoder_pretrained(..., tie_encoder_decoder=True)`,
   and weight-tying behaviour is exactly the kind of thing that has changed
   across `transformers` majors. A silent tying difference would load cleanly and
   generate subtly wrong output.
2. **Pin the legacy runtime** in the worker container. Certain to reproduce
   upstream; a container nobody can safely update.

### How it will be decided

`scripts/spike/melodyt5_compat.py`, against the real weights:

1. load the checkpoint and confirm `load_state_dict` reports **no missing and no
   unexpected keys** — the single most informative signal that the architecture
   matches;
2. generate fixed-seed fixtures for: a 4/4 major phrase, a 6/8 phrase, a phrase
   with rests, a minor-key phrase, and a deliberately irregular Teacher melody;
3. check semantic properties — output parses as ABC, note count is plausible,
   pitch distribution is not degenerate, meter and key survive, and the same
   seed reproduces within a runtime.

**Byte-identical output across runtimes is not the bar.** Floating-point
associativity differs between torch builds; demanding equality would fail for a
reason that has nothing to do with correctness.

### Current state

**Not yet run.** The 1,357,746,623-byte weight was still downloading when this
was written. Until the spike runs, the worker image pins **Python 3.10** as the
conservative choice.

That default is **the absence of a decision, not one**, and is labelled here so
nobody later reads it as settled.

---

## Provenance

| | |
|---|---|
| Code | `sanderwood/melodyt5` @ `9fc0e7dd02ba10a77b46f9d4a669451f17885fbc` (MIT) |
| Weights | `sander-wood/melodyt5` @ `5c1594ff1a4c183b5c21635b2df29ebca54392ab` |
| File | `weights.pth`, 1,357,746,623 bytes |
| SHA256 | `930d96ecb6a663ef8e504e0885e940a676cb3d4fe36c6513b96f00db233435cd` |
| Weight licence | MIT (verified on the model card, independently of the code licence) |

Never committed. Fetched and verified by `scripts/models/bootstrap.{sh,ps1}`.
