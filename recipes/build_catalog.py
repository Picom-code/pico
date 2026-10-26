#!/usr/bin/env python3
"""Regenerate recipes/catalog.json from live Hugging Face metadata (stdlib only).

    python recipes/build_catalog.py            # writes recipes/catalog.json
    python recipes/build_catalog.py --check    # print table, don't write

Model choices, benchmarks and measured speeds are curated below (with sources). File sizes and
sha256 are pulled from https://huggingface.co/api/models/<repo>?blobs=true at build time, so they
are real byte counts. est_tps per reference machine and min_mem_gb come from the engine's own
fit/speed math (engine/pico/recipes.py) so the catalog and the recommender never disagree.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
from pico import recipes as R  # noqa: E402

VERSION = "2026.10.25"
UA = {"User-Agent": "Mozilla/5.0 (pico catalog builder) Chrome/126.0"}
GPU_FLAGS = ["-ngl", "999", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"]

# ---------------------------------------------------------------- measured speed sources
SRC_RIGBASE = "https://dev.to/rigbase/what-gpu-do-you-need-for-qwen38-qwen36-gemma-4-and-gpt-oss-locally-measured-oct-2026-1eg6"
SRC_15396 = "https://github.com/ggml-org/llama.cpp/discussions/15396"
SRC_GEERLING = "https://github.com/geerlingguy/ai-benchmarks"
SRC_M3PRO_9B = "https://github.com/robertkarl/local-qwen-first-10-minutes"
SRC_LB_4090_27B = "https://llamabench.ai/r/1063"


def M(hw, match, tps, url, quant=None, file_gb=None, note="", spec=False):
    return {"hw": hw, "match": match, "tps": tps, "source": "measured", "url": url, "quant": quant,
            "file_gb": file_gb, "note": note, "spec": spec}


GPTOSS20_SPEEDS = [
    M("RTX 5090", "5090", 282.5, SRC_15396, "MXFP4", note="llama-bench tg128"),
    M("RTX 4090", "4090", 221.9, SRC_15396, "MXFP4", note="llama-bench tg128"),
    M("RTX 5080", "5080", 204.9, SRC_15396, "MXFP4", note="llama-bench tg128"),
    M("RTX 5070 Ti", "5070 ti", 189.5, SRC_15396, "MXFP4", note="llama-bench tg128"),
    M("RTX 3090", "3090", 161.8, SRC_15396, "MXFP4", note="llama-bench tg128"),
    M("RTX 4070 Ti", "4070 ti", 163.1, SRC_GEERLING, "MXFP4", note="Geerling ai-benchmarks #45"),
    M("RTX 5060 Ti 16GB", "5060 ti", 111.5, SRC_15396, "MXFP4", note="llama-bench tg128"),
    M("RTX 3060 12GB", "3060", 84.0, SRC_GEERLING, "MXFP4", note="Geerling ai-benchmarks #40"),
    M("Apple M2 Ultra", "m2 ultra", 116.1, "https://github.com/ggml-org/llama.cpp/discussions/4167", "MXFP4"),
    M("Apple M3 Ultra", "m3 ultra", 115.5, SRC_15396, "MXFP4"),
    M("Apple M4 Max", "m4 max", 92.4, SRC_15396, "MXFP4"),
    M("Apple M1 Max", "m1 max", 75.2, SRC_15396, "MXFP4"),
    M("DGX Spark (GB10)", "gb10", 88.0, SRC_GEERLING, "MXFP4", note="Geerling ai-benchmarks #34"),
]

# ---------------------------------------------------------------- curated model list
# Sizes are filled in from HF. Fields used by the fit math:
#   kv_kib_per_token (f16 KV per token, from config.json: full-attn layers x kv_heads x head_dim x 4 B),
#   kv_fixed_gb (sliding-window / recurrent state), n_layers, dense_frac (non-expert share of file),
#   active_dense_frac (non-expert share of bytes read per token), active_gb override when the
#   param count includes big lookup tables (n-gram / Engram embeddings) that aren't read densely.
LLMS = [
    # ---- tiny / CPU / 8 GB
    dict(id="qwen3.5-4b-q4", name="Qwen3.5 4B", family="qwen3.5", repo="unsloth/Qwen3.5-4B-GGUF",
         file="Qwen3.5-4B-Q4_K_M.gguf", mmproj="mmproj-F16.gguf", quant="Q4_K_M", params_b=4.7, active_b=4.7,
         ctx=32768, ctx_max=262144, kv_kib_per_token=32, kv_fixed_gb=0.05, license="apache-2.0",
         strengths=["speed", "vision"], scores=dict(coding=38, writing=52, reasoning=58),
         card="https://huggingface.co/Qwen/Qwen3.5-4B",
         why="Small, current Qwen that runs on almost anything, including CPU-only laptops."),
    dict(id="gemma-4-e4b-q4", name="Gemma 4 E4B", family="gemma-4-small", repo="unsloth/gemma-4-E4B-it-GGUF",
         file="gemma-4-E4B-it-UD-Q4_K_XL.gguf", quant="UD-Q4_K_XL", params_b=8.0, active_b=4.0,
         ctx=32768, ctx_max=131072, kv_kib_per_token=16, kv_fixed_gb=0.15, license="apache-2.0",
         strengths=["speed", "writing"], scores=dict(coding=25, writing=64, reasoning=55),
         card="https://huggingface.co/google/gemma-4-E4B-it",
         why="Google's on-device Gemma 4: friendly writer, tiny footprint, fine on CPU."),
    dict(id="qwen3.5-9b-q4", name="Qwen3.5 9B", family="qwen3.5", repo="unsloth/Qwen3.5-9B-GGUF",
         file="Qwen3.5-9B-Q4_K_M.gguf", mmproj="mmproj-F16.gguf", quant="Q4_K_M", params_b=9.7, active_b=9.7,
         ctx=32768, ctx_max=262144, kv_kib_per_token=32, kv_fixed_gb=0.2, license="apache-2.0",
         strengths=["coding", "vision"], scores=dict(coding=50, writing=62, reasoning=68),
         speeds=[M("Apple M3 Pro 18GB", "m3 pro", 15.6, SRC_M3PRO_9B, "Q5_K_M", 6.58,
                   note="llama-server b8190, full offload")],
         card="https://huggingface.co/Qwen/Qwen3.5-9B",
         why="Best general model for 8 GB cards and 16 GB Macs; vision included."),
    # ---- 12 GB class
    dict(id="gemma-4-12b-qat", name="Gemma 4 12B (QAT)", family="gemma-4", repo="google/gemma-4-12B-it-qat-q4_0-gguf",
         file="gemma-4-12b-it-qat-q4_0.gguf", mmproj="mmproj-gemma-4-12b-it-qat-q4_0.gguf", quant="QAT Q4_0",
         params_b=12.0, active_b=12.0, ctx=32768, ctx_max=262144, kv_kib_per_token=64, kv_fixed_gb=0.35,
         license="apache-2.0", strengths=["writing", "vision", "speed"], scores=dict(coding=40, writing=78, reasoning=70),
         speeds=[M("RTX 4090", "4090", 98.1, SRC_RIGBASE, None, note="tg128"),
                 M("RTX 5090", "5090", 142.0, SRC_RIGBASE, None, note="tg128"),
                 M("RTX 5070 Ti", "5070 ti", 87.6, SRC_RIGBASE, None, note="tg128"),
                 M("RTX 3060 12GB", "3060", 38.5, SRC_RIGBASE, None, note="tg128")],
         card="https://huggingface.co/google/gemma-4-12B-it",
         why="Google's quantization-aware 4-bit Gemma 4: natural writer, vision, fits 12 GB with room."),
    dict(id="qwen3.8-27b-gsq-iq3xxs", name="Qwen3.8 27B (3-bit GSQ)", family="qwen3.8",
         repo="ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF", file="Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf",
         mmproj="mmproj-Qwen3.8-27B-BF16.gguf", quant="GSQ-RCO IQ3_XXS (+MTP head)", params_b=27.8, active_b=27.8,
         ctx=32768, ctx_min=8192, ctx_max=262144, kv_kib_per_token=64, kv_fixed_gb=0.3, license="apache-2.0",
         strengths=["coding", "vision"], scores=dict(coding=85, writing=75, reasoning=87),
         benchmarks={"Terminal-Bench 2.1": 73.0, "SWE-bench Pro": 61.7, "GPQA Diamond": 89.2},
         spec={"type": "draft-mtp", "builtin": True, "gain": 1.6,
               "flags": ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]},
         card="https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
         why="The strongest dense coder, squeezed to ~10 GB with near-lossless 3-bit research quant."),
    # ---- 16 GB class
    dict(id="qwen3.8-27b-gsq-iq3s", name="Qwen3.8 27B (3.5-bit GSQ)", family="qwen3.8",
         repo="ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF", file="Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf",
         mmproj="mmproj-Qwen3.8-27B-BF16.gguf", quant="GSQ-RCO IQ3_S (+MTP head)", params_b=27.8, active_b=27.8,
         ctx=65536, ctx_min=8192, ctx_max=262144, kv_kib_per_token=64, kv_fixed_gb=0.3, license="apache-2.0",
         strengths=["coding", "vision"], scores=dict(coding=87, writing=77, reasoning=88),
         benchmarks={"Terminal-Bench 2.1": 73.0, "SWE-bench Pro": 61.7, "GPQA Diamond": 89.2},
         spec={"type": "draft-mtp", "builtin": True, "gain": 1.6,
               "flags": ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]},
         card="https://huggingface.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
         why="Qwen3.8 27B at 3.5 bits: card reports 99.8% of BF16 task average in 11.8 GB."),
    dict(id="gpt-oss-20b", name="gpt-oss 20B", family="gpt-oss", repo="ggml-org/gpt-oss-20b-GGUF",
         file="gpt-oss-20b-MXFP4.gguf", quant="MXFP4 (native)", params_b=21.0, active_b=3.6, moe=True,
         ctx=65536, ctx_max=131072, kv_kib_per_token=24, kv_fixed_gb=0.05, n_layers=24, dense_frac=0.09,
         active_dense_frac=0.34, license="apache-2.0", strengths=["speed", "reasoning"],
         scores=dict(coding=48, writing=60, reasoning=72), speeds=GPTOSS20_SPEEDS,
         card="https://huggingface.co/openai/gpt-oss-20b",
         why="OpenAI's open MoE: very fast, solid reasoning, full 128K context on 16 GB."),
    dict(id="gemma-4-26b-a4b-iq4xs", name="Gemma 4 26B-A4B", family="gemma-4-moe", repo="unsloth/gemma-4-26B-A4B-it-GGUF",
         file="gemma-4-26B-A4B-it-UD-IQ4_XS.gguf", mmproj="mmproj-F16.gguf", quant="UD-IQ4_XS",
         params_b=25.8, active_b=3.8, moe=True, ctx=32768, ctx_max=262144, kv_kib_per_token=40, kv_fixed_gb=0.25,
         n_layers=30, dense_frac=0.12, active_dense_frac=0.62, license="apache-2.0",
         strengths=["writing", "speed", "vision"], scores=dict(coding=50, writing=84, reasoning=80),
         benchmarks={"LiveCodeBench v6": 77.1, "GPQA Diamond": 82.3},
         speeds=[M("RTX 4090", "4090", 164.0, SRC_RIGBASE, None, note="tg128"),
                 M("RTX 5090", "5090", 235.0, SRC_RIGBASE, None, note="tg128")],
         card="https://huggingface.co/google/gemma-4-26B-A4B-it",
         why="Gemma 4's fast MoE: strong writing at small-model speed, vision included."),
    dict(id="flint-40b-iq3xxs", name="Flint 40B-A2.5B (3-bit)", family="flint", repo="unsloth/flint-GGUF",
         file="flint-UD-IQ3_XXS.gguf", quant="UD-IQ3_XXS", params_b=39.8, active_b=2.5, moe=True,
         ctx=65536, ctx_max=262144, kv_kib_per_token=28, kv_fixed_gb=0.1, n_layers=49, dense_frac=0.05,
         active_dense_frac=0.63, license="apache-2.0", strengths=["coding", "speed"],
         scores=dict(coding=78, writing=48, reasoning=68),
         benchmarks={"Terminal-Bench 2.1": 54.9, "SWE-bench Verified": 74.2},
         card="https://huggingface.co/RecursiveSI/flint",
         why="Recursive's coding-agent MoE (Oct 2026): tiny active size, very fast, built for repos."),
    # ---- 24 GB class
    dict(id="qwen3.8-27b-q4", name="Qwen3.8 27B", family="qwen3.8", repo="unsloth/Qwen3.8-27B-GGUF",
         file="Qwen3.8-27B-UD-Q4_K_XL.gguf", mmproj="mmproj-F16.gguf", quant="UD-Q4_K_XL", params_b=27.8,
         active_b=27.8, ctx=131072, ctx_min=16384, ctx_max=262144, kv_kib_per_token=64, kv_fixed_gb=0.3,
         license="apache-2.0", strengths=["coding", "vision", "reasoning"],
         scores=dict(coding=88, writing=78, reasoning=89),
         benchmarks={"Terminal-Bench 2.1": 73.0, "SWE-bench Pro": 61.7, "GPQA Diamond": 89.2, "LiveCodeBench v6": 90.3},
         spec={"type": "draft-mtp", "draft": {"repo": "unsloth/Qwen3.8-27B-GGUF", "file": "MTP/mtp-Qwen3.8-27B-Q4_0.gguf"},
               "draft_gb": 1.37, "gain": 1.8,
               "flags": ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]},
         speeds=[M("RTX 3090", "3090", 40.4, SRC_RIGBASE, "Q4_K_M", 16.46, note="OpenJet, llama.cpp, no spec"),
                 M("RTX 5090", "5090", 75.2, SRC_RIGBASE, "Q4_K_M", 16.46, note="llm-speed, no spec"),
                 M("RTX 4090", "4090", 125.0, SRC_LB_4090_27B, "UD-Q4_K_XL", note="b10538, MTP+ngram, 128K q8 KV", spec=True)],
         card="https://huggingface.co/Qwen/Qwen3.8-27B",
         why="Best coding model for a 24 GB card: Terminal-Bench 2.1 73.0 (self-reported), 128K context."),
    dict(id="qwen3.6-35b-a3b-q4", name="Qwen3.6 35B-A3B", family="qwen3.6", repo="unsloth/Qwen3.6-35B-A3B-GGUF",
         file="Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", mmproj="mmproj-F16.gguf", quant="UD-Q4_K_M", params_b=35.0,
         active_b=3.0, moe=True, ctx=65536, ctx_max=262144, kv_kib_per_token=20, kv_fixed_gb=0.2, n_layers=40,
         dense_frac=0.08, active_dense_frac=0.6, license="apache-2.0", strengths=["speed", "coding", "vision"],
         scores=dict(coding=78, writing=72, reasoning=84),
         benchmarks={"SWE-bench Verified": 73.4, "Terminal-Bench 2.0": 51.5, "GPQA Diamond": 86.0},
         speeds=[M("RTX 4090", "4090", 160.6, SRC_RIGBASE, "Q4_K_M", 22.13, note="llm-speed"),
                 M("RTX 3090", "3090", 146.0, SRC_RIGBASE, None, note="tg128, 146-153"),
                 M("RTX 5090", "5090", 258.0, SRC_RIGBASE, None, note="tg128")],
         card="https://huggingface.co/Qwen/Qwen3.6-35B-A3B",
         why="Fast all-rounder MoE: SWE-bench Verified 73.4 (self-reported) at 3B-active speed; offloads well."),
    dict(id="gemma-4-31b-q4", name="Gemma 4 31B", family="gemma-4", repo="unsloth/gemma-4-31B-it-GGUF",
         file="gemma-4-31B-it-UD-Q4_K_XL.gguf", mmproj="mmproj-F16.gguf", quant="UD-Q4_K_XL", params_b=31.0,
         active_b=31.0, ctx=32768, ctx_max=262144, kv_kib_per_token=80, kv_fixed_gb=0.9, license="apache-2.0",
         strengths=["writing", "vision", "reasoning"], scores=dict(coding=62, writing=88, reasoning=84),
         benchmarks={"LiveCodeBench v6": 80.0, "GPQA Diamond": 84.3},
         speeds=[M("RTX 4090", "4090", 43.8, SRC_RIGBASE, None, note="tg128"),
                 M("RTX 5090", "5090", 70.0, SRC_RIGBASE, None, note="tg128")],
         card="https://huggingface.co/google/gemma-4-31B-it",
         why="Best writer that fits 24 GB: Gemma 4's flagship dense model, with vision."),
    dict(id="nemotron-3.5-bolt-74b-24gb", name="Nemotron 3.5 Bolt 74B-A9B (24GB)", family="nemotron-3.5-bolt",
         repo="nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF", file="NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf",
         mmproj="mmproj-NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf", quant="IQ2 (QAT, native)", params_b=74.0,
         active_b=9.0, moe=True, ctx=65536, ctx_max=262144, kv_kib_per_token=16, kv_fixed_gb=0.5, n_layers=88,
         dense_frac=0.12, active_dense_frac=0.5, license="openmdw-1.1", strengths=["reasoning", "vision", "coding"],
         scores=dict(coding=72, writing=70, reasoning=86),
         benchmarks={"Terminal-Bench 2.1": 50.98, "GPQA Diamond": 86.43},
         spec={"type": "draft-dflash",
               "draft": {"repo": "nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-LiLiCorr-GGUF",
                         "file": "NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-LiLiCorr.gguf"},
               "draft_gb": 1.0, "gain": 1.6, "flags": ["--spec-type", "draft-dflash", "--spec-draft-n-max", "6",
                                                       "--spec-draft-ngl", "999"]},
         card="https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF",
         why="NVIDIA's 2-bit QAT agent model (Oct 2026) made for 24 GB: big-model reasoning, 9B-active speed."),
    # ---- 32 GB / Mac 48-64
    dict(id="qwen3.8-27b-q6", name="Qwen3.8 27B (6-bit)", family="qwen3.8", repo="unsloth/Qwen3.8-27B-GGUF",
         file="Qwen3.8-27B-UD-Q6_K.gguf", mmproj="mmproj-F16.gguf", quant="UD-Q6_K", params_b=27.8, active_b=27.8,
         ctx=131072, ctx_min=16384, ctx_max=262144, kv_kib_per_token=64, kv_fixed_gb=0.3, license="apache-2.0",
         strengths=["coding", "vision", "reasoning"], scores=dict(coding=89, writing=79, reasoning=90),
         benchmarks={"Terminal-Bench 2.1": 73.0, "SWE-bench Pro": 61.7, "GPQA Diamond": 89.2},
         spec={"type": "draft-mtp", "draft": {"repo": "unsloth/Qwen3.8-27B-GGUF", "file": "MTP/mtp-Qwen3.8-27B-Q4_0.gguf"},
               "draft_gb": 1.37, "gain": 1.8, "flags": ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]},
         card="https://huggingface.co/Qwen/Qwen3.8-27B",
         why="Qwen3.8 27B at near-lossless 6-bit for 32 GB cards and 48 GB Macs."),
    dict(id="qwen3.8-27b-q8", name="Qwen3.8 27B (8-bit)", family="qwen3.8", repo="unsloth/Qwen3.8-27B-GGUF",
         file="Qwen3.8-27B-Q8_0.gguf", mmproj="mmproj-F16.gguf", quant="Q8_0", params_b=27.8, active_b=27.8,
         ctx=131072, ctx_min=16384, ctx_max=262144, kv_kib_per_token=64, kv_fixed_gb=0.3, license="apache-2.0",
         strengths=["coding", "vision", "reasoning"], scores=dict(coding=90, writing=79, reasoning=90),
         benchmarks={"Terminal-Bench 2.1": 73.0, "SWE-bench Pro": 61.7, "GPQA Diamond": 89.2},
         spec={"type": "draft-mtp", "draft": {"repo": "unsloth/Qwen3.8-27B-GGUF", "file": "MTP/mtp-Qwen3.8-27B-Q4_0.gguf"},
               "draft_gb": 1.37, "gain": 1.8, "flags": ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"]},
         card="https://huggingface.co/Qwen/Qwen3.8-27B",
         why="Full-quality Qwen3.8 27B with 128K+ context for 64 GB Macs and 48 GB GPU rigs."),
    dict(id="flint-40b-q4", name="Flint 40B-A2.5B", family="flint", repo="unsloth/flint-GGUF",
         file="flint-UD-Q4_K_XL.gguf", quant="UD-Q4_K_XL", params_b=39.8, active_b=2.5, moe=True,
         ctx=131072, ctx_max=262144, kv_kib_per_token=28, kv_fixed_gb=0.1, n_layers=49, dense_frac=0.05,
         active_dense_frac=0.63, license="apache-2.0", strengths=["coding", "speed"],
         scores=dict(coding=80, writing=50, reasoning=70),
         benchmarks={"Terminal-Bench 2.1": 54.9, "SWE-bench Verified": 74.2},
         card="https://huggingface.co/RecursiveSI/flint",
         why="Recursive's coding-agent MoE at 4-bit: SWE-bench Verified 74.2 (self-reported), very fast."),
    dict(id="nemotron-3.5-lightning-30b-q4", name="Nemotron 3.5 Lightning 30B-A3B", family="nemotron-3.5-lightning",
         repo="ggml-org/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF", file="NVIDIA-Nemotron-3.5-Lightning-30B-A3B-Q4_0.gguf",
         quant="Q4_0", params_b=31.6, active_b=3.0, moe=True, ctx=131072, ctx_max=262144, kv_kib_per_token=8,
         kv_fixed_gb=0.3, n_layers=52, dense_frac=0.1, active_dense_frac=0.5, license="openmdw-1.1",
         strengths=["speed", "reasoning"], scores=dict(coding=52, writing=62, reasoning=74),
         benchmarks={"SWE-bench Verified": 51.6, "Terminal-Bench 2.1": 23.5, "GPQA Diamond": 75.6},
         card="https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16",
         why="Hybrid Mamba MoE: tiny KV cache, so very long context stays cheap and fast."),
    # ---- 96-128 GB (Mac 96/128, Spark, multi-GPU + RAM)
    dict(id="gpt-oss-120b", name="gpt-oss 120B", family="gpt-oss", repo="ggml-org/gpt-oss-120b-GGUF",
         file="gpt-oss-120b-MXFP4.gguf", quant="MXFP4 (native)", params_b=117.0, active_b=5.1, moe=True,
         ctx=131072, ctx_max=131072, kv_kib_per_token=36, kv_fixed_gb=0.1, n_layers=36, dense_frac=0.04,
         active_dense_frac=0.3, license="apache-2.0", strengths=["speed", "reasoning"],
         scores=dict(coding=60, writing=66, reasoning=80),
         speeds=[M("RTX Pro 6000 (96GB)", "rtx pro 6000", 196.3, SRC_15396, "MXFP4"),
                 M("Apple M2 Ultra", "m2 ultra", 79.7, "https://github.com/ggml-org/llama.cpp/discussions/4167", "MXFP4")],
         card="https://huggingface.co/openai/gpt-oss-120b",
         why="OpenAI's big open MoE: fast and dependable on 96 GB+ machines."),
    dict(id="nemotron-3.5-bolt-74b-q4", name="Nemotron 3.5 Bolt 74B-A9B (4-bit)", family="nemotron-3.5-bolt",
         repo="unsloth/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-GGUF",
         file="UD-Q4_K_XL/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-UD-Q4_K_XL-00001-of-00003.gguf", mmproj="mmproj-BF16.gguf",
         quant="UD-Q4_K_XL", params_b=74.0, active_b=9.0, moe=True, ctx=131072, ctx_max=262144, kv_kib_per_token=16,
         kv_fixed_gb=0.5, n_layers=88, dense_frac=0.12, active_dense_frac=0.5, license="openmdw-1.1",
         strengths=["reasoning", "vision", "coding"], scores=dict(coding=74, writing=72, reasoning=87),
         benchmarks={"Terminal-Bench 2.1": 50.98, "GPQA Diamond": 86.43},
         card="https://huggingface.co/unsloth/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-GGUF",
         why="Nemotron Bolt at 4-bit for 64-96 GB machines: more headroom than the 2-bit 24GB build."),
    dict(id="ornith-1.5-122b-q3", name="Ornith 1.5 122B (3-bit)", family="ornith", repo="unsloth/Ornith-1.5-122B-GGUF",
         file="UD-Q3_K_XL/Ornith-1.5-122B-UD-Q3_K_XL-00001-of-00003.gguf", mmproj="mmproj-F16.gguf",
         quant="UD-Q3_K_XL", params_b=125.1, active_b=10.0, moe=True, ctx=131072, ctx_max=262144,
         kv_kib_per_token=24, kv_fixed_gb=0.4, n_layers=48, dense_frac=0.07, active_dense_frac=0.64, license="mit",
         strengths=["coding", "reasoning", "vision"], scores=dict(coding=91, writing=74, reasoning=89),
         benchmarks={"Terminal-Bench 2.1": 81.2, "SWE-bench Pro": 76.9},
         card="https://huggingface.co/ornith-ai/Ornith-1.5-122B",
         why="Top open coder that fits 96 GB (Oct 2026): Terminal-Bench 2.1 81.2 (self-reported)."),
    dict(id="ornith-1.5-122b-q4", name="Ornith 1.5 122B", family="ornith", repo="unsloth/Ornith-1.5-122B-GGUF",
         file="UD-Q4_K_XL/Ornith-1.5-122B-UD-Q4_K_XL-00001-of-00003.gguf", mmproj="mmproj-F16.gguf",
         quant="UD-Q4_K_XL", params_b=125.1, active_b=10.0, moe=True, ctx=131072, ctx_max=262144,
         kv_kib_per_token=24, kv_fixed_gb=0.4, n_layers=48, dense_frac=0.07, active_dense_frac=0.64, license="mit",
         strengths=["coding", "reasoning", "vision"], scores=dict(coding=93, writing=76, reasoning=90),
         benchmarks={"Terminal-Bench 2.1": 81.2, "SWE-bench Pro": 76.9},
         card="https://huggingface.co/ornith-ai/Ornith-1.5-122B",
         why="Best coder for a 128 GB Mac or DGX Spark: Terminal-Bench 2.1 81.2, SWE-bench Pro 76.9 (self-reported)."),
    dict(id="nemotron-3.5-super-120b-q4", name="Nemotron 3.5 Super VL 120B-A12B", family="nemotron-3.5-super",
         repo="unsloth/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-GGUF",
         file="UD-Q4_K_XL/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-UD-Q4_K_XL-00001-of-00003.gguf",
         mmproj="mmproj-BF16.gguf", quant="UD-Q4_K_XL", params_b=124.5, active_b=12.0, moe=True,
         ctx=131072, ctx_max=1048576, kv_kib_per_token=16, kv_fixed_gb=0.6, n_layers=88, dense_frac=0.1,
         active_dense_frac=0.5, license="openmdw-1.1", strengths=["reasoning", "vision", "writing"],
         scores=dict(coding=80, writing=76, reasoning=88),
         benchmarks={"SWE-bench Verified": 71.1, "Terminal-Bench 2.1": 60.67},
         card="https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16",
         why="NVIDIA's 120B vision MoE: long context on cheap KV, strong all-round on 128 GB boxes."),
    dict(id="qwen3.8-flash-next-iq3s", name="Qwen3.8 Flash-Next (3.5-bit GSQ)", family="qwen3.8-flash",
         repo="ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF",
         file="IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf",
         mmproj="mmproj-Qwen3.8-Flash-Next-BF16.gguf", quant="GSQ-RCO IQ3_S", params_b=180.0, active_b=6.0,
         active_gb=4.5, moe=True, ctx=131072, ctx_max=262144, kv_kib_per_token=24, kv_fixed_gb=0.4, n_layers=48,
         dense_frac=0.1, active_dense_frac=0.6, license="apache-2.0", strengths=["coding", "reasoning", "writing", "vision"],
         scores=dict(coding=92, writing=82, reasoning=92),
         benchmarks={"SWE-bench Pro": 62.5, "Terminal-Bench 2.1": 83.4, "GPQA Diamond": 91.7},
         card="https://huggingface.co/Qwen/Qwen3.8-Flash-Next",
         why="Qwen's 125B-A6B flagship MoE in 84 GB: frontier-class coding and writing, 6B-active speed."),
    dict(id="qwen3.8-flash-next-q4", name="Qwen3.8 Flash-Next", family="qwen3.8-flash",
         repo="lmstudio-community/Qwen3.8-Flash-Next-GGUF", file="Qwen3.8-Flash-Next-Q4_K_M-00001-of-00003.gguf",
         mmproj="mmproj-Qwen3.8-Flash-Next-BF16.gguf", quant="Q4_K_M", params_b=180.0, active_b=6.0, active_gb=5.5,
         moe=True, ctx=131072, ctx_max=262144, kv_kib_per_token=24, kv_fixed_gb=0.4, n_layers=48, dense_frac=0.1,
         active_dense_frac=0.6, license="apache-2.0", strengths=["coding", "reasoning", "writing", "vision"],
         scores=dict(coding=93, writing=83, reasoning=93),
         benchmarks={"SWE-bench Pro": 62.5, "Terminal-Bench 2.1": 83.4, "GPQA Diamond": 91.7},
         card="https://huggingface.co/Qwen/Qwen3.8-Flash-Next",
         why="Qwen3.8 Flash-Next at standard 4-bit for 192 GB Macs and multi-GPU workstations."),
    dict(id="glm-5.3-flash-iq2xxs", name="GLM-5.3-Flash (2-bit)", family="glm-5.3-flash", repo="unsloth/GLM-5.3-Flash-GGUF",
         file="UD-IQ2_XXS/GLM-5.3-Flash-UD-IQ2_XXS-00001-of-00004.gguf", mmproj="mmproj-F16.gguf",
         quant="UD-IQ2_XXS", params_b=321.3, active_b=18.0, active_gb=11.0, moe=True, ctx=32768, ctx_min=16384,
         ctx_max=1048576, kv_kib_per_token=64, kv_fixed_gb=0.5, n_layers=45, dense_frac=0.06, active_dense_frac=0.5,
         license="mit", strengths=["coding", "reasoning", "writing", "vision"],
         scores=dict(coding=95, writing=86, reasoning=94),
         benchmarks={"Terminal-Bench 2.1": 84.3},
         bench_note="Terminal-Bench 2.1 from aireleasetracker.com/askclash.ai quoting Z.ai's card image",
         speeds_note="autotrust GLM-5.3-Flash Q2 card: ~11 GB read/token, 15-20 tok/s single-stream on a Spark (est)",
         card="https://huggingface.co/zai-org/GLM-5.3-Flash",
         why="Z.ai's 320B-A18B flagship squeezed into 102 GB: strongest model a single 128 GB box can hold."),
    dict(id="deepseek-v4.1-flash-1017-iq2xxs", name="DeepSeek V4.1 Flash 1017 (2-bit GSQ)", family="deepseek-v4.1",
         repo="ISTA-DASLab/DeepSeek-V4.1-Flash-1017-GSQ-RCO-GGUF",
         file="DeepSeek-V4.1-Flash-1017-GSQ-RCO-IQ2_XXS-00001-of-00004.gguf",
         extra_files=["DeepSeek-V4.1-Flash-Engram-IQ4_NL.gguf"], quant="GSQ-RCO IQ2_XXS + Engram IQ4_NL",
         params_b=763.2, active_b=30.0, moe=True, ctx=65536, ctx_max=1048576, kv_kib_per_token=16,
         license="mit", strengths=["coding", "reasoning", "writing"], scores=dict(coding=97, writing=88, reasoning=95),
         benchmarks={"Terminal-Bench 4.0": 42.3, "DeepSWE v1.1": 77.0},
         status="needs_runtime",
         status_note="llama.cpp does not support DeepSeek-V4.1 yet (per ISTA-DASLab card, 2026-10-23); runs in "
                     "Strata (NVIDIA) or antirez/DwarfStar (Metal, SSD streaming).",
         card="https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017",
         why="DeepSeek's newest (Oct 17) — offered automatically once llama.cpp adds V4.1 support."),
]

COMPANIONS = [
    # speech-to-text (whisper.cpp)
    dict(id="whisper-small-q5", kind="stt", name="Whisper small", runtime="whisper.cpp",
         model={"repo": "ggerganov/whisper.cpp", "file": "ggml-small-q5_1.bin"}, license="mit", rank=1,
         requires={"min_mem_gb": 0}, why="Light speech-to-text that keeps up in real time on any CPU."),
    dict(id="whisper-large-v3-turbo-q5", kind="stt", name="Whisper large-v3 turbo", runtime="whisper.cpp",
         model={"repo": "ggerganov/whisper.cpp", "file": "ggml-large-v3-turbo-q5_0.bin"}, license="mit", rank=3,
         requires={"min_mem_gb": 6}, why="Near-best open dictation accuracy, fast on any GPU or Apple Silicon."),
    dict(id="nemotron-3.5-asr-0.6b", kind="stt", name="Nemotron 3.5 ASR streaming 0.6B", runtime="transcribe.cpp",
         model={"repo": "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
                "file": "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf"}, license="openmdw-1.1", rank=0.5,
         requires={"min_mem_gb": 2}, why="Streaming (live captions) ASR; optional, needs transcribe.cpp."),
    # text-to-speech
    dict(id="kitten-tts-nano", kind="tts", name="KittenTTS nano 0.8", runtime="onnxruntime",
         model={"repo": "KittenML/kitten-tts-nano-0.8", "file": "kitten_tts_nano_v0_8.onnx"}, license="apache-2.0",
         rank=1, requires={"min_mem_gb": 0}, why="60 MB voice that runs on the weakest CPU."),
    dict(id="piper-lessac-medium", kind="tts", name="Piper (en_US lessac)", runtime="piper",
         model={"repo": "rhasspy/piper-voices", "file": "en/en_US/lessac/medium/en_US-lessac-medium.onnx"},
         license="mit", rank=2, requires={"min_mem_gb": 0}, why="Fast, many languages (pick another voice file)."),
    dict(id="kokoro-82m", kind="tts", name="Kokoro 82M", runtime="onnxruntime",
         model={"repo": "onnx-community/Kokoro-82M-v1.0-ONNX", "file": "onnx/model_q8f16.onnx"}, license="apache-2.0",
         rank=3, requires={"min_mem_gb": 2}, why="Most natural small open voice; real-time on CPU."),
    # image generation (all need a GPU / Apple Silicon to be practical)
    dict(id="z-image-turbo-q4", kind="image", name="Z-Image Turbo", runtime="stable-diffusion.cpp",
         model={"repo": "unsloth/Z-Image-Turbo-GGUF", "file": "z-image-turbo-Q4_K_M.gguf",
                "text_encoder": {"repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF", "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"},
                "vae": {"repo": "Tongyi-MAI/Z-Image-Turbo", "file": "vae/diffusion_pytorch_model.safetensors"}},
         license="apache-2.0", rank=3, requires={"min_mem_gb": 8, "gpu_only": True},
         speed="8 steps; ~seconds per 1024px image on a modern GPU (est)",
         why="Fast photoreal images, Apache-2.0 (fine for commercial work), ~8 GB."),
    dict(id="flux-3-klein-q4", kind="image", name="FLUX 3 Image Klein", runtime="diffusers/ComfyUI",
         model={"repo": "unsloth/flux-3-image-klein-GGUF", "file": "flux-3-image-klein-UD-Q4_K_XL.gguf",
                "text_encoder": {"repo": "unsloth/Qwen3-VL-4B-Instruct-GGUF", "file": "Qwen3-VL-4B-Instruct-Q4_K_M.gguf"},
                "vae": {"repo": "black-forest-labs/flux-3-image-klein", "file": "ae.safetensors"}},
         license="flux-kommunity (non-commercial; commercial-output exception for qualifying users)", rank=2.5,
         requires={"min_mem_gb": 8, "gpu_only": True},
         why="Newest BFL open model (Oct 2026): text-to-image + editing with up to 10 reference images."),
    dict(id="qwen-image-2.1-turbo-q4", kind="image", name="Qwen-Image 2.1 Turbo", runtime="stable-diffusion.cpp",
         model={"repo": "unsloth/Qwen-Image-2.1-Turbo-GGUF", "file": "qwen-image-2.1-turbo-Q4_K_M.gguf",
                "text_encoder": {"repo": "unsloth/Qwen3-VL-8B-Instruct-GGUF", "file": "Qwen3-VL-8B-Instruct-UD-Q4_K_XL.gguf"}},
         license="qwen-research (non-commercial)", rank=2, requires={"min_mem_gb": 14, "gpu_only": True},
         why="Best text rendering in images (posters, slides); research license."),
    # video generation: only where it's realistic
    dict(id="wan2.2-ti2v-5b-q4", kind="video", name="Wan 2.2 TI2V 5B", runtime="ComfyUI",
         model={"repo": "QuantStack/Wan2.2-TI2V-5B-GGUF", "file": "Wan2.2-TI2V-5B-Q4_K_M.gguf",
                "text_encoder": {"repo": "Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
                                 "file": "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"},
                "vae": {"repo": "QuantStack/Wan2.2-TI2V-5B-GGUF", "file": "VAE/Wan2.2_VAE.safetensors"}},
         license="apache-2.0", rank=2, requires={"min_mem_gb": 12, "gpu_only": True, "accelerators": ["cuda", "rocm"]},
         speed="5 s 720p clip in minutes on a 12-16 GB NVIDIA card (est)",
         why="Smallest decent text/image-to-video; needs a real GPU."),
    dict(id="ltx-2.3-22b-q4", kind="video", name="LTX-2.3 22B (distilled)", runtime="ComfyUI",
         model={"repo": "unsloth/LTX-2.3-GGUF", "file": "distilled-1.1/ltx-2.3-22b-distilled-1.1-Q4_K_M.gguf",
                "text_encoder": {"repo": "unsloth/gemma-3-12b-it-qat-GGUF", "file": "gemma-3-12b-it-qat-UD-Q4_K_XL.gguf"}},
         license="ltx-2-community", rank=3, requires={"min_mem_gb": 24, "gpu_only": True, "accelerators": ["cuda"]},
         why="Best local video with synced audio; 24 GB+ NVIDIA or DGX Spark."),
]

# ---------------------------------------------------------------- reference hardware for est_tps
def _sys(name, gpus, ram, unified=False, os_="linux", cpu="x86", bw=None, usable=None):
    s = {"os": os_, "arch": "arm64" if unified and os_ == "macos" else "x64", "cpu": {"name": cpu, "cores": 8},
         "ram_gb": ram, "gpus": gpus, "unified_memory": unified, "disk_free_gb": 500,
         "accelerators": ["cuda", "cpu"] if gpus and gpus[0]["vendor"] == "nvidia" else ["metal", "cpu"] if unified and os_ == "macos" else ["cpu"],
         "runtimes": {}}
    from pico import hwscan
    s["usable_vram_gb"] = usable if usable is not None else hwscan.usable_vram_gb(s)
    s["mem_bandwidth_gbps"] = bw or hwscan.mem_bandwidth(s)
    return name, s


def _nv(name, vram):
    return {"vendor": "nvidia", "name": name, "vram_gb": vram, "driver": "580", "compute": "cuda"}


def _ap(name, ram):
    return {"vendor": "apple", "name": name, "vram_gb": ram, "driver": None, "compute": "metal"}


REFERENCE = dict([
    _sys("cpu-16", [], 16, cpu="Intel Core i5-12400"),
    _sys("rtx3060-12", [_nv("NVIDIA GeForce RTX 3060", 12)], 32),
    _sys("rtx4070s-12+64", [_nv("NVIDIA GeForce RTX 4070 SUPER", 12)], 64, os_="windows"),
    _sys("rtx5060ti-16", [_nv("NVIDIA GeForce RTX 5060 Ti", 16)], 32),
    _sys("rtx4090-24", [_nv("NVIDIA GeForce RTX 4090", 24)], 64),
    _sys("rtx5090-32", [_nv("NVIDIA GeForce RTX 5090", 32)], 64),
    _sys("2x3090-48", [_nv("NVIDIA GeForce RTX 3090", 24), _nv("NVIDIA GeForce RTX 3090", 24)], 128),
    _sys("mac-m4-16", [_ap("Apple M4", 16)], 16, unified=True, os_="macos", cpu="Apple M4"),
    _sys("mac-m3pro-18", [_ap("Apple M3 Pro", 18)], 18, unified=True, os_="macos", cpu="Apple M3 Pro"),
    _sys("mac-m4pro-24", [_ap("Apple M4 Pro", 24)], 24, unified=True, os_="macos", cpu="Apple M4 Pro"),
    _sys("mac-m4max-36", [_ap("Apple M4 Max", 36)], 36, unified=True, os_="macos", cpu="Apple M4 Max"),
    _sys("mac-m4pro-48", [_ap("Apple M4 Pro", 48)], 48, unified=True, os_="macos", cpu="Apple M4 Pro"),
    _sys("mac-m4max-64", [_ap("Apple M4 Max", 64)], 64, unified=True, os_="macos", cpu="Apple M4 Max"),
    _sys("mac-m3ultra-96", [_ap("Apple M3 Ultra", 96)], 96, unified=True, os_="macos", cpu="Apple M3 Ultra"),
    _sys("mac-m4max-128", [_ap("Apple M4 Max", 128)], 128, unified=True, os_="macos", cpu="Apple M4 Max"),
    _sys("mac-m3ultra-192", [_ap("Apple M3 Ultra", 192)], 192, unified=True, os_="macos", cpu="Apple M3 Ultra"),
    _sys("dgx-spark-128", [_nv("NVIDIA GB10", 128)], 128, unified=True, cpu="NVIDIA Grace (GB10)"),
])


# ---------------------------------------------------------------- HF helpers
_BLOBS: dict[str, dict] = {}


def blobs(repo: str) -> dict:
    if repo not in _BLOBS:
        req = urllib.request.Request(f"https://huggingface.co/api/models/{repo}?blobs=true", headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            m = json.load(r)
        _BLOBS[repo] = {s["rfilename"]: s for s in m.get("siblings", [])}
    return _BLOBS[repo]


_SPLIT = re.compile(r"^(?P<stem>.+)-(?P<i>\d{5})-of-(?P<n>\d{5})\.gguf$")


def file_info(repo: str, file: str) -> tuple[float, list[dict]]:
    """Total bytes (GB, 1e9) over all split parts + per-part [{file,size,sha256}]."""
    b = blobs(repo)
    name = file.rsplit("/", 1)[-1]
    prefix = file[: len(file) - len(name)]
    m = _SPLIT.match(name)
    names = [file] if not m else [f"{prefix}{m['stem']}-{i:05d}-of-{m['n']}.gguf" for i in range(1, int(m["n"]) + 1)]
    parts = []
    for n in names:
        s = b.get(n)
        if not s:
            raise SystemExit(f"missing on HF: {repo}/{n}")
        parts.append({"file": n, "size": s.get("size") or (s.get("lfs") or {}).get("size"),
                      "sha256": (s.get("lfs") or {}).get("sha256")})
    return sum(p["size"] for p in parts) / 1e9, parts


# ---------------------------------------------------------------- build
def build() -> dict:
    recipes = []
    for spec in LLMS:
        r = {k: v for k, v in spec.items() if k not in ("repo", "file", "mmproj", "extra_files", "card")}
        gb, parts = file_info(spec["repo"], spec["file"])
        extra_gb = 0.0
        for ef in spec.get("extra_files", []):
            g2, p2 = file_info(spec["repo"], ef)
            extra_gb += g2
            parts += p2
        model = {"repo": spec["repo"], "file": spec["file"], "parts": parts}
        if len(parts) == 1 and parts[0].get("sha256"):
            model["sha256"] = parts[0]["sha256"]
        if spec.get("mmproj"):
            mg, mp = file_info(spec["repo"], spec["mmproj"])
            model["mmproj"] = {"repo": spec["repo"], "file": spec["mmproj"], "size_gb": round(mg, 2),
                               "sha256": mp[0].get("sha256")}
        sp = r.get("spec")
        if sp and sp.get("draft"):
            dg, _ = file_info(sp["draft"]["repo"], sp["draft"]["file"])
            sp["draft_gb"] = round(dg, 2)
        r.update({
            "kind": "llm", "runtime": "llama.cpp", "model": model, "file_gb": round(gb + extra_gb, 2),
            "flags": list(GPU_FLAGS), "card_url": spec.get("card"), "status": spec.get("status", "available"),
            "bench_source": spec.get("bench_note") or (f"{spec.get('card')} (self-reported)" if spec.get("benchmarks") else None),
        })
        r.setdefault("speeds", [])
        # derived numbers: min memory (resident at ctx_min) and est tok/s on each reference box
        r["min_mem_gb"] = round(R.need_gb(r, int(r.get("ctx_min") or 8192)), 1)
        est = {}
        for ref, sysd in REFERENCE.items():
            e = R.estimate(r, sysd, ctx=r.get("ctx"))
            if e["fits"]:
                est[ref] = {"tps": e["est_tps"], "source": e["tps_source"], "mode": e["mode"], "ctx": e["ctx"]}
        r["est_tps"] = est
        r["tps_source"] = "measured" if any(v["source"] == "measured" for v in est.values()) else "est"
        recipes.append(r)
    comps = []
    for c in COMPANIONS:
        c = dict(c)
        total = 0.0
        m = c["model"]
        for sub in [m, m.get("text_encoder"), m.get("vae")]:
            if sub:
                g, p = file_info(sub["repo"], sub["file"])
                sub["size_gb"] = round(g, 3)
                if p[0].get("sha256"):
                    sub["sha256"] = p[0]["sha256"]
                total += g
        c["size_gb"] = round(total, 2)
        comps.append(c)
    return {
        "schema": 1,
        "version": VERSION,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "notes": ("file_gb = summed HF file bytes (1e9). est_tps: 'measured' = cited llama.cpp result for that "
                  "exact quant on that hardware; 'est' = bandwidth model (engine/pico/recipes.py). Benchmarks "
                  "are vendor self-reported. Speculative-decoding gains are not included unless the runtime "
                  "enables recipe.spec."),
        "reference_hardware": {k: {"gpus": [g["name"] for g in v["gpus"]], "ram_gb": v["ram_gb"],
                                   "usable_gb": v["usable_vram_gb"], "bandwidth_gbps": v["mem_bandwidth_gbps"]}
                               for k, v in REFERENCE.items()},
        "recipes": recipes,
        "companions": comps,
    }


def table(cat: dict) -> str:
    refs = ["rtx3060-12", "rtx4090-24", "mac-m3pro-18", "mac-m4max-128", "dgx-spark-128"]
    lines = [f"{'id':34} {'GB':>6} {'min':>6}  " + " ".join(f"{r[:13]:>13}" for r in refs)]
    for r in cat["recipes"]:
        cells = []
        for ref in refs:
            e = r["est_tps"].get(ref)
            cells.append(f"{e['tps']:>8.0f}{'m' if e['source'] == 'measured' else 'e'}{'*' if e['mode'] == 'offload' else ' '}   " if e else f"{'-':>13}")
        lines.append(f"{r['id']:34} {r['file_gb']:>6.1f} {r['min_mem_gb']:>6.1f}  " + " ".join(cells)
                     + ("  [needs runtime]" if r["status"] != "available" else ""))
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default=str(ROOT / "recipes" / "catalog.json"))
    a = ap.parse_args()
    cat = build()
    print(table(cat))
    if not a.check:
        Path(a.out).write_text(json.dumps(cat, indent=1) + "\n")
        print(f"wrote {a.out}: {len(cat['recipes'])} recipes, {len(cat['companions'])} companions, v{cat['version']}")
