# -*- coding: utf-8 -*-
"""docling okuma sırası onarımı: iki sütunlu sayfalarda sütun karışıklığı.

docling'in kural tabanlı ReadingOrderPredictor'ı, her öğenin bbox'ı doğru olsa
da bazen iki sütunlu bir sayfayı sütunları yer değiştirmiş ya da sol sütunun bir
paragrafı sağ sütunun tamamından sonra gelecek biçimde yayar. Burada geometriden
yeniden kurulur: tam genişlikli (veya orta çizgiyi aşan) öğeler sayfayı bantlara
böler; yalnızca gerçekten iki sütun taşıyan bantlarda önce sol, sonra sağ sütun
gelir. Başka hiçbir sayfaya dokunulmaz.

`reorder_page` düz veriyle çalışır (docling gerekmez, birim testlenebilir);
`repair_document_order` DoclingDocument'a bağlayan ince yapıştırıcıdır.
"""
from __future__ import annotations

from dataclasses import dataclass

GUTTER_TOL = 0.04  # orta çizgi toleransı, sayfa genişliğinin oranı
WIDE = 0.55  # bu orandan geniş her öğe "kapsayan"dır
ROW_OVERLAP = 0.5  # sütun öğesinin kapsayan öğenin satırına katılma eşiği
MIN_SIDE_CHARS = 80  # iki sütunlu bandın her yanında asgari metin
MIN_PICTURE_WIDTH = 0.25  # bir şekil bu genişlikten sonra "içerik" sayılır


@dataclass(frozen=True)
class Box:
    key: int  # çağıranın indeksi
    l: float
    r: float
    top: float  # yukarıdan aşağı koordinat (top < bottom)
    bottom: float
    chars: int  # metin uzunluğu (şekil/tablo için 0)


def _classify(b: Box, page_width: float) -> str:
    mid = page_width / 2
    tol = GUTTER_TOL * page_width
    if b.r - b.l >= WIDE * page_width:
        return "S"
    if b.r <= mid + tol and b.l < mid - tol:
        return "L"
    if b.l >= mid - tol and b.r > mid + tol:
        return "R"
    # A narrow item wholly on one side of the exact midline is column content
    # (a one-word entry such as "aha" at L305-R318); only an item that
    # straddles the midline stays spanning (centred page number, title).
    if b.l >= mid:
        return "R"
    if b.r <= mid:
        return "L"
    return "S"


def _vertical_overlap(a: Box, b: Box) -> float:
    return min(a.bottom, b.bottom) - max(a.top, b.top)


def _shares_rows(a: Box, b: Box) -> bool:
    smaller = max(min(a.bottom - a.top, b.bottom - b.top), 1e-6)
    return _vertical_overlap(a, b) >= ROW_OVERLAP * smaller


def _extent(boxes: list[Box]) -> tuple[float, float]:
    return min(b.top for b in boxes), max(b.bottom for b in boxes)


def _is_two_column(left: list[Box], right: list[Box], page_width: float) -> bool:
    if not left or not right:
        return False
    lt, lb = _extent(left)
    rt, rb = _extent(right)
    if min(lb, rb) - max(lt, rt) <= 0:
        return False

    def substance(side: list[Box]) -> int:
        total = 0
        for b in side:
            if b.chars > 0:
                total += b.chars
            elif b.r - b.l >= MIN_PICTURE_WIDTH * page_width:
                total += MIN_SIDE_CHARS
        return total

    return substance(left) >= MIN_SIDE_CHARS and substance(right) >= MIN_SIDE_CHARS


