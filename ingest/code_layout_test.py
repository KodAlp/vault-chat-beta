# -*- coding: utf-8 -*-
"""Tests for code_layout.py (#8 option B: code layout from OCR line boxes).

    cd ingest && python -m pytest code_layout_test.py -q

Synthetic monospace cells: pitch 6, glyph height 10, line step 14. The slow
test converts a real scanned PDF and is skipped when the file is absent
(set VC_SKIP_SLOW=1 to skip it explicitly).
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import code_layout as cl  # noqa: E402

PITCH, HEIGHT, STEP, X0 = 6.0, 10.0, 14.0, 50.0


def cell(row, col, text, ocr=True, y0=100.0):
    t = y0 + row * STEP
    left = X0 + col * PITCH
    return cl.Cell(text, left, t, left + len(text) * PITCH, t + HEIGHT, ocr=ocr)


def rebuilt(cells):
    res = cl.rebuild_text(cells)
    assert res is not None
    return res


def test_estimate_pitch_monospace():
    cells = [cell(0, 0, "for i in range(10):"), cell(1, 4, "print(i, end=' ')")]
    assert cl.estimate_pitch(cells) == pytest.approx(PITCH)


def test_estimate_pitch_none_without_text():
    assert cl.estimate_pitch([]) is None
    assert cl.estimate_pitch([cell(0, 0, "ab")]) is None


def test_indentation_four_spaces():
    text, notes = rebuilt([cell(0, 0, "for i in range(10):"), cell(1, 4, "print(i, end=' ')"), cell(2, 0, "print()")])
    assert text.splitlines() == ["for i in range(10):", "    print(i, end=' ')", "print()"]
    assert notes == []


def test_single_space_indent():
    text, _ = rebuilt([cell(0, 0, "for kelime in metin.split():"), cell(1, 1, "print(kelime[0])")])
    assert text.splitlines()[1] == " print(kelime[0])"


def test_nested_indentation_levels():
    cells = [
        cell(0, 0, "def f(x):"),
        cell(1, 2, "if x > 0:"),
        cell(2, 4, "return x"),
        cell(3, 2, "return -x"),
    ]
    assert rebuilt(cells)[0].splitlines() == ["def f(x):", "  if x > 0:", "    return x", "  return -x"]


def test_blank_lines_from_vertical_gap():
    cells = [cell(0, 0, "a = 1"), cell(2, 0, "b = 2"), cell(7, 0, "c = 3")]
    # gap of 2 steps -> 1 blank; gap of 5 steps -> 4 blanks capped at 3
    assert rebuilt(cells)[0].split("\n") == ["a = 1", "", "b = 2", "", "", "", "c = 3"]


def test_several_cells_per_row_keep_columns():
    cells = [cell(0, 0, "x = 1"), cell(0, 10, "# bir"), cell(1, 0, "y = 2")]
    first = rebuilt(cells)[0].splitlines()[0]
    assert first == "x = 1".ljust(10) + "# bir"


def test_overlapping_cells_get_a_separator():
    cells = [cell(0, 0, "print(1)"), cell(0, 3, "# x")]  # second starts inside the first
    assert rebuilt(cells)[0] == "print(1) # x"


def test_rows_sorted_regardless_of_input_order():
    cells = [cell(2, 0, "c"), cell(0, 0, "a = 1"), cell(1, 2, "b = 2"), cell(2, 0, "cc = 3")]
    lines = rebuilt(cells)[0].splitlines()
    assert lines[0] == "a = 1" and lines[1] == "  b = 2"


def test_overlay_non_ocr_cells_split_off():
    cells = [
        cell(0, 0, "def f():"),
        cell(1, 4, "return 1"),
        cell(0, 20, "döndürülen değer", ocr=False),
    ]
    text, notes = rebuilt(cells)
    assert text.splitlines() == ["def f():", "    return 1"]
    assert notes == ["döndürülen değer"]


def test_overlay_geometric_fallback_tall_or_wide_chars():
    big = cl.Cell("el yazisi notu", X0 + 200, 100.0, X0 + 400, 100.0 + 2.2 * HEIGHT, ocr=True)
    wide = cl.Cell("genis harfli", X0 + 100, 114.0, X0 + 100 + 12 * 9.0, 124.0, ocr=True)  # pitch 9 vs 6
    cells = [cell(0, 0, "x = 1"), cell(1, 0, "print(x, 'merhaba dunya')"), big, wide]
    text, notes = rebuilt(cells)
    assert "el yazisi notu" in notes and "genis harfli" in notes
    assert text.splitlines()[0] == "x = 1"


def test_no_cells_or_only_non_ocr_cells_means_no_rebuild():
    assert cl.rebuild_text([]) is None
    assert cl.rebuild_text([cell(0, 0, "x = 1", ocr=False)]) is None  # born-digital text: untouched


def test_whitespace_only_cells_ignored():
    rows, overlay, _p, _x = cl.build_rows([cell(0, 0, "   "), cell(1, 0, "x = 1")])
    assert len(rows) == 1 and overlay == []


def test_item_box_bottomleft_to_topleft():
    from docling_core.types.doc import BoundingBox, CoordOrigin

    bb = BoundingBox(l=10, t=700, r=200, b=600, coord_origin=CoordOrigin.BOTTOMLEFT)  # page height 800
    assert cl.item_box_topleft(bb, 800.0) == (10, 100, 200, 200)
    tl = BoundingBox(l=10, t=100, r=200, b=200, coord_origin=CoordOrigin.TOPLEFT)
    assert cl.item_box_topleft(tl, 800.0) == (10, 100, 200, 200)


def _page_cell(c: cl.Cell):
    from docling_core.types.doc import BoundingBox, CoordOrigin

    rect = SimpleNamespace(
        to_bounding_box=lambda: BoundingBox(l=c.l, t=c.t, r=c.r, b=c.b, coord_origin=CoordOrigin.TOPLEFT)
    )
    return SimpleNamespace(text=c.text, from_ocr=c.ocr, rect=rect)


def test_cells_in_box_selects_by_centre():
    inside = cell(0, 0, "x = 1")
    outside = cell(30, 0, "far away")
    page_cells = [_page_cell(inside), _page_cell(outside)]
    got = cl.cells_in_box(page_cells, (X0 - 5, 95, X0 + 300, 130))
    assert [c.text for c in got] == ["x = 1"]
    assert got[0].ocr is True


def _doc_with_code(code_text, bbox_bl):
    from docling_core.types.doc import DoclingDocument, ProvenanceItem
    from docling_core.types.doc.labels import DocItemLabel

    doc = DoclingDocument(name="t")
    prov = ProvenanceItem(page_no=1, bbox=bbox_bl, charspan=(0, len(code_text)))
    doc.add_text(label=DocItemLabel.PARAGRAPH, text="Önce", prov=prov)
    item = doc.add_code(text=code_text, prov=prov)
    doc.add_text(label=DocItemLabel.PARAGRAPH, text="Sonra", prov=prov)
    return doc, item


def test_rebuild_code_items_end_to_end_with_overlay_paragraph():
    from docling_core.types.doc import BoundingBox, CoordOrigin
    from docling_core.types.doc.document import CodeItem

    cells = [
        cell(0, 0, "for i in range(3):"),
        cell(1, 4, "print(i, end=' ')"),
        cell(0, 25, "döndürülen", ocr=False),
    ]
    height = 800.0
    # TOPLEFT box (40..400 x 90..140) as BOTTOMLEFT
    bl = BoundingBox(l=40, t=height - 90, r=400, b=height - 140, coord_origin=CoordOrigin.BOTTOMLEFT)
    doc, item = _doc_with_code("for i in range(3): print(i, end=' ')", bl)
    page = SimpleNamespace(page_no=1, size=SimpleNamespace(height=height), cells=[_page_cell(c) for c in cells])
    assert cl.rebuild_code_items(doc, [page]) == 1
    assert item.text == "for i in range(3):\n    print(i, end=' ')"
    items = [i for i, _ in doc.iterate_items()]
    idx = items.index(item)
    assert not isinstance(items[idx + 1], CodeItem)
    assert items[idx + 1].text == "döndürülen"


def test_rebuild_code_items_leaves_item_without_ocr_cells():
    from docling_core.types.doc import BoundingBox, CoordOrigin

    bl = BoundingBox(l=40, t=710, r=400, b=660, coord_origin=CoordOrigin.BOTTOMLEFT)
    doc, item = _doc_with_code("x = 1", bl)
    page = SimpleNamespace(
        page_no=1, size=SimpleNamespace(height=800.0), cells=[_page_cell(cell(0, 0, "x = 1", ocr=False))]
    )
    assert cl.rebuild_code_items(doc, [page]) == 0
    assert item.text == "x = 1"


def test_rebuild_code_items_without_pages_is_noop():
    from docling_core.types.doc import BoundingBox, CoordOrigin

    bl = BoundingBox(l=0, t=10, r=10, b=0, coord_origin=CoordOrigin.BOTTOMLEFT)
    doc, item = _doc_with_code("x = 1", bl)
    assert cl.rebuild_code_items(doc, []) == 0
    assert cl.rebuild_code_items(doc, None) == 0
    assert item.text == "x = 1"


# ~25-cell golden fixture: a scanned Python lesson page (pitch 6), with a
# trailing comment cell on some rows and one overlay note.
GOLDEN_CELLS = [
    (0, 0, "#split() #Dizeye donusturur"),
    (1, 0, 'metin="aa bb cc"'),
    (2, 0, "kelime=metin.split()  #e"),
    (3, 0, "print(type(kelime))"),
    (4, 0, "print(kelime) #['aa', 'bb', 'cc']"),
    (6, 0, 'kelime=metin.split(" ",1)'),
    (7, 0, "print(kelime)"),
    (9, 0, "for kelime in metin.split():"),
    (10, 1, "print(kelime[0])"),
    (12, 0, "def topla(a, b):"),
    (13, 4, "if a > b:"),
    (14, 8, "return a"),
    (15, 4, "else:"),
    (16, 8, "return b"),
    (18, 0, "for i in range(3):"),
    (19, 4, "for j in range(2):"),
    (20, 8, "print(i, j, end=' ')"),
    (21, 4, "print()"),
    (22, 0, "sonuc = topla(3, 5)"),
    (23, 0, "print(sonuc)"),
]
GOLDEN_TEXT = """#split() #Dizeye donusturur
metin="aa bb cc"
kelime=metin.split()  #e
print(type(kelime))
print(kelime) #['aa', 'bb', 'cc']

