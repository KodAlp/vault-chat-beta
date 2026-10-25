# -*- coding: utf-8 -*-
"""Tests for formula_repair.py (kutu ayrıştırma, şablon eşleme, aday sıralama/tekilleştirme, CLI sözleşmesi).

    python ingest/formula_repair_test.py

GPU/model yok: tanıyıcı sahte işlevdir; eşleme sentetik görüntülerle sınanır.
"""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import formula_repair as fr  # noqa: E402


def raises(fn, exc):
    try:
        fn()
    except exc:
        return True
    return False


def test_parse_bbox():
    assert fr.parse_bbox("72.5,300,400.25, 341") == (72.5, 300.0, 400.25, 341.0)
    for bad in ["1,2,3", "a,b,c,d", "10,10,5,20", "10,30,20,20", "nan,0,1,1", ""]:
        assert raises(lambda b=bad: fr.parse_bbox(b), ValueError), bad


def test_decode_previous():
    enc = base64.urlsafe_b64encode("a^{2} é".encode()).decode().rstrip("=")
    assert fr.decode_previous(enc) == "a^{2} é"
    assert fr.decode_previous(None) is None and fr.decode_previous("") is None
    assert fr.decode_previous("***") is None


def _page(w=900, h=1200, seed=3):
    rng = np.random.default_rng(seed)
    pg = np.full((h, w), 255, np.uint8)
    for _ in range(900):  # metin benzeri rastgele çubuklar
        x, y = int(rng.integers(0, w - 30)), int(rng.integers(0, h - 12))
        pg[y : y + int(rng.integers(2, 12)), x : x + int(rng.integers(2, 28))] = int(rng.integers(0, 120))
    return pg


def test_locate_crop_recovers_box_at_other_scale():
    import cv2

    S = 1.67
    page = _page()
    x, y, w, h = 200, 500, 240, 60  # render pikseli
    crop_render = page[y : y + h, x : x + w].copy()
    for crop_scale in (1.0, 1.5, 2.0):  # kırpım farklı ölçekte çizilmiş
        f = crop_scale / S
        crop = cv2.resize(crop_render, (int(round(w * f)), int(round(h * f))), interpolation=cv2.INTER_AREA if f < 1 else cv2.INTER_CUBIC)
        score, box, _ = fr.locate_crop(page, crop, S)
        assert score > 0.9 and box is not None, (crop_scale, score)
        H = page.shape[0] / S
        want = (x / S, H - (y + h) / S, (x + w) / S, H - y / S)
        assert all(abs(a - b) <= 3.0 for a, b in zip(box, want)), (crop_scale, box, want)


def test_locate_crop_rejects_absent():
    page = _page(seed=3)
    other = _page(seed=9)[300:360, 100:340].copy()
    score, box, _ = fr.locate_crop(page, other, 1.67)
    assert box is None and score < fr.MATCH_MIN_SCORE
    flat = np.full((40, 80), 255, np.uint8)
    assert fr.locate_crop(page, flat, 1.67)[1] is None


def test_tight_box_px():
    assert fr.tight_box_px((100, 700, 200, 720), 2.0, 800.0, (1200, 1600), margin=4.0) == (192, 152, 408, 208)
    x0, y0, x1, y1 = fr.tight_box_px((0, 0, 10, 10), 1.0, 100.0, (100, 100), margin=5.0)
    assert (x0, y1) == (0, 100) and x1 == 15 and y0 == 85


def fake_katex(batch):
    return [("BAD" not in b) for b in batch], "node"


