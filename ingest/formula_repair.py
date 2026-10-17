# -*- coding: utf-8 -*-
"""Tek bir formülü, saklanan özgün PDF'ten yeniden okur (belgeyi yeniden dönüştürmeden).

Uygulamadaki "yeniden oku" düğmesi için komut satırı:

    python ingest/formula_repair.py --pdf <yol> --page <N, 1 tabanlı> [--bbox l,b,r,t]
        [--crop <saklanan kırpım png>] [--previous-b64 <vc:formul-latex'in base64url LaTeX'i>]
        [--debug-dir <klasör>]

stdout: tam olarak bir JSON satırı (UTF-8); stderr: yalnız ilerleme/günlük.
  Başarı: {"ok": true, "page": N, "bbox": [l,b,r,t] | null, "bbox_source": "marker" | "match" | "none",
           "candidates": [{"latex": "...", "source": "mineru:adaptive3", "katex_ok": true | false | null}]}
  Hata:   {"ok": false, "code": "NO_CUDA" | "PDF_OPEN_FAILED" | "PAGE_OUT_OF_RANGE" | "NO_BOX" |
           "MODEL_MISSING" | "FAILED", "detail": "..."} ve çıkış kodu 1.

Akış:
  1. Kutu: --bbox verilmişse ("marker"; PDF noktası, sol-alt orijin, `vc:formul-gorsel ... k=` ile aynı).
     Yoksa --crop saklanan kırpımın sayfadaki yeri çok ölçekli gri-ton şablon eşlemesiyle bulunur ("match";
     kırpım kenar payı içerdiğinden kutu docling kutusundan biraz büyüktür). İkisi de yoksa "none".
  2. Görüntü varyantları: saklanan kırpım (mineru:stored); kutu biliniyorsa formula_crop.crop_formula
     (mineru:adaptive3), stok genişletme (mineru:stock) ve kutu + birkaç pt pay (mineru:tight).
  3. MinerU yalnız GPU'da çalışır (formula_fallback ile aynı); tek MineruSession, tek toplu çalıştırma.
  4. Her çıktı normalize_mineru + notta görüneceği hâle (formula_fallback.note_blocks) getirilir, KaTeX ile
     sınanır; "previous" (önceki en iyi deneme) de aynı işlemden geçer. Boş ve döngülüler atılır, aynı LaTeX
     tek kez (öncelik sırasındaki ilk kaynak) tutulur. Sıra: katex_ok true önce; sonra adaptive3, stored,
     stock, tight, previous.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

RENDER_SCALE = 1.67  # formula_crop.IMAGES_SCALE: ardışık hat kırpımları bu ölçekte çizer
MATCH_MIN_SCORE = 0.8
# Saklanan kırpımın sayfa çiziminden (RENDER_SCALE) göreli ölçek aralığı: kırpım ~1-3x (72 dpi) çizilmiş olabilir.
MATCH_FACTORS = tuple(round(0.4 * (1.04**i), 4) for i in range(0, 38))  # 0.40 .. ~1.55
TIGHT_MARGIN_PT = 4.0
SOURCE_PRIORITY = ["mineru:adaptive3", "mineru:stored", "mineru:stock", "mineru:tight", "previous"]


class RepairError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def log(msg: str) -> None:
    print(f"formula_repair: {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- saf yardımcılar
def parse_bbox(s: str) -> tuple[float, float, float, float]:
    """"l,b,r,t" (PDF noktası, sol-alt orijin) -> (l, b, r, t); geçersizse ValueError."""
    parts = [p for p in str(s).replace(" ", "").split(",")]
    if len(parts) != 4:
        raise ValueError(f"kutu 4 sayı olmalı (l,b,r,t): {s!r}")
    l, b, r, t = (float(p) for p in parts)
    if not all(v == v and abs(v) < 1e7 for v in (l, b, r, t)):
        raise ValueError(f"geçersiz kutu: {s!r}")
    if r <= l or t <= b:
        raise ValueError(f"kutu boş/ters (r>l ve t>b olmalı): {s!r}")
    return l, b, r, t


def decode_previous(b64: str | None) -> str | None:
    """vc:formul-latex içindeki base64url LaTeX'i çözer; bozuksa None."""
    if not b64:
        return None
    s = b64.strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+=*", s):
        return None
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode("utf-8")
    except Exception:  # noqa: BLE001
        return None


