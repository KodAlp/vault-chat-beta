# -*- coding: utf-8 -*-
"""Tests for column_order.py.

    python ingest/column_order_test.py

Boxes are synthetic, built from the measured geometry of the real PDFs that
docling mis-ordered (raft, the sliding-mode-control arXiv paper, a curved-title
German magazine page) and of the one two-column page it orders correctly
(Dive into Systems) which must stay untouched.
"""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from column_order import Box, reorder_page, repair_document_order  # noqa: E402

failures = 0


def check(name: str, got, want) -> None:
    global failures
    if got != want:
        failures += 1
        print(f"FAIL {name}\n  got:  {got!r}\n  want: {want!r}")
    else:
        print(f"ok   {name}")


def boxes_from(rows):
    """rows: [(name, l, r, top, bottom, chars)] in docling's emitted order."""
    names = [r[0] for r in rows]
    boxes = [Box(i, r[1], r[2], r[3], r[4], r[5]) for i, r in enumerate(rows)]
    return names, boxes


def named_order(rows, width):
    names, boxes = boxes_from(rows)
    order = reorder_page(boxes, width)
    return None if order is None else [names[k] for k in order]


# raft p1: width 612. Docling emitted the whole right column before the left.
RAFT = [
    ("title", 100, 512, 60, 95, 40),
    ("authors", 224.8, 394.6, 105, 135, 40),
    ("R1", 318, 540, 160, 300, 600),
    ("R2", 318, 540, 305, 500, 700),
    ("R3", 318, 540, 505, 700, 700),
    ("abstract", 72, 300, 160, 180, 8),
    ("L1", 72, 300, 185, 400, 800),
    ("L2", 72, 300, 405, 700, 900),
]
check(
    "raft: left column before right",
    named_order(RAFT, 612),
    ["title", "authors", "abstract", "L1", "L2", "R1", "R2", "R3"],
)

# SMC p2: width 595.3. A left paragraph's hyphenated last line pokes to 308.4
# (right column starts 306.6); docling put it after the right column and
# another left paragraph in the middle of it.
SMC = [
    ("R1", 307, 558, 84, 141, 400),
    ("Rlist1", 322, 571, 154, 175, 200),
    ("Moreover", 37.6, 290.9, 180, 380, 900),  # left paragraph emitted mid-right
    ("Rlist2", 322, 571, 190, 245, 300),
    ("R2", 307, 558, 252, 344, 600),
    ("R3", 307, 558, 347, 464, 800),
    ("R4", 307, 558, 494, 551, 500),
    ("overhang", 37.6, 308.4, 383, 763, 2500),  # last line pokes into the gutter
    ("page-no", 295, 300, 772, 781, 1),
]
check(
    "SMC: gutter overhang stays in the left column",
    named_order(SMC, 595.3),
    ["Moreover", "overhang", "R1", "Rlist1", "Rlist2", "R2", "R3", "R4", "page-no"],
)

# Geschichte p3: width 595.3, curved title box 55.6-248.7 reaches below the
# column tops (210.5); its centre (152) is still above the paragraphs' centres.
GESCH = [
    ("title", 133.7, 477.1, 55.6, 248.7, 60),
    ("R1", 309, 550, 210.5, 280, 500),
    ("R2", 309, 550, 284, 420, 600),
    ("L1", 36, 286, 210.5, 415, 1200),
]
check(
    "Geschichte: curved title, left column first",
    named_order(GESCH, 595.3),
    ["title", "L1", "R1", "R2"],
)