def test_candidates_dedupe_order_and_filtering():
    loop = "E = mc^2 + " + "a " * 150
    outs = [
        ("mineru:stored", r"\[ x^{2} \]"),
        ("mineru:adaptive3", "x^{2}"),  # stored ile aynı (sarmalayıcı atılınca): öncelikli kaynak kalır
        ("mineru:stock", "BAD one"),
        ("mineru:tight", r"y + z"),
        ("previous", "q"),
        ("mineru:extra", ""),  # boş atılır
        ("mineru:loop", loop),  # döngü atılır
    ]
    c = fr.build_candidates(outs, fake_katex)
    assert [(x["source"], x["katex_ok"]) for x in c] == [
        ("mineru:adaptive3", True),
        ("mineru:tight", True),
        ("previous", True),
        ("mineru:stock", False),
    ], c
    assert c[0]["latex"] == "x^{2}"
    # katex yoksa null; sıra yalnız kaynak önceliği
    c2 = fr.build_candidates(outs[:4], lambda b: (None, "heuristic"))
    assert [x["katex_ok"] for x in c2] == [None, None, None]
    assert [x["source"] for x in c2] == ["mineru:adaptive3", "mineru:stock", "mineru:tight"]


def test_note_form_applies_note_transforms():
    latex, bodies = fr.note_form(r"a & = b \ c & = d")
    assert latex.startswith(r"\begin{aligned}") and bodies == [latex]
    assert fr.note_form(None) == ("", []) and fr.note_form("  ") == ("", [])


def test_cli_errors(tmp_path=None):
    import io
    import tempfile
    from contextlib import redirect_stderr

    def run(argv):
        buf = io.BytesIO()
        class O:  # sys.stdout.buffer yerine
            buffer = buf
        old = sys.stdout
        sys.stdout = O()
        try:
            with redirect_stderr(io.StringIO()):
                code = fr.main(argv)
        finally:
            sys.stdout = old
        lines = buf.getvalue().decode("utf-8").splitlines()
        assert len(lines) == 1
        return code, json.loads(lines[0])

    code, res = run(["--pdf", "yok.pdf", "--page", "1", "--bbox", "1,2,3,4"])
    assert code == 1 and res["ok"] is False and res["code"] == "PDF_OPEN_FAILED"
    import pypdfium2 as pdfium

    with tempfile.TemporaryDirectory() as d:
        pdf = pdfium.PdfDocument.new()
        pdf.new_page(300, 400)
        p = str(Path(d) / "a.pdf")
        pdf.save(p)
        pdf.close()
        code, res = run(["--pdf", p, "--page", "2", "--bbox", "1,2,3,4"])
        assert code == 1 and res["code"] == "PAGE_OUT_OF_RANGE"
        code, res = run(["--pdf", p, "--page", "1"])
        assert code == 1 and res["code"] == "NO_BOX"
        code, res = run(["--pdf", p, "--page", "1", "--bbox", "9,2,3,4"])
        assert code == 1 and res["code"] == "FAILED"
        # sahte tanıyıcı ile uçtan uca (GPU yok): repair() doğrudan
        args = fr.parse_args(["--pdf", p, "--page", "1", "--bbox", "50,50,150,80", "--previous-b64", base64.urlsafe_b64encode(b"old").decode()])
        res = fr.repair(args, recognizer=lambda imgs: ["x+y"] * len(imgs))
        assert res["ok"] and res["bbox_source"] == "marker" and res["bbox"] == [50, 50, 150, 80]
        srcs = [c["source"] for c in res["candidates"]]
        assert srcs[0] in ("mineru:tight", "mineru:stock", "mineru:adaptive3") and "previous" in srcs
        assert len({c["latex"] for c in res["candidates"]}) == len(res["candidates"])
        # CUDA yok
        res_err = None
        try:
            fr.repair(args, has_cuda=lambda: False)
        except fr.RepairError as e:
            res_err = e.code
        assert res_err == "NO_CUDA"


# Heavy optional backends (requirements-optional.txt). A test that needs one is skipped when it
# is missing (as in CI); any other error still fails the run.
OPTIONAL_MODULES = {"docling", "docling_core", "torch", "transformers", "mineru_vl_utils", "cv2"}


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    skipped = 0
    for t in tests:
        try:
            t()
        except ModuleNotFoundError as e:
            if (e.name or "").split(".")[0] not in OPTIONAL_MODULES:
                raise
            skipped += 1
            print(f"skip {t.__name__}: {e.name} is not installed")
            continue
        print(f"ok {t.__name__}")
    print(f"{len(tests) - skipped} passed, {skipped} skipped")


if __name__ == "__main__":
    main()
