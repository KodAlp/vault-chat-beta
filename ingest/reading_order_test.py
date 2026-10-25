# -*- coding: utf-8 -*-
"""Tests for reading_order.py.

    python ingest/reading_order_test.py

Pure parts (metrics, minimal move, gate refusals, the safety fuse) run on
synthetic boxes and a fake document. The end-to-end checks run the real
docling pipeline on a PDF that is not part of the repo (MIT 18.01 unit-2
review, where a short left-aligned line between centred display formulas
made docling emit the title block after "Remarks."); they are skipped when
the file is missing.
"""
import os
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import reading_order as ro  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("PASS  " if ok else "FAIL  ") + name)
    if not ok:
        failures.append(name)


def leaf(unit, t, b=None, l=72.0, r=540.0, label="text", text=None):
    return dict(unit=unit, t=t, b=t + 20 if b is None else b, l=l, r=r, label=label, text=text or f"u{unit}@{t}")


def rows(n=6):
    """n full-width rows, top to bottom, one unit each."""
    return [leaf(i, 60 + 60 * i) for i in range(n)]


def geo_stream(leaves):
    """A perfect text stream: characters follow the top-to-bottom geometry."""
    return {id(x): float(x["t"]) for x in leaves}


# ---- metrics ----
def test_metrics() -> None:
    check("kendall: identical order is 0", ro.kendall_distance([0, 1, 2, 3]) == 0.0)
    check("kendall: reversed order is 1", ro.kendall_distance([3, 2, 1, 0]) == 1.0)
    check("kendall: ties are ignored", ro.kendall_distance([1, 1, 2]) == 0.0)
    check("kendall: one swap in four", abs(ro.kendall_distance([1, 0, 2, 3]) - 1 / 6) < 1e-9)
    check("kendall: empty / single", ro.kendall_distance([]) == 0.0 and ro.kendall_distance([5]) == 0.0)

    two_col = [
        leaf(2, 310, b=600, l=72, r=300),
        leaf(1, 60, b=300, l=320, r=540),
        leaf(3, 310, b=600, l=320, r=540),
        leaf(0, 60, b=300, l=72, r=300),
    ]
    # A real gutter wins over the horizontal gap: whole left column, then right.
    check("xycut: real gutter -> left column before right column", [x["unit"] for x in ro.xycut(two_col, 612)] == [0, 2, 1, 3])
    stacked = rows(4)
    check("xycut: stacked rows keep top-to-bottom order", [x["unit"] for x in ro.xycut(list(reversed(stacked)), 612)] == [0, 1, 2, 3])


def test_minimal_move() -> None:
    check("lis_keep: longest increasing run", ro.lis_keep([1, 2, 0, 3, 4]) == {0, 1, 3, 4})
    check("min_edit: one displaced item goes to its rank", ro.min_edit_order([1, 2, 0, 3, 4]) == [2, 0, 1, 3, 4])
    check("min_edit: first item that belongs last moves alone", ro.min_edit_order([3, 0, 1, 2]) == [1, 2, 3, 0])
    check("min_edit: sorted input is untouched", ro.min_edit_order([0, 1, 2, 3]) == [0, 1, 2, 3])
    # Minimal means the kept items never move relative to each other.
    order = ro.min_edit_order([2, 3, 4, 0, 1])
    check("min_edit: result is a permutation", sorted(order) == [0, 1, 2, 3, 4])
    check("min_edit: two displaced items", order == [3, 4, 0, 1, 2])