def locate_crop(page_gray, crop_gray, render_scale: float, factors=MATCH_FACTORS, min_score: float = MATCH_MIN_SCORE):
    """Saklanan kırpımı sayfa çiziminde arar. page_gray / crop_gray: uint8 gri numpy dizileri; page_gray
    `render_scale` ile çizilmiş sayfa. Kırpım her `factor` ile yeniden boyutlandırılıp TM_CCOEFF_NORMED ile
    eşlenir. Dönüş: (skor, (l, b, r, t) PDF noktası sol-alt orijin | None, ölçek faktörü); skor < min_score ise
    kutu None (en iyi skor yine de döner)."""
    import cv2

    ph, pw = page_gray.shape[:2]
    best = (-1.0, None, None)

    def attempt(f):
        nonlocal best
        w = int(round(crop_gray.shape[1] * f))
        h = int(round(crop_gray.shape[0] * f))
        if w < 8 or h < 8 or w > pw or h > ph:
            return
        tpl = cv2.resize(crop_gray, (w, h), interpolation=cv2.INTER_AREA if f < 1 else cv2.INTER_CUBIC)
        if tpl.std() < 1.0:  # düz renk kırpım: eşleme anlamsız
            return
        res = cv2.matchTemplate(page_gray, tpl, cv2.TM_CCOEFF_NORMED)
        _, score, _, loc = cv2.minMaxLoc(res)
        if score > best[0]:
            best = (float(score), (loc[0], loc[1], w, h), f)

    for f in factors:  # kaba tarama (%4 adım)
        attempt(f)
    if best[2] is not None:  # ince tarama: en iyi faktörün ±%3,2 çevresi, %0,4 adımla
        f0 = best[2]
        for i in range(-8, 9):
            attempt(round(f0 * (1 + 0.004 * i), 5))
    score, rect, f = best
    if rect is None or score < min_score:
        return score, None, f
    x, y, w, h = rect
    H = ph / render_scale
    box = (x / render_scale, H - (y + h) / render_scale, (x + w) / render_scale, H - y / render_scale)
    return score, tuple(round(v, 2) for v in box), f


def tight_box_px(bbox, scale: float, page_h_pt: float, size: tuple[int, int], margin: float = TIGHT_MARGIN_PT):
    """bbox (sol-alt orijin, PDF noktası) + margin -> piksel dikdörtgeni (sol, üst, sağ, alt), görüntüye kırpılmış."""
    l, b, r, t = bbox
    w, h = size
    x0 = max(0, int((l - margin) * scale))
    x1 = min(w, int(round((r + margin) * scale)))
    y0 = max(0, int((page_h_pt - (t + margin)) * scale))
    y1 = min(h, int(round((page_h_pt - (b - margin)) * scale)))
    return x0, y0, x1, y1


def note_form(raw: Any) -> tuple[str, list[str]]:
    """MinerU ham çıktısı -> (aday LaTeX, KaTeX'e sınanacak gövdeler). normalize_mineru sonrası notta
    görünecek hâl (formula_fallback.note_blocks); tek gövde çıkarsa o aday olur, birden çok (kaçak düzyazı
    bloktan ayrıldı) ya da hiç yoksa normalleştirilmiş metin aday kalır ve tüm gövdeler sınanır."""
    import formula_fallback as ff

    norm = ff.normalize_mineru(raw)
    if not norm.strip() or ff._has_loop(norm):
        return "", []
    bodies = [b.strip() for b in ff.note_blocks(norm)]
    bodies = [b for b in bodies if b]
    if len(bodies) == 1:
        return bodies[0], bodies
    return norm, bodies or [norm]


def build_candidates(
    outputs: list[tuple[str, Any]],
    katex: Callable[[list[str]], tuple[list[bool] | None, str]] | None = None,
) -> list[dict]:
    """outputs: [(kaynak, ham LaTeX)]. Boş/döngülüleri atar, aynı LaTeX'i (öncelik sırasındaki ilk kaynak)
    tekilleştirir, KaTeX ile sınar (katex_ok: true/false/null) ve sıralar: katex_ok true önce, sonra
    SOURCE_PRIORITY."""
    import formula_fallback as ff

    rank = {s: i for i, s in enumerate(SOURCE_PRIORITY)}
    ordered = sorted(outputs, key=lambda o: rank.get(o[0], len(rank)))
    seen: set[str] = set()
    items: list[tuple[str, str, list[str]]] = []
    for source, raw in ordered:
        latex, bodies = note_form(raw)
        if not latex or latex in seen:
            continue
        seen.add(latex)
        items.append((source, latex, bodies))
    flat = [b for _, _, bodies in items for b in bodies]
    valid, _src = (katex or ff.katex_batch)(flat) if flat else ([], "node")
    cands = []
    pos = 0
    for source, latex, bodies in items:
        if valid is None:
            ok = None
        else:
            ok = all(valid[pos : pos + len(bodies)])
        pos += len(bodies)
        cands.append({"latex": latex, "source": source, "katex_ok": ok})
    cands.sort(key=lambda c: (0 if c["katex_ok"] is True else 1, rank.get(c["source"], len(rank))))
    return cands


