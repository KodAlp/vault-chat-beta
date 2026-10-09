# -*- coding: utf-8 -*-
"""Tests for formula_fallback.py (geçerlilik denetimi, normalleştirme, tetik, değiştirme).

    python ingest/formula_fallback_test.py

Not part of `npm test`. Gerçek model YÜKLENMEZ: tanıyıcı sahte işlevdir; bağlama testi docling'in
gerçek sınıfını sahte `prepare_element` ile sarar.
"""
import io
import os
import sys
import types
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import formula_fallback as ff  # noqa: E402
from PIL import Image  # noqa: E402
from docling_core.types.doc import BoundingBox, DocItemLabel, DoclingDocument, ProvenanceItem  # noqa: E402
from docling_core.types.doc.base import CoordOrigin  # noqa: E402


def make_doc(texts):
    """Her metin için bir FORMULA öğesi (sayfa 1, i. kutu)."""
    doc = DoclingDocument(name="t")
    items = []
    for i, t in enumerate(texts):
        prov = ProvenanceItem(
            page_no=1,
            bbox=BoundingBox(l=10, t=100 + i * 20, r=50, b=90 + i * 20, coord_origin=CoordOrigin.BOTTOMLEFT),
            charspan=(0, len(t)),
        )
        items.append(doc.add_text(label=DocItemLabel.FORMULA, text=t, prov=prov))
    return doc, items


def fresh(mode="auto"):
    os.environ["VC_FORMULA_FALLBACK"] = mode
    ff.reset_stats()


def store(items):
    for it in items:
        assert ff.record(it, Image.new("RGB", (12, 8), (255, 255, 255)))


def test_check_valid():
    for ok in [
        r"\frac{a}{b}+c^{2}",
        r"\left( \frac{a}{b} \right)",
        r"\left. x \right|_{0}",
        r"\left\{ a \right\}",
        r"\begin{aligned} a &= b \\ c &= d \end{aligned}",
        r"\begin{array}{cc} 1 & 0 \\ 0 & 1 \end{array}",
        r"\begin{pmatrix} a & b \\ c & d \end{pmatrix}",
        r"\mathbf{x} \in \{0, 1\}",
        r"a \& b",
        r"\sum_{\substack{i<n \\ j<m}} a_{ij}",
    ]:
        assert ff.check_latex(ok) is None, ok


def test_check_invalid():
    cases = {
        "": "empty",
        "   ": "empty",
        r"a &= b": "toplevel_align",
        r"a \\ b": "toplevel_align",
        r"\frac{a}{b": "braces",
        r"a}": "braces",
        r"\left( a": "left_right",
        r"a \right)": "left_right",
        r"\begin{aligned} a &= b": "begin_end",
        r"\begin{aligned} a \end{array}": "begin_end",
        r"a \end{aligned}": "begin_end",
        r"a \intertext{and} b": "unsupported",
        r"a \eqno{(1)}": "unsupported",
        r"a \label{x}": "unsupported",
        r"{ \left( } \right)": "braces",
    }
    for src, why in cases.items():
        assert ff.check_latex(src) == why, (src, ff.check_latex(src))


def test_escaped_braces_ignored():
    assert ff.check_latex(r"\{ a") is None
    assert ff.check_latex(r"a \}") is None


def test_normalize():
    assert ff.normalize_mineru("\\[\n x^2 + y^2 \\tag{5.26}\n\\]") == "x^2 + y^2"
    assert ff.normalize_mineru(r"\[ a = b \tag*{(3){x}} \]") == "a = b"
    assert ff.normalize_mineru("$$ a $$") == "a"
    assert ff.normalize_mineru("\\[\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\]") == (
        r"\begin{aligned} a &= b \\ c &= d \end{aligned}"
    )
    assert ff.normalize_mineru(None) == ""
    assert ff.normalize_mineru(r"\[ a \\ \tag{1} \]") == "a"


