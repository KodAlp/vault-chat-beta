"""RAG benchmark sonuçlarından PNG grafikler üretir.

    python bench/charts.py [--results data/vaults/default/bench/results] [--out ~/Desktop/RAG-benchmark-grafikleri]
                           [--generation <generation.json>]

Retrieval: sonuç klasörlerindeki her retrieval.json okunur; her varyant için en yeni koşu
kullanılır. Üretim: --generation verilmezse yargıçlı (judged) en yeni generation.json.
Yanıt dili grafiği scripts/eval-response-language.ts ölçümünün (2026-09-27) sayılarını taşır.

Yalnızca okur; tek yazdığı yer --out klasörü. Renkler: dataviz referans paletinin ilk iki
kategorik slotu (mavi, turuncu; açık zeminde CVD doğrulamasından geçti) + nötr gri taban.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

SURFACE = "#fcfcfb"
TEXT = "#0b0b0b"
TEXT_2 = "#52514e"
MUTED = "#8b8a85"
GRID = "#e6e5e1"
BLUE = "#2a78d6"
ORANGE = "#eb6834"
BASELINE = "#a9a8a3"

VARIANT_ORDER = [
    "prod", "prod+kw", "vector-raw", "bm25", "hybrid",
    "vector+rerank", "hybrid+rerank", "hybrid+rerank+qx",
]
VARIANT_LABEL = {
    "prod": "prod (bugün)",
    "prod+kw": "prod + keyword yedeği",
    "vector-raw": "vektör (eşiksiz)",
    "bm25": "BM25",
    "hybrid": "hybrid (RRF)",
    "vector+rerank": "vektör + reranker",
    "hybrid+rerank": "hybrid + reranker",
    "hybrid+rerank+qx": "hybrid + reranker + sorgu genişletme",
}
TYPE_LABEL = {
    "direct": "direct", "conceptual": "conceptual", "multi_hop": "multi-hop",
    "cross_document": "cross-document", "comparison": "comparison", "numerical": "numerical",
    "long_context": "long-context", "ambiguous": "ambiguous", "followup": "takip",
}

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "text.color": TEXT, "axes.labelcolor": TEXT_2, "xtick.color": TEXT_2, "ytick.color": TEXT,
    "axes.edgecolor": GRID, "axes.spines.top": False, "axes.spines.right": False,
    "axes.spines.left": False, "font.family": "Segoe UI", "font.size": 10.5,
    "axes.titlesize": 12.5, "axes.titleweight": "bold", "axes.titlelocation": "left",
    "axes.titlecolor": TEXT, "legend.frameon": False,
})


def _finish(fig, path: Path, note: str | None = None) -> None:
    if note:
        fig.text(0.01, -0.03, note, fontsize=8.5, color=MUTED, ha="left", va="top")
    fig.savefig(path, dpi=160, bbox_inches="tight", pad_inches=0.25)
    plt.close(fig)
    print(f"  {path.name}")


def _xgrid(ax, lim=(0, 1), pct=True):
    ax.set_xlim(*lim)
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.tick_params(axis="y", length=0)
    if pct:
        ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0, decimals=0))


def load_retrieval(results_dir: Path):
    """variant -> (report, items-by-id, run name); newest run wins per variant."""
    reports, items = {}, {}
    for path in sorted(glob.glob(str(results_dir / "*" / "retrieval.json"))):
        run = json.loads(Path(path).read_text(encoding="utf-8"))
        name = Path(path).parent.name
        if run.get("counts", {}).get("eligible", 1) and len(run.get("items", [])) < 20:
            continue  # smoke runs on the 3-line sample
        for rep in run["variantReports"]:
            reports[rep["variant"]] = (rep, name)
            items[rep["variant"]] = {it["id"]: it for it in run["items"]}
    return reports, items, run


def chart_ablation(reports, out: Path):
    variants = [v for v in VARIANT_ORDER if v in reports]
    fig, axes = plt.subplots(1, 2, figsize=(12.5, 0.52 * len(variants) + 1.6), sharey=True)
    for ax, (metric, title) in zip(axes, [("recall5", "Recall@5"), ("ndcg10", "nDCG@10")]):
        ys = list(range(len(variants)))[::-1]
        for y, v in zip(ys, variants):
            m = reports[v][0]["chunk"][metric]
            color = BASELINE if v == "prod" else BLUE
            ax.barh(y, m["mean"], height=0.55, color=color, zorder=2)
            ax.plot([m["lo"], m["hi"]], [y, y], color=TEXT, linewidth=1.1, zorder=3)
            ax.text(m["hi"] + 0.012, y, f"{m['mean']:.3f}", va="center", fontsize=9.5, color=TEXT)
        ax.set_yticks(ys, [VARIANT_LABEL[v] for v in variants])
        _xgrid(ax)
        ax.set_title(title)
        prod = reports["prod"][0]["chunk"][metric]["mean"]
        ax.axvline(prod, color=BASELINE, linewidth=1, linestyle=(0, (3, 3)), zorder=1)
    fig.suptitle("Retrieval ablasyonu — parça düzeyi (63 cevaplanabilir soru, çizgi: %95 güven aralığı)",
                 x=0.01, ha="left", fontsize=13.5, fontweight="bold")
    _finish(fig, out / "01-retrieval-ablasyonu.png",
            "Gri çubuk ve kesikli çizgi: bugünkü uygulama (prod). Pilot altın set, default kasası.")


def chart_by_type(reports, items, out: Path):
    from collections import defaultdict

    def recall5(ranked, relevant):
        rel = {r["anchor"] for r in relevant if r.get("grade", 0) >= 1}
        if not rel:
            return None
        top = [x["anchor"] for x in ranked[:5]]
        return sum(a in rel for a in top) / len(rel)

    golden = {}
    gpath = Path(reports["prod"][0].get("_file", ""))  # not used; relevance comes from items below
    series = {}
    for v in ("prod", "hybrid+rerank"):
        acc = defaultdict(list)
        for it in items[v].values():
            if not it.get("eligible") or it["type"] not in TYPE_LABEL:
                continue
            rel = it.get("relevant") or golden.get(it["id"])
            if rel is None:
                continue
            val = recall5(it["perVariant"][v]["ranked"], rel)
            if val is not None:
                acc[it["type"]].append(val)
        series[v] = acc
    types = [t for t in TYPE_LABEL if series["prod"].get(t)]
    if not types:
        return False
    fig, ax = plt.subplots(figsize=(11, 0.62 * len(types) + 1.4))
    ys = list(range(len(types)))[::-1]
    h = 0.34
    for y, t in zip(ys, types):
        for off, v, color in ((h / 2 + 0.02, "prod", BASELINE), (-(h / 2 + 0.02), "hybrid+rerank", BLUE)):
            vals = series[v][t]
            m = sum(vals) / len(vals)
            ax.barh(y + off, m, height=h, color=color, zorder=2)
            ax.text(m + 0.01, y + off, f"{m:.2f}", va="center", fontsize=9, color=TEXT)
        ax.text(1.005, y, f"n={len(series['prod'][t])}", va="center", fontsize=8.5, color=MUTED,
                transform=ax.get_yaxis_transform())
    ax.set_yticks(ys, [TYPE_LABEL[t] for t in types])
    _xgrid(ax, (0, 1.0))
    ax.legend(handles=[matplotlib.patches.Patch(color=BASELINE, label="prod (bugün)"),
                       matplotlib.patches.Patch(color=BLUE, label="hybrid + reranker")],
              loc="lower left", ncol=2, bbox_to_anchor=(0, 1.0))
    ax.set_title("Soru türüne göre Recall@5 — bugünkü sistem vs hybrid + reranker", pad=30)
    _finish(fig, out / "02-tur-bazinda-recall.png",
            "Pilot; tür başına soru sayısı küçük (n sağda) — farklar yön göstericidir.")
    return True


def chart_threshold(run_with_sweep, out: Path):
    sweep = run_with_sweep["thresholdSweep"]
    xs = [s["threshold"] for s in sweep]
    fig, ax = plt.subplots(figsize=(9.5, 4.8))
    ax.plot(xs, [s["unanswerableEmptyRate"] for s in sweep], color=BLUE, linewidth=2, marker="o",
            markersize=7, label="cevapsız soruda boş sonuç (iyi)", zorder=3)
    ax.plot(xs, [s["answerableFalseEmptyRate"] for s in sweep], color=ORANGE, linewidth=2, marker="s",
            markersize=7, label="cevaplı soruda yanlış-boş (kötü)", zorder=3)
    ax.axvline(0.60, color=BASELINE, linewidth=1.2, linestyle=(0, (3, 3)))
    ax.text(0.602, 0.93, "bugünkü eşik 0,60", color=TEXT_2, fontsize=9.5)
    ax.set_ylim(-0.03, 1.05)
    ax.set_xticks(xs, [f"{x:.2f}".replace(".", ",") for x in xs])
    ax.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0, decimals=0))
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="y", length=0)
    ax.set_xlabel("vektör mesafe eşiği (üstündeki parçalar atılır)")
    ax.legend(loc="center right", bbox_to_anchor=(0.97, 0.55))
    ax.set_title("Mesafe eşiği taraması — retrieval düzeyinde \"bilmiyorum\"")
    _finish(fig, out / "03-esik-taramasi.png",
            "Cevapsız = 3 cevapsız + 4 selamlaşma (n=7), cevaplı n=63. Küçük örneklem; tam sette kalibre edilmeli.")


def chart_reranker_scores(items, out: Path):
    v = "hybrid+rerank"
    if v not in items:
        return False
    ans, unans = [], []
    for it in items[v].values():
        ranked = it["perVariant"][v]["ranked"]
        if not ranked:
            continue
        s = max(ranked[0]["score"], 1e-5)
        (ans if it["answerable"] else unans).append(s)
    fig, ax = plt.subplots(figsize=(10, 3.6))
    import random

    rnd = random.Random(7)
    for y, vals, color, label in ((1, ans, BLUE, f"cevaplanabilir (n={len(ans)})"),
                                  (0, unans, ORANGE, f"cevapsız + selamlaşma (n={len(unans)})")):
        ax.scatter(vals, [y + rnd.uniform(-0.17, 0.17) for _ in vals], s=38, color=color,
                   edgecolors=SURFACE, linewidths=1.5, zorder=3, label=label)
    ax.set_xscale("log")
    ax.set_xlim(1e-5, 1.3)
    ax.axvline(0.05, color=TEXT_2, linewidth=1, linestyle=(0, (3, 3)))
    ax.text(0.055, 1.42, "olası eşik 0,05", color=TEXT_2, fontsize=9.5)
    ax.set_yticks([0, 1], ["cevapsız", "cevaplanabilir"])
    ax.set_ylim(-0.5, 1.6)
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.tick_params(axis="y", length=0)
    ax.set_xlabel("reranker skoru — en iyi aday (log ölçek)")
    ax.legend(loc="upper left", bbox_to_anchor=(0, 1.0))
    ax.set_title("Reranker skoru cevapsız soruları ayırıyor")
    _finish(fig, out / "04-reranker-skor-ayrimi.png",
            "bge-reranker-v2-m3, hybrid adayları. 0,05 eşiği cevapsızların hepsini süzer ama 3 cevaplanabilir soruyu da düşürür.\n"
            "Mesafe eşiği (0,60) cevapsızların hiçbirini süzemiyordu. Eşik tam sette kalibre edilmeli.")
    return True


def chart_generation(gen, out: Path):
    a = gen["aggregates"]
    rows = [
        ("Doğruluk ≥ 4/5", a["correctness"]["shareAtLeast4"]),
        ("Alaka ≥ 4/5", a["relevance"]["shareAtLeast4"]),
        ("Sadakat (faithfulness)", a["hallucination"]["faithfulness"]),
        ("Citation recall", a["citation"]["citationRecall"]),
        ("Anılan başlık kesinliği", a["citation"]["mentionPrecision"]),
        ("Bağlam alakası", a["contextRelevance"]),
        ("Kaynak listesi kesinliği", a["citation"]["sourceListPrecision"]),
    ]
    extra = [
        ("Yanıt dili uyumu", 67 / 69, "67/69"),
        ("\"Bilmiyorum\" deme (cevapsız)", a["abstention"]["abstentionAccuracy"], "0/3"),
    ]
    labels = [r[0] for r in rows] + [e[0] for e in extra]
    fig, ax = plt.subplots(figsize=(11, 0.55 * len(labels) + 1.4))
    ys = list(range(len(labels)))[::-1]
    for y, (label, m) in zip(ys, rows):
        ax.barh(y, m["mean"], height=0.55, color=BLUE, zorder=2)
        ax.plot([m["lo"], m["hi"]], [y, y], color=TEXT, linewidth=1.1, zorder=3)
        ax.text(m["hi"] + 0.012, y, f"%{m['mean'] * 100:.0f}", va="center", fontsize=9.5)
    for y, (label, val, txt) in zip(ys[len(rows):], extra):
        ax.barh(y, max(val, 0.004), height=0.55, color=ORANGE if val < 0.5 else BLUE, zorder=2)
        ax.text(max(val, 0.004) + 0.012, y, txt, va="center", fontsize=9.5)
    ax.set_yticks(ys, labels)
    _xgrid(ax, (0, 1.08))
    ax.set_title("Cevap kalitesi — qwen3:8b, yargıç deepseek-v4-pro (70 soru, çizgi: %95 güven aralığı)")
    _finish(fig, out / "05-uretim-kalitesi.png",
            "Turuncu: sorunlu. Cevapsız soru sayısı pilotta 3 — oran değil yön. Kullanıcı skill'leri bu koşuda kapalıydı.")


def chart_latency(gen, out: Path):
    ttft = [i["timings"]["ttftMs"] / 1000 for i in gen["items"] if i.get("timings", {}).get("ttftMs")]
    total = [i["timings"]["totalMs"] / 1000 for i in gen["items"] if i.get("timings", {}).get("totalMs")]
    p = gen["aggregates"]["performance"]
    fig, axes = plt.subplots(2, 1, figsize=(10, 4.6), gridspec_kw={"hspace": 0.9})
    import random

    rnd = random.Random(3)
    for ax, vals, p50, p95, title, color in (
        (axes[0], ttft, p["ttftP50"] / 1000, p["ttftP95"] / 1000, "İlk token süresi (TTFT)", BLUE),
        (axes[1], total, p["totalMsP50"] / 1000, p["totalMsP95"] / 1000, "Toplam cevap süresi", BLUE),
    ):
        ax.scatter(vals, [rnd.uniform(-0.3, 0.3) for _ in vals], s=30, color=color, edgecolors=SURFACE,
                   linewidths=1.2, zorder=3)
        for q, lbl in ((p50, "P50"), (p95, "P95")):
            ax.axvline(q, color=TEXT_2, linewidth=1, linestyle=(0, (3, 3)))
            ax.text(q, 0.62, f"{lbl} {q:.1f} s".replace(".", ","), color=TEXT_2, fontsize=9, ha="center")
        ax.set_yticks([])
        ax.set_ylim(-0.5, 0.95)
        ax.set_xlim(0, max(vals) * 1.05)
        ax.grid(axis="x", color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        ax.set_xlabel("saniye")
        ax.set_title(title, pad=16)
    fig.suptitle(f"Performans — qwen3:8b, RTX 4050 6 GB · {p['tokPerSecP50']:.1f} tok/s (P50)".replace(".", ","),
                 x=0.01, ha="left", fontsize=13.5, fontweight="bold", y=1.04)
    _finish(fig, out / "06-gecikme.png", "Her nokta bir soru (70). Sohbetteki 4096 token çıktı tavanı bu ölçümde yoktu.")


def _wilson(k: int, n: int, z: float = 1.96):
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def chart_language(out: Path):
    # scripts/eval-response-language.ts — 30 vaka; V0 tek koşu, diğerleri 3 tekrar (2026-09-27).
    rows = [
        ("V0 — bugünkü (\"her zaman Türkçe\")", 17, 30),
        ("V1 — \"son mesajın dilinde cevap ver\"", 68, 90),
        ("V2 — V1 + dil tespiti (güvenilirse)", 73, 90),
        ("V3 — her turda yönerge", 83, 90),
        ("V4 — dar aday kümesi (uygulandı)", 90, 90),
    ]
    fig, ax = plt.subplots(figsize=(10.5, 3.6))
    ys = list(range(len(rows)))[::-1]
    for y, (label, k, n) in zip(ys, rows):
        lo, hi = _wilson(k, n)
        color = BASELINE if label.startswith("V0") else (BLUE if label.startswith("V4") else "#86b6ef")
        ax.barh(y, k / n, height=0.55, color=color, zorder=2)
        ax.plot([lo, hi], [y, y], color=TEXT, linewidth=1.1, zorder=3)
        ax.text(hi + 0.012, y, f"{k}/{n}", va="center", fontsize=9.5)
    ax.set_yticks(ys, [r[0] for r in rows])
    _xgrid(ax, (0, 1.12))
    ax.set_title("Yanıt dili düzeltmesi — doğru dilde cevap oranı (çizgi: Wilson %95)")
    _finish(fig, out / "07-yanit-dili.png",
            "EN/TR/DE bilgi, argo, kısa, yalnız kod, karışık, dil değiştiren takip, selamlaşma. qwen3:8b.")


def main() -> None:
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=str(repo / "data/vaults/default/bench/results"))
    ap.add_argument("--out", default=str(Path.home() / "Desktop" / "RAG-benchmark-grafikleri"))
    ap.add_argument("--generation")
    args = ap.parse_args()
    results, out = Path(args.results), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print(f"çıktı: {out}")
    reports, items, _ = load_retrieval(results)
    # attach golden relevance to retrieval items (the runs store it per item? if not, read golden)
    golden_path = repo / "data/vaults/default/bench/work/golden-pilot.jsonl"
    if golden_path.exists():
        golden = {}
        for line in golden_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                g = json.loads(line)
                golden[g["id"]] = g["relevant"]
        for per in items.values():
            for it in per.values():
                it.setdefault("relevant", golden.get(it["id"]))
    chart_ablation(reports, out)
    chart_by_type(reports, items, out)
    sweep_run = None
    for path in sorted(glob.glob(str(results / "*" / "retrieval.json"))):
        run = json.loads(Path(path).read_text(encoding="utf-8"))
        if run.get("thresholdSweep") and len(run.get("items", [])) >= 20:
            sweep_run = run
    if sweep_run:
        chart_threshold(sweep_run, out)
    chart_reranker_scores(items, out)

    gen_path = args.generation
    if not gen_path:
        judged = sorted(p for p in glob.glob(str(results / "*" / "generation.json"))
                        if json.loads(Path(p).read_text(encoding="utf-8"))["settings"].get("judged"))
        gen_path = judged[-1] if judged else None
    if gen_path:
        gen = json.loads(Path(gen_path).read_text(encoding="utf-8"))
        chart_generation(gen, out)
        chart_latency(gen, out)
    chart_language(out)


if __name__ == "__main__":
    main()
