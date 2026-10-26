import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402

from pico import recipes as R  # noqa: E402
from fixtures_systems import SYSTEMS  # noqa: E402

API_KEYS = {"id", "model", "family", "params_b", "active_b", "quant", "file_gb", "ctx", "runtime", "flags",
            "est_tps", "tps_source", "strengths", "fits", "why"}


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("PICO_HOME", str(tmp_path))
    R.load_catalog(refresh=True)
    yield
    R._CACHE.clear()


def test_catalog_valid():
    cat = R.load_catalog()
    assert cat["version"] and cat["schema"] == 1
    ids = [r["id"] for r in cat["recipes"]]
    assert len(ids) == len(set(ids)) >= 20
    for r in cat["recipes"]:
        assert r["runtime"] == "llama.cpp" and r["file_gb"] > 0 and r["min_mem_gb"] > r["file_gb"]
        assert r["model"]["repo"] and r["model"]["file"] and r["model"]["parts"]
        assert sum(p["size"] for p in r["model"]["parts"]) > 0
        assert r["tps_source"] in ("measured", "est")
        assert r["license"] and r["why"] and r["strengths"]
        for s in r.get("speeds", []):
            assert s["url"].startswith("http")
        # runtime adds -c/--jinja/-m itself; recipe flags must not carry file paths or host/port
        assert not {"-m", "--model", "--host", "--port", "-c"} & set(r["flags"])
    kinds = {c["kind"] for c in cat["companions"]}
    assert kinds == {"stt", "tts", "image", "video"}


@pytest.mark.parametrize("name", list(SYSTEMS))
@pytest.mark.parametrize("persona", R.PERSONAS)
def test_every_fixture_gets_a_fitting_pick(name, persona):
    res = R.recommend(SYSTEMS[name], persona)
    rec = res["recommended"]
    assert rec is not None, (name, persona)
    assert API_KEYS <= set(rec)
    assert rec["fits"] and rec["est_tps"] >= R.MIN_TPS
    assert res["catalog_version"] == R.load_catalog()["version"]
    ids = [rec["id"]] + [a["id"] for a in res["alternatives"]]
    assert len(ids) == len(set(ids))
    json.dumps(res)


def _rec(name, persona):
    return R.recommend(SYSTEMS[name], persona)["recommended"]


def test_fit_math_respects_memory():
    s = SYSTEMS["m3pro_18"]
    for p in R.PERSONAS:
        r = _rec("m3pro_18", p)
        assert r["fit"]["mode"] == "unified"
        assert r["fit"]["need_gb"] <= s["usable_vram_gb"]
    # dense 27B Q4 (17.6 GB) never 'fits' a 12.6 GB Mac budget, nor gets offloaded on an 8 GB card
    q = R.get("qwen3.8-27b-q4")
    assert not R.estimate(q, s)["fits"]
    assert not R.estimate(q, SYSTEMS["rtx3060_8"])["fits"]


def test_moe_offload_on_small_gpu_big_ram():
    e = R.estimate(R.get("qwen3.6-35b-a3b-q4"), SYSTEMS["rtx4070s_12_64"], ctx=32768)
    assert e["fits"] and e["mode"] == "offload" and e["n_cpu_moe"] > 0
    assert 25 <= e["est_tps"] <= 120  # community: 39 (3060) .. ~110 (tuned 12 GB)
    pub = R.recommend(SYSTEMS["rtx4070s_12_64"], "general")["recommended"]
    if pub["fit"]["mode"] == "offload":
        assert "--n-cpu-moe" in pub["flags"]


def test_engineer_gets_coding_model():
    for name in ("rtx4090_24", "rtx4070s_12_64", "mac_studio_128", "dgx_spark_128"):
        r = R.get(_rec(name, "engineer")["id"])
        assert "coding" in r["strengths"] and r["scores"]["coding"] >= 75, (name, r["id"])
    # 24 GB card: smartest coder that fits fully on GPU is a Qwen3.8 27B build
    assert _rec("rtx4090_24", "engineer")["id"].startswith("qwen3.8-27b")