# ---- gate ----
def test_plan_page() -> None:
    # The unit2_review shape: the title block (units 0,1) was emitted last.
    ls = rows(6)
    docling = [ls[2], ls[3], ls[4], ls[5], ls[0], ls[1]]
    info, order = ro.plan_page(docling, geo_stream(docling), 612)
    check("plan: title block moved back to the front", order == [0, 1, 2, 3, 4, 5])
    check("plan: reason REPAIR and xd/sd measured", info["reason"] == "REPAIR" and info["xd"] > 0.05 and info["sd"] > 0.05)
    check("plan: moved units counted", info["moved_units"] == 2 and info["n_units"] == 6)

    info, order = ro.plan_page(ls, geo_stream(ls), 612)
    check("plan: already correct page is left alone", order is None and info["reason"] == "agree")

    two = rows(2)
    info, order = ro.plan_page(list(reversed(two)), None, 612)
    check("plan: fewer than 3 leaves", order is None and info["reason"] == "few")

    # No text layer: no stream -> no repair, even though geometry disagrees.
    info, order = ro.plan_page(docling, None, 612)
    check("plan: no text layer means no repair", order is None and info["reason"] == "nostream")
    info, order = ro.plan_page(docling, lambda: None, 612)
    check("plan: lazy stream returning None means no repair", order is None and info["reason"] == "nostream")

    # The stream is only requested once the geometric gate has passed.
    calls = []
    ro.plan_page(ls, lambda: calls.append(1) or geo_stream(ls), 612)
    check("plan: stream not computed when docling already agrees with geometry", calls == [])

    # rr too high: the two references disagree -> refuse.
    scrambled = {id(x): float(k) for k, x in zip([3, 0, 5, 1, 4, 2], docling)}
    info, order = ro.plan_page(docling, scrambled, 612)
    check("plan: references disagree (rr too high) -> refused", order is None and info["reason"] == "refs-differ" and info["rr"] > ro.MAX_REF_DISAGREE)

    # Low stream coverage.
    partial = {id(x): float(x["t"]) for x in docling[:3]}
    info, order = ro.plan_page(docling, partial, 612)
    check("plan: low stream coverage -> refused", order is None and info["reason"] == "lowcov" and info["cov"] == 0.5)

    # Coverage exactly at the threshold passes (5 of 7 = 0.714 >= 0.7).
    seven = rows(7)
    d7 = [seven[2], seven[3], seven[4], seven[5], seven[6], seven[0], seven[1]]
    st7 = {id(x): float(x["t"]) for x in d7[:5]}
    st7.update({id(d7[5]): 60.0, id(d7[6]): 120.0})
    del st7[id(d7[2])], st7[id(d7[3])]
    info, order = ro.plan_page(d7, st7, 612)
    check("plan: coverage 5/7 passes the 0.7 floor", info["cov"] is not None and abs(info["cov"] - 5 / 7) < 1e-9 and info["reason"] != "lowcov")

    # Stream agrees with docling (docling right, geometry odd): refuse.
    st_docling = {id(x): float(k) for k, x in enumerate(docling)}
    info, order = ro.plan_page(docling, st_docling, 612)
    check("plan: stream agreeing with docling -> refused", order is None and info["reason"] in ("refs-differ", "stream-agrees-docling"))

    # More than half of the units would move: fully reversed page.
    rev = list(reversed(ls))
    info, order = ro.plan_page(rev, geo_stream(rev), 612)
    check("plan: >50% of units moving -> refused", order is None and info["reason"] == "too-many-moved")

    # A unit whose leaves interleave (in reference rank) with another unit.
    a1, a2 = leaf("A", 60), leaf("A", 200)
    b1 = leaf("B", 130)
    x = leaf("X", 300)
    docling = [x, a1, a2, b1]
    info, order = ro.plan_page(docling, geo_stream(docling), 612)
    check("plan: unit spanning another unit's leaf -> refused", order is None and info["reason"] == "unit-spans")

    # A unit whose leaves are not contiguous in docling order.
    docling = [leaf("A", 200), leaf("B", 130), leaf("A", 260), leaf("X", 60), leaf("Y", 330)]
    info, order = ro.plan_page(docling, geo_stream(docling), 612)
    check("plan: non-contiguous unit leaves -> refused", order is None and info["reason"] == "unit-noncontig")

    # Median leaf rank: a two-leaf unit moves as one block.
    p1, p2 = leaf("P", 60), leaf("P", 100)
    docling = [leaf("Q", 160), leaf("R", 220), leaf("S", 280), leaf("T", 340), p1, p2]
    info, order = ro.plan_page(docling, geo_stream(docling), 612)
    check("plan: multi-leaf unit moves as a block", order == ["P", "Q", "R", "S", "T"])

    # Suspicious: far from both references but refused.
    rev = list(reversed(ls))
    info, order = ro.plan_page(rev, geo_stream(rev), 612)
    check("suspicious: refused page far from both references", ro.is_suspicious(info))
    info, order = ro.plan_page(ls, geo_stream(ls), 612)
    check("suspicious: clean page is not", not ro.is_suspicious(info))
    check("suspicious: repaired page is not", not ro.is_suspicious(dict(reason="REPAIR", xd=0.5, sd=0.5)))
    check("suspicious: no stream (sd unknown) is not", not ro.is_suspicious(dict(reason="nostream", xd=0.5, sd=None)))
    check("suspicious: mild disagreement is not", not ro.is_suspicious(dict(reason="refs-differ", xd=0.08, sd=0.5)))