# --------------------------------------------------------------------------- PDF ve görüntüler
def open_pdf_page_count(pdf: str) -> int:
    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(pdf)
    except Exception as err:  # noqa: BLE001
        raise RepairError("PDF_OPEN_FAILED", str(err)) from err
    try:
        return len(doc)
    finally:
        doc.close()


def _to_gray(img):
    import cv2
    import numpy as np

    a = np.asarray(img.convert("RGB"))
    return cv2.cvtColor(a, cv2.COLOR_RGB2GRAY)


def find_box(pdf: str, page: int, bbox_arg, crop_img, page_img, debug: dict) -> tuple[tuple | None, str]:
    """Kutu ve kaynağı: ("marker" | "match" | "none")."""
    if bbox_arg is not None:
        return bbox_arg, "marker"
    if crop_img is None:
        return None, "none"
    score, box, factor = locate_crop(_to_gray(page_img), _to_gray(crop_img), RENDER_SCALE)
    debug["match_score"] = round(score, 4)
    debug["match_factor"] = factor
    log(f"şablon eşleme: skor {score:.3f}, ölçek faktörü {factor}, kutu {box}")
    if box is None:
        return None, "none"
    return box, "match"


def make_variants(pdf: str, page: int, box, crop_img, page_img) -> list[tuple[str, Any]]:
    """[(kaynak, PIL görüntü)]. Kırpma geometrisi formula_crop'tan yeniden kullanılır."""
    import formula_crop as fc

    out: list[tuple[str, Any]] = []
    if crop_img is not None:
        out.append(("mineru:stored", crop_img.convert("RGB")))
    if box is None:
        return out
    W, H = page_img.width / RENDER_SCALE, page_img.height / RENDER_SCALE
    S = RENDER_SCALE
    try:
        pc = fc.extract_page_chars(pdf, page, pdf)
        if pc is None or pc["rotation"] or not pc["chars"]:
            raise RuntimeError("sayfa karakterleri yok/döndürülmüş sayfa")
        img, _info = fc.crop_formula(page_img, box, pc["chars"], (W, H), S)
        if img.width >= 2 and img.height >= 2:
            out.append(("mineru:adaptive3", img))
    except Exception as err:  # noqa: BLE001
        log(f"adaptive3 kırpımı üretilemedi ({err})")
    try:
        l, b, r, t = fc.stock_region(box)
        sb = (max(0.0, l), max(0.0, b), min(W, r), min(H, t))
        x0, y0, x1, y1 = tight_box_px(sb, S, H, page_img.size, margin=0.0)
        if x1 - x0 >= 2 and y1 - y0 >= 2:
            out.append(("mineru:stock", page_img.crop((x0, y0, x1, y1))))
    except Exception as err:  # noqa: BLE001
        log(f"stok kırpım üretilemedi ({err})")
    x0, y0, x1, y1 = tight_box_px(box, S, H, page_img.size)
    if x1 - x0 >= 2 and y1 - y0 >= 2:
        out.append(("mineru:tight", page_img.crop((x0, y0, x1, y1))))
    return out