kelime=metin.split(" ",1)
print(kelime)

for kelime in metin.split():
 print(kelime[0])

def topla(a, b):
    if a > b:
        return a
    else:
        return b

for i in range(3):
    for j in range(2):
        print(i, j, end=' ')
    print()
sonuc = topla(3, 5)
print(sonuc)"""


def test_golden_page_layout():
    cells = [cell(r, c, t) for r, c, t in GOLDEN_CELLS]
    cells += [
        cell(5, 30, "split iki parca", ocr=False),
        cell(11, 28, "ilk harf", ocr=False),
        cell(1, 32, "yorum", ocr=False),
    ]
    cells += [cell(r, c + 30, "") for r, c, _ in GOLDEN_CELLS[:2]]  # empty OCR boxes are dropped
    assert len(cells) >= 25
    text, notes = rebuilt(cells)
    assert text == GOLDEN_TEXT
    assert sorted(notes) == ["ilk harf", "split iki parca", "yorum"]


# ---- slow, real scan -------------------------------------------------------
# Optional real-file check: set VAULT_CHAT_TEST_PDF_DIR to a folder holding fonk1-NOTLU.pdf.
FONK1 = Path(os.environ.get("VAULT_CHAT_TEST_PDF_DIR", "<unset>")) / "fonk1-NOTLU.pdf"


@pytest.mark.skipif(
    not FONK1.exists() or os.environ.get("VC_SKIP_SLOW") == "1", reason="fonk1-NOTLU.pdf yok / yavaş test atlandı"
)
def test_real_scan_fonk1_page1():
    import convert
    import ocr_lang

    convert.reset_run_state()
    convert._OCR_PLAN[0] = ocr_lang.resolve("tr")
    md = convert.convert_with_docling(FONK1, page_range=(1, 1))
    assert "    print(i, end=\" \")" in md.replace("print(i, end=' ')", 'print(i, end=" ")')
    in_code = False
    code_lines, other = [], []
    for line in md.splitlines():
        if line.startswith("```"):
            in_code = not in_code
            continue
        (code_lines if in_code else other).append(line)
    assert any("döndürülen" in ln for ln in other)
    assert not any("döndürülen" in ln for ln in code_lines)
