# -*- coding: utf-8 -*-
"""Tests for formula_crop.py (adaptive3 kırpım geometrisi + docling bağlaması).

    python ingest/formula_crop_test.py

Not part of `npm test`. Sentetik karakter kümeleri (PDF noktası, sol-alt orijin); sayfa görüntüsü
yok (piksel büyütme gerçek GPU koşusunda denenir). Bağlama testi docling'in gerçek sınıfını
sahte `prepare_element` ile sarar: model yüklenmez.
"""
import io
import os
import sys
import types
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import formula_crop as fc  # noqa: E402

PAGE = (600.0, 800.0)
BBOX = (100.0, 500.0, 200.0, 512.0)  # çubuk (kesir çizgisi) satırı, h ~ 10


def run(chars, bbox=BBOX):
    chars = [list(c) for c in chars]
    sb = fc.stock_region(bbox)
    eq = fc.find_eq_number_v2(chars, bbox, sb)
    info = {}
    box = fc.adaptive_box_v3(bbox, chars, PAGE, fc.MARGIN_PT, None, eq, 1.67, info)
    info["eq"] = bool(eq.get("found"))
    return box, info


def word(txt, x, y, h=10.0, w=5.0):
    return [[ch, x + i * w, y, x + (i + 1) * w, y + h] for i, ch in enumerate(txt)]


def own():
    return word("a+b=c", 105, 501)  # bbox içi (merkezler içeride)


def test_never_shrinks():
    box, info = run(own())
    assert box.l <= BBOX[0] and box.r >= BBOX[2] and box.b <= BBOX[1] and box.t >= BBOX[3], box
    assert info["grown"] is False
    # kutunun çok dışında karakter yok -> en çok margin kadar genişler
    assert box.t - BBOX[3] <= fc.MARGIN_PT + 1e-6 and BBOX[0] - box.l <= fc.MARGIN_PT + 1e-6


def test_grows_into_denominator_below():
    # paydalar bbox'ın altında 2 pt boşlukla (< 0.5 h): kutu onları kapsar
    den = word("xy", 130, 488, h=10)  # top=498 < b=500
    box, info = run(own() + den)
    assert info["grown"] is True
    assert box.b <= 488, box  # payda tamamen içeride (+ kenar payı)


def test_grows_into_matrix_columns_left():
    cols = word("1", 70, 501) + word("0", 85, 501)  # solda 15 ve 10 pt, boşluk 15 pt < 2 h = 20
    box, info = run(own() + cols)
    assert info["grown"] is True and box.l <= 70, box


def test_blocks_prose_below():
    prose = word("thisisaproseline", 100, 486, h=10, w=5)  # üst = 496: bbox altı 500, boşluk 4 pt
    box, info = run(own() + prose)
    assert info["grown"] is False, box
    assert box.b >= 496 + 0.5 - 1e-6, box  # kenar payı düzyazının 0.5 pt önünde durur


def test_blocks_eq_number_and_margin_label_right():
    num = word("(5.29)", 215, 501, h=10, w=5)  # boşluk 15 pt < 2 h: engellenmeseydi eklenirdi
    label = word("magnetic", 260, 501)
    box, info = run(own() + num + label)
    assert info["grown"] is False, box
    assert box.r <= 215 - 0.5 + 1e-6, box


def test_prose_does_not_block_math_line_with_greek():
    # "ntcosθt"-gibi matematik satırı düzyazı değil: yan karakter olarak eklenebilir
    side = word("αβ", 215, 501)
    box, info = run(own() + side)
    assert info["grown"] is True and box.r >= 225, box


def test_mode_env():
    saved = os.environ.get("VC_FORMULA_CROP")
    try:
        os.environ.pop("VC_FORMULA_CROP", None)
        assert fc.mode() == "adaptive3"
        os.environ["VC_FORMULA_CROP"] = "stock"
        assert fc.mode() == "stock" and fc.install() is False
    finally:
        if saved is None:
            os.environ.pop("VC_FORMULA_CROP", None)
        else:
            os.environ["VC_FORMULA_CROP"] = saved


def test_install_patches_pipeline_class_and_falls_back():
    from docling.models.stages.code_formula.code_formula_vlm_model import CodeFormulaVlmModel as cls

    saved_pe, saved_inst = cls.prepare_element, fc._INSTALLED[0]
    saved_env = os.environ.pop("VC_FORMULA_CROP", None)
    fc._INSTALLED[0] = False
    fc._WARNED[0] = False
    try:
        calls = []
        sentinel = types.SimpleNamespace(image="stock-image", item=None)

        def fake(self, conv_res, element):
            calls.append(element)
            return sentinel

        cls.prepare_element = fake
        assert fc.install() is True and fc.install() is True  # ikinci kurulum no-op
        assert cls.prepare_element is not fake
        fc.reset_stats()
        buf = io.StringIO()
        # biçimsiz (formül olmayan) öğe: stok sonucu aynen döner, sayaç artmaz
        with redirect_stderr(buf):
            out = cls.prepare_element(object(), types.SimpleNamespace(), types.SimpleNamespace())
        assert out is sentinel and len(calls) == 1 and fc.STATS["cropped"] == 0
        # gerçek bir formül öğesi ama conv_res bozuk -> stoka düşer, bir kez uyarır
        from docling_core.types.doc import DocItemLabel, FormulaItem, ProvenanceItem
        from docling_core.types.doc.base import BoundingBox, CoordOrigin

        item = FormulaItem(
            self_ref="#/texts/0", label=DocItemLabel.FORMULA, text="", orig="",
            prov=[ProvenanceItem(page_no=1, bbox=BoundingBox(l=0, t=0, r=1, b=1, coord_origin=CoordOrigin.TOPLEFT), charspan=(0, 0))],
        )
        with redirect_stderr(buf):
            out = cls.prepare_element(object(), types.SimpleNamespace(), item)
            out = cls.prepare_element(object(), types.SimpleNamespace(), item)
        assert out is sentinel and fc.STATS["fallbacks"] == 2 and fc.STATS["cropped"] == 0
        assert buf.getvalue().count("formula_crop:") == 1, buf.getvalue()
        assert fc.report() == fc.snapshot()
    finally:
        cls.prepare_element = saved_pe
        fc._INSTALLED[0] = saved_inst
        if saved_env is not None:
            os.environ["VC_FORMULA_CROP"] = saved_env
        fc.reset_stats()


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    main()