# Dive p1: 3-author row (the middle one crosses the midline); docling's order
# (title, authors left to right, left column, right column) is correct.
DIVE = [
    ("title", 74, 538, 84, 115, 50),
    ("a1", 71.6, 213, 133, 175, 40),
    ("a2", 247.7, 365.3, 133, 175, 40),
    ("a3", 414.6, 526.7, 133, 175, 40),
    ("abstract", 53.8, 111.9, 189, 200, 8),
    ("L1", 53, 298, 205, 400, 900),
    ("L2", 53, 298, 405, 700, 900),
    ("intro", 318, 400, 189, 200, 14),
    ("R1", 318, 560, 205, 400, 900),
    ("R2", 318, 560, 405, 700, 900),
]
check("Dive: author row, correct order untouched", named_order(DIVE, 612), None)
# ...and the same page with the author row scrambled keeps authors together
# and still puts the left column first.
scrambled = [DIVE[0], DIVE[7], DIVE[8], DIVE[3], DIVE[1], DIVE[2], DIVE[4], DIVE[5], DIVE[6], DIVE[9]]
check(
    "Dive scrambled: row stays above the columns",
    named_order(scrambled, 612),
    ["title", "a3", "a1", "a2", "abstract", "L1", "L2", "intro", "R1", "R2"],
)

SINGLE = [
    ("h", 72, 540, 60, 90, 30),
    ("p1", 72, 540, 100, 300, 1500),
    ("p2", 72, 540, 310, 600, 1800),
]
check("single column: untouched", named_order(SINGLE, 612), None)

# A short right-aligned date line next to a left-aligned paragraph is no column.
DATE = [
    ("p1", 72, 300, 100, 140, 400),
    ("date", 480, 540, 100, 112, 12),
    ("p2", 72, 300, 150, 300, 600),
]
check("single column + short right item: untouched", named_order(DATE, 612), None)
DATE_ODD = [DATE[0], DATE[2], DATE[1]]
check("short right item emitted last: untouched", named_order(DATE_ODD, 612), None)

CORRECT = [
    ("title", 100, 512, 60, 95, 40),
    ("L1", 72, 300, 160, 400, 800),
    ("L2", 72, 300, 405, 700, 800),
    ("R1", 318, 540, 160, 400, 800),
    ("R2", 318, 540, 405, 700, 800),
]
check("two-column page already correct: untouched", named_order(CORRECT, 612), None)

# A full-width figure between two two-column bands: each band fixed alone, the
# figure stays between them.
TWO_BANDS = [
    ("title", 100, 512, 60, 90, 40),
    ("R1", 318, 540, 100, 250, 700),
    ("L1", 72, 300, 100, 250, 700),
    ("figure", 72, 540, 270, 420, 0),
    ("R2", 318, 540, 440, 700, 700),
    ("L2", 72, 300, 440, 700, 700),
]
check(
    "figure between two bands: each fixed independently",
    named_order(TWO_BANDS, 612),
    ["title", "L1", "R1", "figure", "L2", "R2"],
)

# Answer-key page (Kursbuch-like): left column, then right column, with a logo
# in the title row and pictures in the footer. Nothing is inverted, so the
# page must be left exactly as docling emitted it.
KEY = [
    ("title", 71, 334, 39, 76, 40),
    ("L1", 71, 278, 99, 281, 900),
    ("L2", 71, 277, 290, 700, 900),
    ("footer-pic", 72, 112, 799, 821, 0),
    ("R1", 315, 523, 99, 273, 900),
    ("R2", 315, 520, 283, 774, 900),
    ("logo", 379, 530, 35, 78, 0),
    ("footer", 227, 423, 801, 822, 30),
]
check("no inversion: untouched even with stray items", named_order(KEY, 595.3), None)

# Header row "left title | right title" then the left column, then the right
# column (UeB-like), and a footnote grazing the last right paragraph by 2 pt
# (SMC page 1): both are ordinary top-to-bottom order, not column swaps.
HEADER = [
    ("hdr-left", 71, 192, 38, 65, 31),
    ("hdr-right", 314, 527, 37, 64, 17),
    ("L1", 71, 260, 73, 302, 700),
    ("L2", 43, 259, 317, 785, 1100),
    ("R1", 333, 521, 73, 205, 400),
    ("R2", 305, 525, 219, 646, 800),
]
check("header row above the columns: untouched", named_order(HEADER, 595.3), None)
GRAZE = [
    ("L1", 38, 296, 506, 706, 1000),
    ("R1", 307, 558, 593, 757, 1300),
    ("footnote", 52, 228, 755, 762, 48),
]
check("2 pt graze is not a column swap", named_order(GRAZE, 595.3), None)

