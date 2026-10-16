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


def _with_env(**kv):
    saved = {k: os.environ.get(k) for k in kv}
    for k, v in kv.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return saved


def _restore(saved):
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def test_mode_env():
    saved = _with_env(VC_FORMULA_CROP=None, VC_FORMULA_RENDER=None)
    saved_inst = fc._INSTALLED[0]
    try:
        assert fc.mode() == "adaptive3" and fc.render_mode() == "pdfium"
        os.environ["VC_FORMULA_RENDER"] = "docling"
        assert fc.render_mode() == "docling"
        os.environ["VC_FORMULA_CROP"] = "stock"
        fc._INSTALLED[0] = False
        assert fc.mode() == "stock" and fc.install() is False  # stok kırpım + docling çizimi: kurulmaz
        os.environ["VC_FORMULA_RENDER"] = "pdfium"
        assert fc.render_mode() == "pdfium"
    finally:
        _restore(saved)
        fc._INSTALLED[0] = saved_inst
        fc.reset_stats()


def test_stock_crop_with_pdfium_render_installs_and_crops():
    """stock + pdfium: install() artık kurar; gerçek bir PDF'ten stok geometri kırpımı pdfium çiziminden gelir."""
    import tempfile

    import pypdfium2 as pdfium
    from docling.models.stages.code_formula.code_formula_vlm_model import CodeFormulaVlmModel as cls
    from docling_core.types.doc import DocItemLabel, FormulaItem, ProvenanceItem
    from docling_core.types.doc.base import BoundingBox, CoordOrigin
    from PIL import Image

    saved_pe, saved_inst = cls.prepare_element, fc._INSTALLED[0]
    saved = _with_env(VC_FORMULA_CROP="stock", VC_FORMULA_RENDER="pdfium")
    fc._INSTALLED[0] = False
    try:
        with tempfile.TemporaryDirectory() as td:
            pdf = pdfium.PdfDocument.new()
            pdf.new_page(200, 100)
            path = os.path.join(td, "t.pdf")
            pdf.save(path)
            pdf.close()
            sentinel = types.SimpleNamespace(image=Image.new("RGB", (1, 1)), item=None)
            cls.prepare_element = lambda self, conv_res, element: sentinel
            assert fc.install() is True
            fc.reset_stats()
            item = FormulaItem(
                self_ref="#/texts/0", label=DocItemLabel.FORMULA, text="", orig="",
                prov=[ProvenanceItem(page_no=1, bbox=BoundingBox(l=50, b=40, r=100, t=60, coord_origin=CoordOrigin.BOTTOMLEFT), charspan=(0, 0))],
            )
            page = types.SimpleNamespace(page_no=1, size=types.SimpleNamespace(width=200.0, height=100.0))
            conv = types.SimpleNamespace(
                pages=[page], input=types.SimpleNamespace(_backend=types.SimpleNamespace(path_or_stream=path), document_hash="h", file="t.pdf")
            )
            model = types.SimpleNamespace(images_scale=1.67, expansion_factor=0.18)
            out = cls.prepare_element(model, conv, item)
            assert out is sentinel and fc.STATS["cropped"] == 1 and fc.STATS["render"] == 1, fc.snapshot()
            assert fc.STATS["render_fallbacks"] == 0 and fc.STATS["fallbacks"] == 0
            # 50x20 pt kutu, %18 her yönde -> 68x27.2 pt * 1.67 ~ 114x45 px
            assert abs(out.image.width - 68 * 1.67) <= 2 and abs(out.image.height - 27.2 * 1.67) <= 2, out.image.size
            # ikinci çağrı aynı sayfa çizimini önbellekten alır
            before = fc._RENDER["img"]
            cls.prepare_element(model, conv, item)
            assert fc._RENDER["img"] is before and fc.STATS["render"] == 2
            # pdfium başarısız (bozuk dosya yolu): stok kırpım korunur, render_fallbacks sayılır
            conv.input._backend.path_or_stream = path
            fc._RENDER.update(key=None, img=None)
            real = fc._pdfium_page_image
            fc._pdfium_page_image = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
            buf = io.StringIO()
            try:
                with redirect_stderr(buf):
                    out = cls.prepare_element(model, conv, item)
            finally:
                fc._pdfium_page_image = real
            assert out is sentinel and fc.STATS["render_fallbacks"] == 1 and fc.STATS["cropped"] == 2
            assert out.image is not None
            fc._close_pdf()
    finally:
        cls.prepare_element = saved_pe
        fc._INSTALLED[0] = saved_inst
        _restore(saved)
        fc.reset_stats()


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


def _same_segments(chars):
    new, ref = fc._v2_segments(chars), fc._v2_segments_ref(chars)
    assert len(new) == len(ref), (len(new), len(ref))
    for (cs_n, mh_n), (cs_r, mh_r) in zip(new, ref):
        assert [id(c) for c in cs_n] == [id(c) for c in cs_r] and mh_n == mh_r


def test_segments_grid_equals_reference_random():
    """Izgaralı _v2_segments eski sıralı taramayla birebir aynı bileşenleri aynı sırada verir (#82)."""
    import random

    rng = random.Random(7)
    for trial in range(300):
        chars = []
        lines = rng.randint(1, 25)
        for li in range(lines):
            y = rng.uniform(0, 700)
            h = rng.choice([0.0, rng.uniform(2, 14)])
            x = rng.uniform(0, 100)
            for _ in range(rng.randint(1, 40)):
                w = rng.choice([0.0, rng.uniform(1, 8)])
                dy = rng.uniform(-h, h) if rng.random() < 0.2 else 0.0  # üst/alt simge
                hh = h * rng.choice([1.0, 0.6, 1.4])
                chars.append([rng.choice("abcxyz=+()1(7.4)"), x, y + dy, x + w, y + dy + hh])
                x += w + rng.choice([0.0, 0.5, 2.0, rng.uniform(0, 3 * max(h, 1))])
        if trial % 10 == 0 and chars:
            chars.append(list(chars[0]))  # aynı kutu iki kez
        rng.shuffle(chars)
        _same_segments(chars)
    _same_segments([])


def test_segments_bad_boxes_fall_back_to_reference():
    chars = word("abc", 10, 10) + [["x", 30, 20, 25, 18]]  # ters kutu
    _same_segments(chars)
    chars = word("abc", 10, 10) + [["x", float("nan"), 20, 25, 30]]
    new, ref = fc._v2_segments(chars), fc._v2_segments_ref(chars)
    assert len(new) == len(ref)


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    main()