def reorder_page(boxes: list[Box], page_width: float) -> list[int] | None:
    """Onarılmış anahtar sırasını döndür; sayfa olduğu gibi kalacaksa None."""
    if len(boxes) < 2 or page_width <= 0:
        return None
    pos = {b.key: i for i, b in enumerate(boxes)}  # docling'in özgün sırası
    kind = {b.key: _classify(b, page_width) for b in boxes}
    by_key = {b.key: b for b in boxes}

    # Kapsayan öğeler + satırlarına katılan yan öğeler (Dive'daki yazar satırı).
    parent: dict[int, int] = {b.key: b.key for b in boxes}

    def find(k: int) -> int:
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    spanning = [b for b in boxes if kind[b.key] == "S"]
    in_row: set[int] = {b.key for b in spanning}
    for s in spanning:
        height = s.bottom - s.top
        for b in boxes:
            if kind[b.key] == "S":
                continue
            ov = _vertical_overlap(s, b)
            if ov > 0 and ov >= ROW_OVERLAP * max(height, 1e-6):
                in_row.add(b.key)
                union(s.key, b.key)

    groups: dict[int, list[Box]] = {}
    for k in in_row:
        groups.setdefault(find(k), []).append(by_key[k])
    rows = []
    for members in groups.values():
        members.sort(key=lambda b: pos[b.key])
        top, bottom = _extent(members)
        rows.append(((top + bottom) / 2, members))
    rows.sort(key=lambda r: r[0])
    centers = [c for c, _ in rows]

    bands: list[list[Box]] = [[] for _ in range(len(rows) + 1)]
    for b in boxes:
        if b.key in in_row:
            continue
        center = (b.top + b.bottom) / 2
        bands[sum(1 for c in centers if c < center)].append(b)

    any_inverted = False
    out: list[int] = []
    for i, band in enumerate(bands):
        band.sort(key=lambda b: pos[b.key])
        left = [b for b in band if kind[b.key] == "L"]
        right = [b for b in band if kind[b.key] == "R"]
        if _is_two_column(left, right, page_width):
            # Only a band where docling really emitted a right-column item before
            # a left-column one counts as broken; otherwise its order is kept.
            # "Before" must be a real column swap: the two boxes share at least
            # half of the smaller one's height. A right item wholly above the
            # left one (a page header row) or one that merely grazes it by a
            # point or two (a footnote under the last paragraph) is plain
            # top-to-bottom order.
            if any(pos[r.key] < pos[l.key] and _shares_rows(r, l) for r in right for l in left):
                any_inverted = True
            out.extend(b.key for b in left)
            out.extend(b.key for b in right)
        else:
            out.extend(b.key for b in band)
        if i < len(rows):
            out.extend(b.key for b in rows[i][1])

    assert sorted(out) == sorted(b.key for b in boxes), "reorder_page must permute keys"
    if not any_inverted:
        return None
    original = [b.key for b in boxes]
    return None if out == original else out


# --- docling bağlayıcısı ----------------------------------------------------


def _iter_provs(doc, node):
    """node ve torunlarının prov'larını belge sırasıyla döndürür."""
    yield from getattr(node, "prov", None) or []
    for child in getattr(node, "children", None) or []:
        yield from _iter_provs(doc, child.resolve(doc))


def _text_length(doc, node) -> int:
    total = len(getattr(node, "text", "") or "")
    for child in getattr(node, "children", None) or []:
        total += _text_length(doc, child.resolve(doc))
    return total


def _unit_geometry(doc, node):
    """(page_no, l, r, top, bottom, chars) ya da None (prov yok / sayfa bilinmiyor)."""
    provs = list(_iter_provs(doc, node))
    if not provs:
        return None
    page_no = provs[0].page_no
    page = doc.pages.get(page_no)
    if page is None:
        return None
    height = page.size.height
    # Grup (liste) ise o sayfadaki torunların birleşik kutusu; yaprak ise ilk prov.
    use = [p for p in provs if p.page_no == page_no] if getattr(node, "children", None) else provs[:1]
    tops, bottoms, ls, rs = [], [], [], []
    for p in use:
        bb = p.bbox.to_top_left_origin(height)
        ls.append(bb.l)
        rs.append(bb.r)
        tops.append(min(bb.t, bb.b))
        bottoms.append(max(bb.t, bb.b))
    return page_no, min(ls), max(rs), min(tops), max(bottoms), _text_length(doc, node)


def repair_document_order(doc) -> list[int]:
    """doc.body.children'ı yerinde onarır; sırası değişen sayfa numaralarını döndürür."""
    refs = list(doc.body.children)
    prefix: list = []  # prov'suz, öncesinde öğe olmayan çocuklar
    units: list[dict] = []
    for ref in refs:
        geo = _unit_geometry(doc, ref.resolve(doc))
        if geo is None:
            (units[-1]["refs"] if units else prefix).append(ref)
            continue
        units.append({"refs": [ref], "geo": geo})

    result: list = list(prefix)
    repaired_pages: list[int] = []
    i = 0
    while i < len(units):
        j = i
        page_no = units[i]["geo"][0]
        while j < len(units) and units[j]["geo"][0] == page_no:
            j += 1
        run = units[i:j]
        order = None
        if len(run) >= 2:
            boxes = [Box(k, u["geo"][1], u["geo"][2], u["geo"][3], u["geo"][4], u["geo"][5]) for k, u in enumerate(run)]
            order = reorder_page(boxes, doc.pages[page_no].size.width)
        if order is not None:
            repaired_pages.append(page_no)
            run = [run[k] for k in order]
        for u in run:
            result.extend(u["refs"])
        i = j

    if len(result) != len(refs):  # sigorta: hiçbir çocuk kaybolmaz/çoğalmaz
        raise RuntimeError("column_order: children count changed")
    doc.body.children[:] = result
    return sorted(set(repaired_pages))