# ---- fake document: glue, furniture, provenance-less children, fuse ----
class FakeBBox:
    def __init__(self, l, r, top, bottom):
        self.l, self.r, self.t, self.b = l, r, top, bottom

    def to_top_left_origin(self, page_height):
        return self


class FakeProv:
    def __init__(self, page_no, bbox):
        self.page_no, self.bbox = page_no, bbox


class FakeRef:
    def __init__(self, node):
        self.node = node
        self.cref = f"#/texts/{id(node)}"

    def resolve(self, doc):
        return self.node


class FakeNode:
    def __init__(self, name, prov=None, text="", children=None, label="text"):
        self.name, self.prov, self.text, self.children, self.label = name, prov or [], text, children or [], label


class FakePage:
    class size:
        width, height = 612.0, 792.0


class FakeBody:
    def __init__(self, children):
        self.children = children


class FakeDoc:
    def __init__(self, nodes, pages):
        self.pages = {p: FakePage() for p in pages}
        self.body = FakeBody([FakeRef(n) for n in nodes])


def node(name, page, top, label="text", text=None, l=72, r=540):
    return FakeNode(name, [FakeProv(page, FakeBBox(l, r, top, top + 20))], text or f"text of {name}", label=label)


names_of = lambda doc: [ref.node.name for ref in doc.body.children]  # noqa: E731


def geo_stream_for_page(pg, leaves, pw, ph):
    return {id(x): float(x["t"]) for x in leaves}


def make_doc():
    caption = FakeNode("cap-no-prov", text="a caption")  # travels with title2
    return FakeDoc(
        [
            node("header", 1, 20, label="page_header"),
            node("body1", 1, 200),
            node("body2", 1, 260),
            node("body3", 1, 320),
            node("body4", 1, 380),
            node("title1", 1, 60),
            node("title2", 1, 100),
            caption,
            node("footer", 1, 760, label="page_footer"),
            node("p2-a", 2, 60),
            node("p2-b", 2, 120),
            node("p2-c", 2, 180),
        ],
        [1, 2],
    )


