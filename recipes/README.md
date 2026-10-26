# Pico model recipes

`catalog.json` maps hardware + persona to a local model, its quant, llama-server flags, context, and
expected speed. The engine (`engine/pico/recipes.py`) reads it and picks for the user's machine. It
only *offers* updates; it never applies them on its own.

- **Regenerate:** `python recipes/build_catalog.py`. This pulls real file sizes and sha256 from the
  Hugging Face API (`/api/models/<repo>?blobs=true`) and recomputes `min_mem_gb`/`est_tps` with the
  engine's fit math. Use `--check` to print the table without writing.
- **Newer catalogs:** `recipes.fetch_catalog(url)` writes `~/.pico/catalog.json`. `load_catalog()`
  uses it only when it parses and its `version` is higher than the bundled one. The network is optional.
- **Version:** `YYYY.MM.DD` (compared numerically).

## Schema (v1)

```jsonc
{
  "schema": 1,
  "version": "2026.10.25",
  "generated": "ISO-8601",
  "notes": "...",
  "reference_hardware": { "<ref-id>": {"gpus": [...], "ram_gb": 64, "usable_gb": 23.4, "bandwidth_gbps": 1008} },
  "recipes": [Recipe],
  "companions": [Companion]
}
```

### Recipe
| field | meaning |
|---|---|
| `id`, `name`, `family` | Stable id (used by `/api/setup`, `/api/updates`). `family` dedupes alternatives. |
| `kind` | `"llm"` |
| `model.repo`, `model.file` | HF repo + first GGUF file. Split files: the runtime expands `-0000N-of-0000M`. |
| `model.parts[]` | `{file, size, sha256}` for every part (bytes are from HF). `model.sha256` is set when there is one part. |
| `model.mmproj` | Optional vision projector `{repo, file, size_gb, sha256}`. |
| `params_b`, `active_b`, `moe` | Total and active parameters (billions). |
| `active_gb` | Optional override for bytes read per token, used when params include sparse lookup tables (Qwen3.8-Flash n-gram embeddings, GLM). |
| `quant`, `file_gb` | Quant label. `file_gb` is the sum of real file bytes / 1e9 (includes Engram files for DeepSeek). |
| `ctx`, `ctx_min`, `ctx_max` | Target context, the lowest acceptable, and the model's native maximum. The engine reduces `ctx` toward `ctx_min` to make a recipe fit. |
| `kv_kib_per_token`, `kv_fixed_gb` | f16 KV bytes per token, computed from config.json (full-attention layers × kv_heads × head_dim × 4 B), plus fixed SWA/recurrent state. |
| `n_layers`, `dense_frac`, `active_dense_frac` | MoE offload math: how many layers `--n-cpu-moe` can move, the share of the file that is not routed experts, and the share of per-token bytes that stays on the GPU. |
| `runtime`, `flags` | `"llama.cpp"` and the llama-server flags. The runtime adds `-m`, `--host`, `--port`, `-c`, `--jinja` itself. `recommend()` appends `--n-cpu-moe N` when experts are offloaded, and `-ngl 0` on CPU-only machines. |
| `spec` | Optional speculative decoding: `{type: draft-mtp/draft-dflash, draft:{repo,file}, draft_gb, gain, flags}`. `builtin: true` means the MTP head is inside the main GGUF. `gain` counts toward speed only once the runtime sets `spec.enabled`. |
| `min_mem_gb` | weights + draft + KV(`ctx_min`) + overhead (0.8 GB + 2 %). |
| `est_tps` | `{ref-id: {tps, source, mode, ctx}}` for each reference machine where the recipe fits. `mode` is `gpu`, `unified`, `offload`, or `cpu`. |
| `tps_source` | `measured` if any reference uses a cited measurement, otherwise `est`. |
| `speeds[]` | Cited measurements `{hw, match, tps, url, quant, file_gb, note, spec}`. `match` is a lowercase substring of the GPU/CPU name. An exact quant match is reported as `measured`. Another quant is scaled by file size and labeled `est`. |
| `strengths` | Subset of `coding, speed, writing, creative, reasoning, vision`. |
| `scores` | `{coding, writing, reasoning}` on 0-100. Curated relative ranks: coding is anchored on SWE-bench / Terminal-Bench from model cards; writing and reasoning use GPQA plus the family's reputation. These are **not** benchmark numbers. |
| `benchmarks`, `bench_source`, `card_url` | Vendor self-reported numbers and where they came from. |
| `license`, `why` | License and a one-line pitch. |
| `status`, `status_note` | `available`, or `needs_runtime` (listed in the catalog but never recommended; DeepSeek V4.1 waits on llama.cpp support). |

### Companion
`{id, kind: stt|tts|image|video, name, runtime, model:{repo,file,size_gb,sha256, text_encoder?, vae?},
size_gb, license, rank, requires:{min_mem_gb, gpu_only?, accelerators?}, speed?, why}`.
For each kind, the companion with the highest `rank` whose `requires` fits the machine wins. Image
generation is enabled by default for creative/marketing personas. Video is offered only on CUDA/ROCm
GPUs with ≥12 GB.

## Fit and speed model (engine/pico/recipes.py)

- **Usable memory** (`hwscan.usable_vram_gb`):
  - Apple Silicon: 0.70 × RAM (≤36 GB) or 0.75 × RAM (above that).
  - GB10/unified Linux: RAM − 8 GB.
  - Discrete GPUs: VRAM − max(0.6 GB, VRAM already in use).
- **Fits** when weights + draft + KV(ctx) + overhead ≤ usable.
  - Dense models are never partially offloaded (decode collapses).
  - MoE models may move routed experts to system RAM (`--n-cpu-moe`), within 0.85 × RAM − 6 GB.
- **Decode tok/s** ≈ 1 / (active_bytes / (eff × bandwidth) + 2.5 ms).
  - eff = 0.78 (discrete GPU), 0.70 (unified), 0.55 (CPU); offloaded experts are read at 0.6 × system-RAM bandwidth.
  - Calibrated against cited llama.cpp results: Qwen3.8-27B Q4_K_M at 40.4 tok/s on a 3090, Qwen3.5-9B
    at 15.6 on an M3 Pro, gpt-oss-20b at 222 on a 4090. These estimates assume no speculative decoding.
- **Persona weights** are in `WEIGHTS`. Picks below 6 tok/s are heavily penalized, and picks below the
  persona's speed floor are penalized partially. Engineers need ≥32K context.

## Sources (fetched 2026-10-25)
- Model lineup and sizes come from the HF API (unsloth, ggml-org, lmstudio-community, ISTA-DASLab,
  nvidia, google, Qwen, zai-org, deepseek-ai, RecursiveSI, ornith-ai). Benchmarks come from each model card.
- Measured speeds come from RigBase's Oct-2026 roundup (dev.to/rigbase …, which links llama.cpp #15396,
  llamabench.ai, OpenJet, and Geerling's ai-benchmarks), llamabench.ai/r/1063, and
  github.com/robertkarl/local-qwen-first-10-minutes.