def test_creative_gets_writer_and_image():
    for name in ("rtx4090_24", "mac_studio_128", "dgx_spark_128"):
        res = R.recommend(SYSTEMS[name], "creative")
        r = R.get(res["recommended"]["id"])
        assert r["scores"]["writing"] >= 80, (name, r["id"])
        assert res["companions"]["enable"]["image"] is True
    # video only where realistic: NVIDIA 24 GB yes, 8 GB card no, CPU no, Apple no (CUDA/ROCm-only pipelines)
    assert R.recommend(SYSTEMS["rtx4090_24"], "creative")["companions"]["video"] is not None
    assert R.recommend(SYSTEMS["rtx3060_8"], "creative")["companions"]["video"] is None
    assert R.recommend(SYSTEMS["cpu_16"], "creative")["companions"]["image"] is None
    assert R.recommend(SYSTEMS["m3pro_18"], "general")["companions"]["enable"]["image"] is False


def test_business_prefers_speed():
    r = _rec("rtx4090_24", "business")
    assert r["est_tps"] >= 100


def test_cpu_only_small_model():
    r = _rec("cpu_16", "general")
    assert r["fit"]["mode"] == "cpu" and r["file_gb"] < 6
    assert r["flags"][:2] == ["-ngl", "0"]


def test_big_boxes_get_big_models():
    assert _rec("dgx_spark_128", "general")["file_gb"] > 50
    assert _rec("mac_studio_128", "engineer")["file_gb"] > 50


def test_deepseek_v41_listed_but_not_offered_until_runtime():
    d = R.get("deepseek-v4.1-flash-1017-iq2xxs")
    assert d and d["status"] == "needs_runtime"
    assert not R.estimate(d, SYSTEMS["dgx_spark_128"])["fits"]


def test_measured_speed_used_when_exact_match():
    e = R.estimate(R.get("gpt-oss-20b"), SYSTEMS["rtx4090_24"])
    assert e["tps_source"] == "measured" and e["est_tps"] == pytest.approx(221.9)


def test_updates_offer_only_better_fitting():
    ups = R.updates(SYSTEMS["rtx4070s_12_64"], "gemma-4-12b-qat", "engineer")
    assert ups and all(u["kind"] in ("model", "config") for u in ups)
    for u in ups:
        assert set(u) == {"kind", "from", "to", "delta", "why"}
        assert set(u["delta"]) == {"tps", "ctx", "quality"}
        assert R.estimate(R.get(u["to"]), SYSTEMS["rtx4070s_12_64"])["fits"]
    # already on the top pick -> no model upgrade offered
    top = _rec("rtx4090_24", "engineer")["id"]
    assert not [u for u in R.updates(SYSTEMS["rtx4090_24"], top, "engineer") if u["kind"] == "model"]


def test_config_update_when_ctx_grows():
    top = R.recommend(SYSTEMS["rtx4090_24"], "engineer")["recommended"]
    ups = R.updates(SYSTEMS["rtx4090_24"], top["id"], "engineer", current={"ctx": 8192, "flags": top["flags"]})
    cfg = [u for u in ups if u["kind"] == "config"]
    assert cfg and cfg[0]["delta"]["ctx"] > 0


def test_user_catalog_newer_wins_and_fetch_rejects_garbage(tmp_path, monkeypatch):
    cat = R.load_catalog()
    newer = dict(cat, version="2099.1.1")
    newer["recipes"] = cat["recipes"][:3]
    (tmp_path / "catalog.json").write_text(json.dumps(newer))
    assert R.load_catalog(refresh=True)["version"] == "2099.1.1"
    (tmp_path / "catalog.json").write_text("{not json")
    assert R.load_catalog(refresh=True)["version"] == cat["version"]
    assert R.fetch_catalog("http://127.0.0.1:9/nope.json", timeout=0.5) is None


def test_fetch_catalog_from_file_url(tmp_path):
    cat = R.load_catalog()
    src = tmp_path / "remote.json"
    src.write_text(json.dumps(dict(cat, version="2099.2.2")))
    got = R.fetch_catalog(src.as_uri())
    assert got and got["version"] == "2099.2.2"
    assert (tmp_path / "catalog.json").exists()