def test_mode_parsing():
    saved = os.environ.get("VC_FORMULA_FALLBACK")
    try:
        os.environ.pop("VC_FORMULA_FALLBACK", None)
        assert ff.mode() == "auto"
        for v, want in [("off", "off"), ("0", "off"), ("ALL", "all"), ("auto", "auto"), ("garip", "auto")]:
            os.environ["VC_FORMULA_FALLBACK"] = v
            assert ff.mode() == want, v
    finally:
        if saved is None:
            os.environ.pop("VC_FORMULA_FALLBACK", None)
        else:
            os.environ["VC_FORMULA_FALLBACK"] = saved


def test_flag_reason():
    assert ff.flag_reason("") == "empty"
    assert ff.flag_reason(r"\frac{a}{b}") is None
    assert ff.flag_reason(r"a & b") == "toplevel_align"
    assert ff.flag_reason("x " + r"\quad a " * 120) == "loop"


def test_apply_replaces_flagged_only():
    fresh("auto")
    doc, items = make_doc([r"\frac{a}{b}", r"a & b", "", r"\frac{x}{y"])
    store(items)
    calls = []

    def fake(images):
        calls.append(len(images))
        return ["\\[\n a = b \\tag{1}\n\\]", "\\[ q \\]", "\\[ \\frac{x}{y} \\]"][: len(images)]

    st = ff.apply(doc, recognizer=fake)
    assert [i.text for i in items] == [r"\frac{a}{b}", "a = b", "q", r"\frac{x}{y}"]
    assert calls == [3] and st["flagged"] == 3 and st["replaced"] == 3 and st["kept"] == 0
    assert st["reasons"] == {"toplevel_align": 1, "empty": 1, "braces": 1}
    assert ff._CROPS == {}  # bellek bırakıldı


def test_apply_all_mode_prefers_mineru_when_valid():
    fresh("all")
    doc, items = make_doc([r"\frac{a}{b}", r"c^{2}"])
    store(items)
    st = ff.apply(doc, recognizer=lambda ims: ["\\[ A \\]", "\\[ \\frac{ \\]"])
    assert items[0].text == "A"
    assert items[1].text == "c^{2}"  # MinerU çıktısı geçersiz -> CodeFormula kalır
    assert st["flagged"] == 2 and st["replaced"] == 1 and st["kept"] == 1 and st["reasons"] == {"all": 2}


def test_apply_loop_fixed_removes_loop_warning():
    import postprocess

    fresh("auto")
    looped = r"a = b " + r"\quad c " * 150
    doc, items = make_doc([looped])
    store(items)
    assert postprocess.find_degenerate_run(items[0].text) != -1
    st = ff.apply(doc, recognizer=lambda ims: ["\\[ a = b \\quad c \\]"])
    assert st["reasons"] == {"loop": 1} and st["replaced"] == 1
    assert postprocess.find_degenerate_run(items[0].text) == -1


def test_apply_rejects_loop_output_from_mineru():
    fresh("auto")
    doc, items = make_doc([""])
    store(items)
    st = ff.apply(doc, recognizer=lambda ims: ["\\[ " + r"\quad c " * 150 + " \\]"])
    assert items[0].text == "" and st["kept"] == 1 and st["replaced"] == 0


def test_apply_no_image_counts_and_keeps():
    fresh("auto")
    doc, items = make_doc(["", r"a & b"])
    ff.record(items[0], Image.new("RGB", (4, 4)))
    st = ff.apply(doc, recognizer=lambda ims: ["x"])
    assert items[0].text == "x" and items[1].text == "a & b"
    assert st["no_image"] == 1 and st["kept"] == 1 and st["replaced"] == 1


def test_apply_exception_keeps_original():
    fresh("auto")
    doc, items = make_doc(["", r"a & b"])
    store(items)

    def boom(images):
        raise RuntimeError("OOM")

    buf = io.StringIO()
    with redirect_stderr(buf):
        st = ff.apply(doc, recognizer=boom)
    assert [i.text for i in items] == ["", "a & b"]
    assert st["errors"] == 1 and st["replaced"] == 0 and st["kept"] == 2
    assert buf.getvalue().count("formula_fallback:") == 1, buf.getvalue()


