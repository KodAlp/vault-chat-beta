# -*- coding: utf-8 -*-
"""Tests for formula_fallback.py (geçerlilik denetimi, normalleştirme, tetik, değiştirme).

    python ingest/formula_fallback_test.py

Not part of `npm test`. Gerçek model YÜKLENMEZ: tanıyıcı sahte işlevdir; bağlama testi docling'in
gerçek sınıfını sahte `prepare_element` ile sarar.
"""
import io
import os
import shutil
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


def fresh(mode="auto", image="0"):
    """Eski testler görsel adımını kapalı çalıştırır (gerçek node çağrılmasın); görsel testleri image="1" ister."""
    os.environ["VC_FORMULA_FALLBACK"] = mode
    os.environ["VC_FORMULA_IMAGE"] = image
    ff.reset_stats()
    ff.reset_images()


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


LOOP = "E = mc^2 + " + "a " * 150


def fake_katex(calls=None, source="node"):
    """KaTeX yerine: gövdesinde BAD geçen formül derlenmez."""

    def run(bodies):
        if calls is not None:
            calls.append(list(bodies))
        return [("BAD" not in b) for b in bodies], source

    return run


def test_note_blocks_apply_note_repairs():
    # postprocess'in notta yapacağı düzeltmeler KaTeX'ten ÖNCE uygulanır: hbar üst simgesi, üst düzey &
    assert ff.note_blocks(r"\hbar { ^ } { 2 } p") == [r"\hbar ^ { 2 } p"]
    (body,) = ff.note_blocks(r"a & = b \\ c & = d")
    assert body.startswith(r"\begin{aligned}") and body.endswith(r"\end{aligned}")
    assert ff.note_blocks(r"\frac{a}{b}") == [r"\frac{a}{b}"]


def test_find_fatal_reasons_and_single_batch():
    fresh("auto", "1")
    calls = []
    reasons, src = ff.find_fatal(["", LOOP, r"\frac{a}{b}", "BAD x"], fake_katex(calls))
    assert reasons == ["empty", "loop", None, "katex"] and src == "node"
    assert len(calls) == 1 and calls[0] == [r"\frac{a}{b}", "BAD x"]  # tek çağrı, boş/döngülü gönderilmez
    # node yoksa sezgisel check_latex
    reasons, src = ff.find_fatal([r"\frac{a}{b}", r"\frac{a}{b"], lambda b: (None, "heuristic"))
    assert reasons == [None, "heuristic"] and src == "heuristic"


def test_apply_marks_fatal_with_crop():
    fresh("auto", "1")
    doc, items = make_doc([r"\frac{a}{b}", "BAD one", "BAD two", LOOP])
    store([items[0], items[1], items[3]])  # [2]'nin kırpımı yok
    calls = []
    st = ff.apply(doc, recognizer=lambda imgs: [LOOP] * len(imgs), katex=fake_katex(calls))
    assert items[0].text == r"\frac{a}{b}" and items[2].text == "BAD two"
    assert items[1].text == "<!-- vc:fimg 0 -->" and items[3].text == "<!-- vc:fimg 1 -->"
    assert st["fatal"] == 3 and st["fatal_images"] == 2 and st["katex_check"] == "node"
    assert len(calls) <= 3  # toplu çağrılar: ön tarama, MinerU kabulü, son sınama — formül başına değil
    info = ff.FATAL_IMAGES[0]
    import hashlib

    assert info["sha"] == hashlib.sha256(info["png"]).hexdigest()[:16] and info["page"] == 1
    assert info["latex"] == "BAD one"
    assert ff.FATAL_IMAGES[1]["latex"] == "E = mc^2 +"  # döngü kuyruğu kesildi
    md = doc.export_to_markdown()
    assert "$$<!-- vc:fimg 0 -->$$" in md and "BAD one" not in md
    assert ff._CROPS == {}