# --------------------------------------------------------------------------- ana akış
def repair(args, recognizer: Callable[[list], list] | None = None, has_cuda: Callable[[], bool] | None = None) -> dict:
    import formula_crop as fc
    import formula_fallback as ff
    from PIL import Image

    t0 = time.time()
    pdf = os.path.abspath(args.pdf)
    n_pages = open_pdf_page_count(pdf)
    if not (1 <= args.page <= n_pages):
        raise RepairError("PAGE_OUT_OF_RANGE", f"sayfa {args.page}, belgede {n_pages} sayfa var")
    bbox_arg = parse_bbox(args.bbox) if args.bbox else None
    crop_img = None
    if args.crop:
        try:
            crop_img = Image.open(args.crop)
            crop_img.load()
        except Exception as err:  # noqa: BLE001
            log(f"kırpım okunamadı ({err}); yok sayılıyor")
            crop_img = None
    if bbox_arg is None and crop_img is None:
        raise RepairError("NO_BOX", "ne --bbox ne okunabilir --crop verildi")

    debug: dict = {}
    try:
        page_img = fc._pdfium_page_image(pdf, pdf, args.page, RENDER_SCALE)
        box, source = find_box(pdf, args.page, bbox_arg, crop_img, page_img, debug)
        if box is None and crop_img is None:
            raise RepairError("NO_BOX", "kutu yok")
        variants = make_variants(pdf, args.page, box, crop_img, page_img)
    except RepairError:
        raise
    except Exception as err:  # noqa: BLE001
        raise RepairError("FAILED", f"görüntü hazırlanamadı: {err}") from err
    finally:
        fc._close_pdf()
    if not variants:
        raise RepairError("NO_BOX", "kutu bulunamadı ve kullanılabilir kırpım yok")
    log(f"{len(variants)} varyant: {[s for s, _ in variants]} (kutu kaynağı: {source})")

    if args.debug_dir:
        d = Path(args.debug_dir)
        d.mkdir(parents=True, exist_ok=True)
        for src, im in variants:
            im.save(d / f"{src.split(':')[-1]}.png")
        page_img.save(d / "page.png")

    if recognizer is None:
        if not (has_cuda or ff._cuda_available)():
            raise RepairError("NO_CUDA", "MinerU yalnız GPU'da çalışır (CUDA bulunamadı)")
        session = ff._open_session()
        try:
            try:
                session.load()
            except OSError as err:
                raise RepairError("MODEL_MISSING", f"MinerU modeli yerel önbellekte yok/yüklenemedi: {err}") from err
            except Exception as err:  # noqa: BLE001
                if "out of memory" in str(err).lower():
                    raise RepairError("FAILED", f"GPU belleği yetmedi (model yüklenirken): {err}") from err
                raise RepairError("FAILED", f"MinerU yüklenemedi: {err}") from err
            try:
                outs = session.recognize([im for _, im in variants])
            except Exception as err:  # noqa: BLE001
                raise RepairError("FAILED", f"MinerU çalışmadı: {err}") from err
            try:
                import torch

                debug["peak_vram_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
            except Exception:  # noqa: BLE001
                pass
        finally:
            session.close()
    else:
        outs = recognizer([im for _, im in variants])

    outputs: list[tuple[str, Any]] = [(src, o) for (src, _), o in zip(variants, outs)]
    prev = decode_previous(args.previous_b64)
    if args.previous_b64 and prev is None:
        log("--previous-b64 çözülemedi; yok sayılıyor")
    if prev:
        outputs.append(("previous", prev))
    cands = build_candidates(outputs)
    debug["seconds"] = round(time.time() - t0, 1)
    log(f"bitti: {len(cands)} aday, {debug}")
    return {
        "ok": True,
        "page": args.page,
        "bbox": list(box) if box else None,
        "bbox_source": source,
        "candidates": cands,
    }


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Tek formülü özgün PDF'ten yeniden okur.")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--page", type=int, required=True, help="1 tabanlı sayfa")
    ap.add_argument("--bbox", help="l,b,r,t (PDF noktası, sol-alt orijin)")
    ap.add_argument("--crop", help="saklanan kırpım PNG'si")
    ap.add_argument("--previous-b64", dest="previous_b64", help="vc:formul-latex base64url LaTeX")
    ap.add_argument("--debug-dir", dest="debug_dir", help="varyant kırpımları buraya yazılır")
    return ap.parse_args(argv)


def emit(obj: dict, stream) -> None:
    stream.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
    stream.flush()


def main(argv=None) -> int:
    out = sys.stdout.buffer
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    sys.stdout = sys.stderr  # kütüphane yazdırmaları stdout'taki tek JSON satırını bozmasın
    try:
        args = parse_args(argv)
    except SystemExit as e:
        emit({"ok": False, "code": "FAILED", "detail": "geçersiz argüman"}, out)
        return 1 if e.code else 0
    try:
        if args.bbox:
            try:
                parse_bbox(args.bbox)
            except ValueError as err:
                raise RepairError("FAILED", str(err)) from err
        res = repair(args)
        emit(res, out)
        return 0
    except RepairError as err:
        emit({"ok": False, "code": err.code, "detail": err.detail}, out)
        return 1
    except Exception as err:  # noqa: BLE001
        emit({"ok": False, "code": "FAILED", "detail": f"{type(err).__name__}: {err}"}, out)
        return 1


if __name__ == "__main__":
    sys.exit(main())