def test_apply_wrong_output_count_keeps():
    fresh("auto")
    doc, items = make_doc(["", ""])
    store(items)
    with redirect_stderr(io.StringIO()):
        ff.apply(doc, recognizer=lambda ims: ["x"])
    assert [i.text for i in items] == ["", ""]


def test_apply_no_cuda_skips():
    fresh("auto")
    doc, items = make_doc(["", "ok"])
    store(items)
    st = ff.apply(doc, has_cuda=lambda: False)  # gerçek model yüklenmemeli
    assert st["skipped_no_cuda"] == 1 and st["kept"] == 1 and items[0].text == ""


def test_apply_off_and_no_flags():
    fresh("off")
    doc, items = make_doc([""])
    assert ff.apply(doc, recognizer=lambda ims: ["x"]) is None and items[0].text == ""
    assert ff.report() is None
    fresh("auto")
    doc, items = make_doc([r"\frac{a}{b}"])
    called = []
    st = ff.apply(doc, recognizer=lambda ims: called.append(1) or [])
    assert not called and st["flagged"] == 0


def test_apply_session_loaded_and_closed():
    fresh("auto")
    doc, items = make_doc([""])
    store(items)
    events = []

    class Fake:
        def load(self):
            events.append("load")

        def recognize(self, ims):
            events.append("run")
            return ["z"]

        def close(self):
            events.append("close")

    saved = ff._open_session
    ff._open_session = lambda: Fake()
    try:
        ff.apply(doc, has_cuda=lambda: True)
    finally:
        ff._open_session = saved
    assert events == ["load", "run", "close"] and items[0].text == "z"


def test_apply_session_closed_on_failure():
    fresh("auto")
    doc, items = make_doc([""])
    store(items)
    events = []

    class Fake:
        def load(self):
            raise RuntimeError("yüklenemedi")

        def close(self):
            events.append("close")

    saved = ff._open_session
    ff._open_session = lambda: Fake()
    try:
        with redirect_stderr(io.StringIO()):
            ff.apply(doc, has_cuda=lambda: True)
    finally:
        ff._open_session = saved
    assert events == ["close"] and items[0].text == "" and ff.STATS["errors"] == 1


def test_store_is_bounded():
    fresh("auto")
    doc, items = make_doc(["a", "b"])
    saved = ff.MAX_STORE_BYTES
    ff.MAX_STORE_BYTES = 1
    try:
        assert ff.record(items[0], Image.new("RGB", (12, 8))) is False
    finally:
        ff.MAX_STORE_BYTES = saved


def test_install_records_crop_image():
    from docling.models.stages.code_formula.code_formula_vlm_model import CodeFormulaVlmModel as cls

    fresh("auto")
    doc, items = make_doc(["x"])
    saved_pe, saved_inst = cls.prepare_element, ff._INSTALLED[0]
    img = Image.new("RGB", (9, 5), (0, 0, 0))
    sentinel = types.SimpleNamespace(item=items[0], image=img)
    try:
        cls.prepare_element = lambda self, conv_res, element: sentinel
        ff._INSTALLED[0] = False
        assert ff.install() is True
        out = cls.prepare_element(object(), types.SimpleNamespace(), items[0])
        assert out is sentinel and len(ff._CROPS) == 1
        stored = Image.open(io.BytesIO(next(iter(ff._CROPS.values()))))
        assert stored.size == (9, 5)
        os.environ["VC_FORMULA_FALLBACK"] = "off"
        ff._INSTALLED[0] = False
        assert ff.install() is False
    finally:
        cls.prepare_element = saved_pe
        ff._INSTALLED[0] = saved_inst
        fresh("auto")


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    main()