def test_apply_katex_rejected_goes_to_mineru_first():
    # Sezgisel sınamayı geçen ("BAD one" yapısal olarak geçerli) ama KaTeX'in reddettiği formül önce MinerU'ya
    # gider; MinerU'nun KaTeX'e uyan çıktısı kabul edilir, görsele düşmez.
    fresh("auto", "1")
    doc, items = make_doc(["BAD one", r"\frac{a}{b}"])
    store(items)
    seen = []

    def rec(imgs):
        seen.append(len(imgs))
        return ["x + y"] * len(imgs)

    st = ff.apply(doc, recognizer=rec, katex=fake_katex())
    assert seen == [1] and st["reasons"].get("katex") == 1
    assert items[0].text == "x + y" and items[1].text == r"\frac{a}{b}"
    assert st["replaced"] == 1 and st["fatal"] == 0


def test_apply_mineru_output_must_pass_katex():
    fresh("auto", "1")
    doc, items = make_doc(["BAD one"])
    store(items)
    st = ff.apply(doc, recognizer=lambda imgs: ["BAD two"] * len(imgs), katex=fake_katex())
    assert st["replaced"] == 0 and st["kept"] == 1 and st["fatal_images"] == 1
    assert ff.FATAL_IMAGES[0]["latex"] == "BAD one"  # en iyi deneme CodeFormula'nınki kalır


def test_apply_fatal_runs_without_flagged_and_after_mineru_failure():
    # MinerU hiç çalışmasa da (CUDA yok) okunamayan formül görsele çevrilir
    fresh("auto", "1")
    doc, items = make_doc([r"\frac{x}{y"])
    store(items)
    st = ff.apply(doc, has_cuda=lambda: False, katex=lambda b: ([False] * len(b), "node"))
    assert st["skipped_no_cuda"] == 1 and st["fatal_images"] == 1 and items[0].text == "<!-- vc:fimg 0 -->"
    fresh("auto", "1")
    doc, items = make_doc([r"\frac{x}{y", "BAD z"])
    store(items)

    def boom(imgs):
        raise RuntimeError("boom")

    st = ff.apply(doc, recognizer=boom, katex=lambda b: ([False] * len(b), "node"))
    assert st["errors"] == 1 and st["fatal_images"] == 2 and all(i.text.startswith("<!-- vc:fimg") for i in items)


def test_image_mode_off_keeps_text():
    fresh("auto", "0")
    doc, items = make_doc(["BAD one"])
    store(items)
    called = []
    st = ff.apply(doc, recognizer=lambda i: [], katex=fake_katex(called))
    # KaTeX ön taraması MinerU'ya yönlendirme içindir (görsel kipinden bağımsız); görsel yer tutucusu yok
    assert items[0].text == "BAD one" and st["fatal"] == 0 and st["fatal_images"] == 0
    assert ff.image_mode() is False
    os.environ["VC_FORMULA_IMAGE"] = "1"
    assert ff.image_mode() is True
    os.environ["VC_FORMULA_IMAGE"] = "0"


def test_mode_off_does_nothing():
    fresh("off", "1")
    doc, items = make_doc(["BAD one"])
    assert ff.apply(doc, katex=fake_katex()) is None and items[0].text == "BAD one"
    fresh("auto")