# A one-word right-column entry just right of the midline (L305-R318) is
# column content, not a spanning item.
NARROW = [
    ("L1", 42, 130, 100, 200, 300),
    ("aha", 305, 318, 120, 128, 3),
    ("R1", 305, 460, 140, 300, 300),
    ("L2", 42, 130, 220, 400, 300),
]
check("narrow right entry stays in the right column", named_order(NARROW, 595.2), ["L1", "L2", "aha", "R1"])

# A picture alone on one side is not "substance" when narrow.
NARROW_PIC = [
    ("p1", 72, 300, 100, 400, 900),
    ("icon", 320, 360, 100, 140, 0),
    ("p2", 72, 300, 410, 600, 900),
]
check("narrow picture is not a column", named_order(NARROW_PIC, 612), None)

# Permutation property: for random layouts, the result (when not None) is a
# permutation of the keys, and reordering is idempotent.
rng = random.Random(7)
bad = 0
for _ in range(300):
    rows = []
    for i in range(rng.randint(2, 14)):
        kind = rng.choice("LLRRS")
        top = rng.uniform(40, 700)
        if kind == "L":
            l, r = rng.uniform(30, 90), rng.uniform(250, 316)
        elif kind == "R":
            l, r = rng.uniform(300, 330), rng.uniform(520, 580)
        else:
            l, r = rng.uniform(30, 250), rng.uniform(330, 580)
        rows.append((f"b{i}", l, r, top, top + rng.uniform(10, 200), rng.choice([0, 20, 200, 900])))
    names, boxes = boxes_from(rows)
    order = reorder_page(boxes, 612)
    if order is None:
        continue
    if sorted(order) != list(range(len(boxes))):
        bad += 1
        continue
    again = reorder_page([boxes[k] for k in order], 612)
    if again is not None:
        # keys changed meaning after re-listing; re-run on the relisted boxes
        relisted = [Box(i, boxes[k].l, boxes[k].r, boxes[k].top, boxes[k].bottom, boxes[k].chars) for i, k in enumerate(order)]
        if reorder_page(relisted, 612) is not None:
            bad += 1
check("random layouts: permutation, idempotent", bad, 0)


# --- repair_document_order on a fake document (no docling needed) -----------


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

    def resolve(self, doc):
        return self.node


class FakeNode:
    def __init__(self, name, prov=None, text="", children=None):
        self.name, self.prov, self.text, self.children = name, prov or [], text, children or []


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


def node(name, page, l, r, top, bottom, chars=400):
    return FakeNode(name, [FakeProv(page, FakeBBox(l, r, top, bottom))], "x" * chars)


names_of = lambda doc: [ref.node.name for ref in doc.body.children]  # noqa: E731

caption = FakeNode("caption-no-prov", text="fig")  # no prov: stays attached to its predecessor
group = FakeNode(
    "list",
    children=[FakeRef(node("li1", 1, 318, 540, 400, 430)), FakeRef(node("li2", 1, 318, 540, 435, 470))],
)
doc = FakeDoc(
    [
        node("title", 1, 100, 512, 60, 95, 40),
        node("R1", 1, 318, 540, 160, 300),
        caption,
        group,
        node("L1", 1, 72, 300, 160, 400),
        node("L2", 1, 72, 300, 405, 700),
        node("p2-a", 2, 72, 540, 60, 300),
        node("p2-b", 2, 72, 540, 310, 600),
        node("p3-R", 3, 318, 540, 60, 300),
        node("p3-L", 3, 72, 300, 60, 300),
    ],
    [1, 2, 3],
)
pages = repair_document_order(doc)
check("fake doc: pages reported", pages, [1, 3])
check(
    "fake doc: order",
    names_of(doc),
    ["title", "L1", "L2", "R1", "caption-no-prov", "list", "p2-a", "p2-b", "p3-L", "p3-R"],
)
check("fake doc: second run is a no-op", repair_document_order(doc), [])

sys.exit(1 if failures else 0)