def test_document_glue() -> None:
    doc = make_doc()
    repaired, suspicious, infos = ro._repair(doc, geo_stream_for_page)
    check("doc: only the broken page repaired", repaired == [1] and 2 not in repaired)
    check(
        "doc: titles first, furniture keeps slots, caption travels with title2",
        names_of(doc)
        == ["header", "title1", "title2", "cap-no-prov", "body1", "body2", "body3", "body4", "footer", "p2-a", "p2-b", "p2-c"]
        or names_of(doc)
        == ["header", "title1", "title2", "body1", "body2", "body3", "body4", "cap-no-prov", "footer", "p2-a", "p2-b", "p2-c"],
    )
    check("doc: header and footer slots unchanged", names_of(doc)[0] == "header" and names_of(doc)[8] == "footer")
    ref_names = names_of(doc)
    check("doc: caption directly follows its unit", ref_names[ref_names.index("cap-no-prov") - 1] == "title2")
    repaired2, _, _ = ro._repair(doc, geo_stream_for_page)
    check("doc: second run is a no-op", repaired2 == [])

    # Safety fuse: a failing verification restores the original children.
    doc = make_doc()
    before = list(doc.body.children)
    real = ro._verify
    ro._verify = lambda *a, **k: False
    try:
        repaired, suspicious, infos = ro._repair(doc, geo_stream_for_page)
    finally:
        ro._verify = real
    check("fuse: failed verification rolls back the children", list(doc.body.children) == before)
    check("fuse: rolled-back page is not reported repaired", repaired == [] and infos[1]["reason"] == "fuse-failed")

    # A verification that raises counts as failure too.
    doc = make_doc()
    before = list(doc.body.children)

    def boom(*a, **k):
        raise RuntimeError("x")

    ro._verify = boom
    try:
        repaired, _, _ = ro._repair(doc, geo_stream_for_page)
    finally:
        ro._verify = real
    check("fuse: exception in verification also rolls back", list(doc.body.children) == before and repaired == [])

    # The real verification: dropping a text or a child is caught.
    doc = make_doc()
    refs = list(doc.body.children)
    texts = ro._page_texts(ro.extract_leaves(doc))
    check("verify: identical document passes", ro._verify(doc, refs, texts))
    doc.body.children.pop(1)
    check("verify: lost child is caught", not ro._verify(doc, refs, texts))
    doc = make_doc()
    refs = list(doc.body.children)
    texts = ro._page_texts(ro.extract_leaves(doc))
    doc.body.children[1].node.text = "changed"
    check("verify: changed page text is caught", not ro._verify(doc, refs, texts))

    # A unit spanning two pages poisons both pages: nothing moves.
    doc = make_doc()
    # (a group, e.g. a list continued on the next page: leaves on two pages)
    spanning = FakeNode("span", children=[FakeRef(node("s1", 1, 440)), FakeRef(node("s2", 2, 20))], label="list")
    doc.body.children.insert(5, FakeRef(spanning))
    before = list(doc.body.children)
    repaired, _, infos = ro._repair(doc, geo_stream_for_page)
    check("poison: unit spanning pages blocks repair", repaired == [] and list(doc.body.children) == before)

    # Nothing to do without text layer on any page.
    doc = make_doc()
    repaired, suspicious, _ = ro._repair(doc, lambda *a: None)
    check("doc: no text layer -> no repair and no suspicion", repaired == [] and suspicious == [])

    # Full text is used (prototype truncated to 80 characters).
    long_text = "x" * 500
    doc = FakeDoc([node("a", 1, 60, text=long_text)], [1])
    check("leaves: full text kept", ro.extract_leaves(doc)[0]["text"] == long_text)
    doc = FakeDoc([FakeNode("tbl", [FakeProv(1, FakeBBox(72, 540, 60, 80))], "", children=[FakeRef(node("cell", 1, 61))], label="table")], [1])
    check("leaves: no descent into tables", len(ro.extract_leaves(doc)) == 1)


# ---- end to end (real docling) ----
# Optional real-file checks: set VAULT_CHAT_TEST_PDF_DIR to a folder holding these PDFs.
UNIT2 = Path(os.environ.get("VAULT_CHAT_TEST_PDF_DIR", "<unset>")) / "942f311e64cea77db589a3557b062025_unit2_review.pdf"
RAFT = Path(os.environ.get("VAULT_CHAT_TEST_PDF_DIR", "<unset>")) / "raft.pdf"


def words(md: str) -> Counter:
    return Counter(re.findall(r"\S+", md))


def test_end_to_end() -> None:
    if not UNIT2.exists():
        print("SKIP  end-to-end unit2_review (PDF yok)")
        return
    import convert

    real = convert.repair_reading_order
    try:
        convert.repair_reading_order = lambda doc, path: ([], [])
        base = convert.convert_with_docling(UNIT2, (1, 3))
        convert.repair_reading_order = real
        fixed = convert.convert_with_docling(UNIT2, (1, 3))
        repaired = list(convert._READING_REPAIRED_PAGES)
    finally:
        convert.repair_reading_order = real
    check("e2e unit2: page 2 reported repaired", 2 in repaired)
    check("e2e unit2: baseline (docling alone) has the bug", base.find("UNIT 2 REVIEW") > base.find("Remarks"))
    i, j = fixed.find("UNIT 2 REVIEW"), fixed.find("Remarks")
    check("e2e unit2: title block precedes 'Remarks.'", 0 <= i < j)
    check("e2e unit2: exported word multiset preserved", words(base) == words(fixed))

    if not RAFT.exists():
        print("SKIP  end-to-end raft (PDF yok)")
        return
    convert.convert_with_docling(RAFT, (1, 2))
    check(
        "e2e raft: reading-order repair is a no-op on a page column_order owns",
        convert._READING_REPAIRED_PAGES == [] and convert._READING_SUSPICIOUS_PAGES == [],
    )


if __name__ == "__main__":
    test_metrics()
    test_minimal_move()
    test_plan_page()
    test_document_glue()
    test_end_to_end()
    print(f"\n{len(failures)} başarısız" if failures else "\nhepsi geçti")
    sys.exit(1 if failures else 0)