def test_resolve_markers_writes_image_and_block():
    import tempfile
    from postprocess import postprocess

    fresh("auto", "1")
    doc, items = make_doc(["ok", LOOP])
    store(items)
    ff.apply(doc, recognizer=lambda imgs: [LOOP] * len(imgs), katex=fake_katex())
    md = "# Başlık\n\n" + doc.export_to_markdown() + "\n\nSon paragraf.\n"
    text, _fm = postprocess(md, title_fallback="t", converted_by="docling", needs_review=False)
    assert "<!-- vc:fimg 0 -->" in text  # postprocess yer tutucuya dokunmaz
    with tempfile.TemporaryDirectory() as d:
        out, names = ff.resolve_markers(text, Path(d) / "images")
        sha = ff.FATAL_IMAGES[0]["sha"]
        assert names == [f"{sha}.png"]
        assert (Path(d) / "images" / f"{sha}.png").read_bytes() == ff.FATAL_IMAGES[0]["png"]
    want = (
        f"![Okunamayan formül — s. 1](images/{sha}.png)\n<!-- vc:formul-gorsel {sha} s.1 -->\n\n"
        "```latex\nE = mc^2 +\n```"
    )
    assert want in out and "$$$$" not in out and "$$ok$$" in out and "vc:fimg" not in out and "a a a" not in out
    assert "\n\n\n" not in out and out.rstrip().endswith("Son paragraf.")
    # görsel kapalıysa (--no-images): dosya yok, uyarı + LaTeX
    out2, names2 = ff.resolve_markers(text, None)
    assert names2 == [] and "Okunamayan formül (s. 1)" in out2 and "![" not in out2 and "```latex" in out2
    # satır içi ($..$) ve çıplak yer tutucu, bilinmeyen kimlik
    out3, _ = ff.resolve_markers("a $<!-- vc:fimg 0 -->$ b <!-- vc:fimg 9 -->", None)
    assert "vc:fimg" not in out3 and "$" not in out3
    # bir kodlama çiti içeren LaTeX daha uzun çit alır
    ff.FATAL_IMAGES[5] = {"png": b"x", "sha": "0" * 16, "page": 3, "latex": "a ``` b"}
    assert "````latex\na ``` b\n````" in ff.resolve_markers("<!-- vc:fimg 5 -->", None)[0]
    fresh("auto")


def test_fatal_warning_text():
    assert ff.fatal_warning(3) == "3 formül okunamadı; görseli (sayfa numarasıyla) nota eklendi — kaynakla karşılaştırın."
    assert "görseli" not in ff.fatal_warning(3, images_on=False)


def test_katex_batch_unavailable_paths():
    saved = {k: os.environ.get(k) for k in ("VC_NODE_BIN", "VC_KATEX_DIR")}
    try:
        os.environ["VC_NODE_BIN"] = str(Path(__file__).parent / "yok-node.exe")
        assert ff.katex_batch(["a"]) == (None, "heuristic")
        assert ff.katex_batch([]) == ([], "node")
        node = shutil.which("node")
        if node:
            os.environ["VC_NODE_BIN"] = node
            os.environ["VC_KATEX_DIR"] = str(Path(__file__).parent / "yok-katex")
            assert ff.katex_batch(["a"]) == (None, "heuristic")  # katex_check.mjs çıkış kodu 2
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_katex_batch_real_node():
    node = shutil.which("node")
    katex_dir = Path(os.environ.get("VC_KATEX_DIR") or Path(__file__).resolve().parent.parent / "node_modules" / "katex")
    if not node or not (katex_dir / "dist" / "katex.mjs").exists():
        print("  (atlandı: node ya da node_modules/katex yok)")
        return
    saved = (os.environ.get("VC_NODE_BIN"), os.environ.get("VC_KATEX_DIR"))
    os.environ["VC_NODE_BIN"], os.environ["VC_KATEX_DIR"] = node, str(katex_dir)
    try:
        cases = [r"\frac{a}{b}", r"\frac{1}{", r"x & y", r"\begin{aligned} a &= b \end{aligned}", r"\foo", "", r"\text{\alpha}"]
        valid, src = ff.katex_batch(cases)
        assert src == "node" and valid == [True, False, False, True, False, True, False], valid
        # gerçek KaTeX ile uçtan uca: aligned'a sarılan & geçerli, bozuk \frac ölümcül
        reasons, src = ff.find_fatal([r"a & = b", r"\frac{1}{", r"\hbar { ^ } { 2 }"])
        assert src == "node" and reasons == [None, "katex", None], reasons
    finally:
        for k, v in zip(("VC_NODE_BIN", "VC_KATEX_DIR"), saved):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    main()
