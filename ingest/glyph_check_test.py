# -*- coding: utf-8 -*-
"""Tests for glyph_check.py and ocr_math_check.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import glyph_check as G  # noqa: E402
import ocr_math_check as M  # noqa: E402

CLEAN_PAGE_1 = (
    "Let V be a vector space over the field F, and consider the linear maps between them. "
    "Every basis of V has the same number of elements, which is called the dimension. "
    "Therefore, the rank nullity theorem holds. Note that the zero vector is unique."
)
CLEAN_PAGE_2 = (
    "A matrix represents a linear map. Hence, composition corresponds to multiplication. "
    "Moreover, eigenvalues are roots of the characteristic polynomial. Finally, we conclude."
)


def _corrupt(text: str) -> str:
    return text.replace(",", "↪").replace(".", "▷")


def test_detects_substitution_and_learns_map():
    docling = _corrupt(CLEAN_PAGE_1) + "\n\n" + _corrupt(CLEAN_PAGE_2)
    rep = G.detect(docling, [CLEAN_PAGE_1, CLEAN_PAGE_2])
    assert rep is not None
    assert set(rep["chars"]) == {"↪", "▷"}
    assert rep["chars"]["↪"]["map"] == ","
    assert rep["chars"]["▷"]["map"] == "."
    assert rep["chars"]["↪"]["pages"] == [1, 2]
    msg = G.warning(rep)
    assert "Sessiz glif bozulması şüphesi" in msg and "'↪'" in msg and "s. 1, 2" in msg
    assert "otomatik düzeltilmedi" in msg


def test_clean_text_no_warning():
    assert G.detect(CLEAN_PAGE_1 + CLEAN_PAGE_2, [CLEAN_PAGE_1, CLEAN_PAGE_2]) is None


def test_symbols_present_in_pypdf_are_not_flagged():
    page = CLEAN_PAGE_1 + " ♣ ♣ ♣ ♣ ♣"
    assert G.detect(page, [page]) is None


def test_quotes_become_odd_latin1():
    p = "He said that the answer is trivial and then proceeded to the next lemma in the notes."
    page = f"“{p}” “{p}” “{p}”"
    doc = page.replace("“", "Ò").replace("”", "Ó")
    rep = G.detect(doc, [page])
    assert rep is not None and "Ò" in rep["chars"]


def test_no_pypdf_text_means_no_warning():
    docling = _corrupt(CLEAN_PAGE_1)
    assert G.detect(docling, ["", "   "]) is None  # scanned PDF: OCR noise is not evidence


def test_unlocated_occurrences_are_not_evidence():
    docling = "unrelated text here ↪ and ↪ and ↪ more words ↪ end"
    assert G.detect(docling, [CLEAN_PAGE_1]) is None


def test_few_occurrences_ignored():
    docling = _corrupt(CLEAN_PAGE_2)[:60] + "x"
    # only a couple of symbols: below MIN_CHAR_COUNT/MIN_LOCATED
    assert G.detect(docling.replace(",", ""), [CLEAN_PAGE_2]) is None


def test_turkish_letters_not_suspect():
    assert not any(G.is_suspect_char(c) for c in "ÇĞİÖŞÜçğıöşü")
    assert not G.is_suspect_char("∑") and G.is_suspect_char("↪") and G.is_suspect_char("Ò")


def test_check_without_symbols_does_not_read_pdf():
    assert G.check("plain ascii text", Path("does-not-exist.pdf")) is None


# Regression: excerpt of a real case (Linear Algebra slides). pypdf renders norm
# bars as stray 'k' letters and cross products as another glyph; docling
# turned "," into U+21AA, "." into U+25B7 and "|" into U+2663.
REAL_PYPDF = [
    "If u , v , w 2 R\n3\nthen\nu =( a, c ) , v =( b, d )\nIf u =( a, c, 0) and v =( b, d, 0) then\n"
    "Scalar triple product volume of a parallelepiped",
    "A= k v k · k w k · sin ' = k v ⇥ w k .\nThe height computes as:\nH= k u k · cos ✓ .\n"
    "This gives the volume:\nV=H · A= k u k · cos ✓ · k v ⇥ w k = |u · ( v ⇥ w ) |.\nScalar triple product",
]
REAL_DOCLING = (
    "If u↪ v↪ w∈R3 then\n\nIf u = (a↪ c↪ 0) and v = (b↪ d↪ 0) then\n\n"
    "A = ∥v∥ · ∥w∥ · sin ϕ = ∥v × w∥▷\n\nThe height computes as:\n\n"
    "H = ∥u∥ · cos θ▷\n\nThis gives the volume:\n\n"
    "V = H · A = ∥u∥ · cos θ · ∥v × w∥ = ♣u · (v × w)♣▷\n"
)


def test_real_slides_excerpt():
    rep = G.detect(REAL_DOCLING * 2, REAL_PYPDF * 2)
    assert rep is not None
    maps = {ch: v["map"] for ch, v in rep["chars"].items()}
    assert maps.get("↪") == ","
    assert maps.get("▷") == "."
    assert maps.get("♣") == "|"
    assert "×" not in rep["chars"]  # a legitimate cross-product sign


def test_identical_repeated_slides_count_once():
    rep = G.detect(_corrupt(CLEAN_PAGE_1), [CLEAN_PAGE_1] * 12)
    assert rep is not None and rep["chars"]["↪"]["map"] == ","


# ---- ocr_math_check ------------------------------------------------------

def test_sum_confusion_with_limits():
    text = "Toplam şudur:\n\n$$\\S_{i=1}^{n} a_i$$\n\nBitti."
    w = M.warnings(M.scan(text))
    assert len(w) == 1
    assert "'\\S' (§)" in w[0] and "\\sum" in w[0] and "alt/üst sınırla" in w[0]


def test_other_confusions_and_inline_and_bracket():
    text = "a $x \\P y$ b \\(\\copyright\\) c \\[ \\pounds + \\dag \\]"
    cmds = sorted(c for h in M.scan(text) for c in h["cmds"])
    assert cmds == ["P", "copyright", "dag", "pounds"]


def test_legit_commands_not_flagged():
    text = "$$\\Sigma \\Pr(x) \\dagger \\sum_i \\Psi \\partial \\Pi$$ and \\S in prose"
    assert M.scan(text) == []


def test_not_rewritten_and_page_lookup():
    page = "Summation of terms over the index range appears here. " * 3
    text = "Summation of terms over the index\n\n$$\\S_{i=1}^{n} a_i$$"
    hits = M.scan(text)
    M.locate_pages(hits, ["short", page])
    assert hits[0]["page"] == 2
    assert "s. 2" in M.warnings(hits)[0]
    assert "\\S_{i=1}" in text  # scan never mutates the input


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
