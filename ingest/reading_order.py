# -*- coding: utf-8 -*-
"""docling okuma sırası onarımı: ortalanmış formüllerin arasındaki kısa satırlar.

docling'in kural tabanlı okuma sırası (reading_order_rb.py), ortalanmış gösterim
formüllerinin altında/arasında kalan KISA, sola dayalı bir satırı sahte bir
"head" sayar; head'ler soldan sağa sıralandığından o satır (ve bağlı olduğu blok)
sayfanın başında olması gerekirken sonraya düşer (ör. "18.01 UNIT 2 REVIEW"
başlığı "Remarks." paragrafından sonra gelir). column_order.py yalnızca iki
sütun karışıklığını düzeltir; bu modül tek sütunlu sayfalardaki bu bozulmayı
ele alır.

Yöntem: her sayfa için iki BAĞIMSIZ referans kurulur —
  1. geometriden özyinelemeli XY-cut sırası,
  2. pdfium'un metin akışı sırası (karakter -> onu içeren en küçük öğe, öğenin
     medyan karakter indeksi).
Sayfa ancak docling sırası iki referanstan da belirgin ayrışırken VE iki
referans birbirine yakınken onarılır (aşağıdaki kapı). Onarım asgari
düzenlemedir: docling sırası ile XY-cut sırasının en uzun ortak artan alt
dizisi yerinde bırakılır, yalnızca yerinden oynamış birimler referans
sırasındaki yerlerine konur. "Birim" = doc.body'nin bir çocuğu (grup/liste
bütün olarak taşınır).

Neden bu kadar temkinli: ölçülen 509 sayfalık (held-out dahil) kümede kapı 31
sayfayı onardı, 0 sayfayı kötüleştirdi, 36 gerçek hatanın 30'unu düzeltti.
Kapıyı geçmeyen ama iki referansla da ciddi ayrışan sayfalar "şüpheli" olarak
döner; kullanıcı kaynakla karşılaştırsın diye (düzeltmeden).

Metin katmanı olmayan (taranmış/OCR) sayfalarda pdfium akışı yoktur: kapı
geçilemez, ne onarım ne uyarı üretilir — tek bir referansla (yalnızca
geometri) docling'in sırasını ezmek ölçümde güvenli bulunmadı.

Düz veriyle çalışan fonksiyonlar (`xycut`, `kendall_distance`, `lis_keep`,
`min_edit_order`, `plan_page`) docling gerektirmez; `repair_reading_order`
DoclingDocument + PDF yolunu bağlayan ince yapıştırıcıdır.
"""
from __future__ import annotations

import bisect
import itertools
import statistics
import sys
from collections import Counter

# ---- kapı eşikleri (held-out kümede ölçüldü; bkz. modül açıklaması) ----
MIN_LEAVES = 3
MIN_DOCLING_DISAGREE = 0.05  # xd: docling vs XY-cut
MIN_STREAM_DISAGREE = 0.05  # sd: docling vs pdfium akışı
MAX_REF_DISAGREE = 0.025  # rr: XY-cut vs pdfium akışı (iki referans uzlaşmalı)
MIN_STREAM_COVERAGE = 0.7  # akış sırası olan yaprakların oranı
MAX_MOVED_FRACTION = 0.5  # birimlerin yarısından fazlası taşınıyorsa sayfa güvenilmez
SUSPICIOUS_DISAGREE = 0.1  # kapıyı geçemeyen sayfa bu eşiğin üstündeyse "şüpheli"
MIN_STREAM_CHARS = 3  # bir yaprağın akış sırası için asgari karakter

# Sayfa süsleri: onarım bunların slotlarına dokunmaz (başlık/altbilgi her
# sayfada aynı yerde kalır), XY-cut/akış metriklerine de girmezler.
FURNITURE = {"page_header", "page_footer"}
# Bu etiketlerin içine inilmez: tablo hücresi/formül parçası ayrı yaprak olursa
# metrikler anlamsız küçük kutularla dolar.
OPAQUE = {"picture", "table", "code", "formula", "chart"}


# --------------------------------------------------------------------------
# Referans 1: özyinelemeli XY-cut (yaprak kutuları; üst-sol orijin, punto)
# --------------------------------------------------------------------------
def _gaps(intervals, min_gap):
    iv = sorted(intervals, key=lambda x: (x[0], x[1]))
    groups = [[iv[0]]]
    reach = iv[0][1]
    for x in iv[1:]:
        if x[0] >= reach + min_gap:
            groups.append([x])
        else:
            groups[-1].append(x)
        reach = max(reach, x[1])
    return groups


def _col_ok(vg):
    # A vertical cut counts only if >=2 groups carry real text height; this
    # keeps margin numbers and one-word sidebars from splitting the page.
    big = [h for h in (sum(x[2]["b"] - x[2]["t"] for x in g) for g in vg) if h >= 40]
    return len(big) >= 2


def xycut(items, page_width):
    """items: l/r/t/b sözlükleri. XY-cut sırasıyla aynı öğeleri döndürür."""
    if len(items) <= 1:
        return list(items)
    vg = _gaps([(i["l"], i["r"], i) for i in items], max(6.0, 0.015 * page_width))
    hg = _gaps([(i["t"], i["b"], i) for i in items], 1.0)
    # Horizontal cut first unless a real gutter exists.
    if len(hg) > 1 and (len(vg) == 1 or not _col_ok(vg)):
        groups = hg
    elif len(vg) > 1 and _col_ok(vg):
        groups = vg
    elif len(hg) > 1:
        groups = hg
    else:
        return sorted(items, key=lambda i: (round(i["t"] / 3), i["l"]))
    out = []
    for g in groups:
        out += xycut([x[2] for x in g], page_width)
    return out


def xycut_ranks(items, page_width):
    return {id(i): k for k, i in enumerate(xycut(items, page_width))}


# --------------------------------------------------------------------------
# Metrik ve asgari düzenleme
# --------------------------------------------------------------------------
def kendall_distance(ranks):
    """`ranks` bir dizi sırasıyla verilen sıra numaralarıdır; ters (discordant)
    çiftlerin, eşit olmayan çiftlere oranı. Eşitler sayılmaz."""
    d = c = 0
    for a, b in itertools.combinations(ranks, 2):
        if a != b:
            c += 1
            d += a > b
    return d / c if c else 0.0


def lis_keep(ranks):
    """`ranks` içinde en uzun kesin artan alt dizinin indeksleri (küme)."""
    tails: list = []
    tail_idx: list[int] = []
    prev = [-1] * len(ranks)
    for i, r in enumerate(ranks):
        p = bisect.bisect_left(tails, r)
        if p == len(tails):
            tails.append(r)
            tail_idx.append(i)
        else:
            tails[p] = r
            tail_idx[p] = i
        prev[i] = tail_idx[p - 1] if p > 0 else -1
    out = set()
    k = tail_idx[-1] if tail_idx else -1
    while k != -1:
        out.add(k)
        k = prev[k]
    return out


def min_edit_order(rank):
    """docling sırası 0..n-1; rank[i] öğenin referans sırası. En uzun
    referansla tutarlı alt dizi yerinde kalır, kalanlar rank'larına göre
    araya eklenir. Yeni sırayı (indeks listesi) döndürür."""
    n = len(rank)
    keep = lis_keep(rank)
    seq = [i for i in range(n) if i in keep]
    for i in sorted((i for i in range(n) if i not in keep), key=lambda i: rank[i]):
        # Insert after the last kept element with a smaller rank.
        pos = 0
        for p, j in enumerate(seq):
            if rank[j] < rank[i]:
                pos = p + 1
        seq.insert(pos, i)
    return seq


# --------------------------------------------------------------------------
# Sayfa kararı (saf veri)
# --------------------------------------------------------------------------
def plan_page(leaves, stream, page_width):
    """leaves: bu sayfadaki sayfa-süsü olmayan yapraklar, docling sırasıyla;
    her biri l/r/t/b ve 'unit' (sayfa içinde birim kimliği) taşır.
    stream: {id(yaprak): akış sırası}, None (metin katmanı yok) ya da bunları
    tembelce üreten çağrılabilir.

    Döndürür (info, unit_order|None). unit_order: birimlerin yeni sırası
    (docling'deki ilk görünme sırasına göre listelenmiş birim kimlikleri).
    info: n, xd, sd, rr, cov, reason ('REPAIR' ya da ret nedeni)."""
    n = len(leaves)
    info = dict(n=n, xd=None, sd=None, rr=None, cov=None, reason="")
    if n < MIN_LEAVES:
        info["reason"] = "few"
        return info, None
    xr_map = xycut_ranks(leaves, page_width)
    xr = [xr_map[id(i)] for i in leaves]
    info["xd"] = kendall_distance(xr)
    if info["xd"] < MIN_DOCLING_DISAGREE:
        info["reason"] = "agree"
        return info, None
    # Stream ranks are the expensive part (a pdfium pass over every character),
    # so they are only computed once the cheap geometric gate has passed.
    if callable(stream):
        stream = stream()
    if not stream:
        info["reason"] = "nostream"
        return info, None
    idx = [i for i in range(n) if id(leaves[i]) in stream]
    info["cov"] = len(idx) / n
    if len(idx) < max(MIN_LEAVES, MIN_STREAM_COVERAGE * n):
        info["reason"] = "lowcov"
        return info, None
    sr = [stream[id(leaves[i])] for i in idx]
    xs = [xr[i] for i in idx]
    info["sd"] = kendall_distance(sr)
    # rr: the two references must agree with each other.
    info["rr"] = kendall_distance([sr[k] for k in sorted(range(len(idx)), key=lambda k: xs[k])])
    if info["rr"] > MAX_REF_DISAGREE:
        info["reason"] = "refs-differ"
        return info, None
    if info["sd"] < MIN_STREAM_DISAGREE:
        info["reason"] = "stream-agrees-docling"
        return info, None

    by: dict = {}
    for k, leaf in enumerate(leaves):
        by.setdefault(leaf["unit"], []).append(k)
    units = list(by)  # docling order of first appearance
    # A unit's leaves must be contiguous in docling order and must not
    # interleave (in reference rank) with another unit's leaves; otherwise
    # moving the unit as a whole cannot be right.
    for ks in by.values():
        if ks[-1] - ks[0] + 1 != len(ks):
            info["reason"] = "unit-noncontig"
            return info, None
    for u, ks in by.items():
        lo, hi = min(xr[k] for k in ks), max(xr[k] for k in ks)
        for v, kv in by.items():
            if v != u and any(lo < xr[k] < hi for k in kv):
                info["reason"] = "unit-spans"
                return info, None
    r = [statistics.median(xr[k] for k in by[u]) for u in units]
    order = min_edit_order(r)
    if order == list(range(len(units))):
        info["reason"] = "noop"
        return info, None
    moved = len(units) - len(lis_keep(r))
    info["moved_units"], info["n_units"] = moved, len(units)
    if moved > MAX_MOVED_FRACTION * len(units):
        info["reason"] = "too-many-moved"
        return info, None
    info["reason"] = "REPAIR"
    return info, [units[i] for i in order]


def is_suspicious(info):
    """Kapıyı geçemeyen ama iki referansla da ciddi ayrışan sayfa."""
    return (
        info.get("reason") != "REPAIR"
        and (info.get("xd") or 0.0) >= SUSPICIOUS_DISAGREE
        and (info.get("sd") or 0.0) >= SUSPICIOUS_DISAGREE
    )


# --------------------------------------------------------------------------
# pdfium metin akışı referansı
# --------------------------------------------------------------------------
def stream_ranks(pdf_page, leaves, page_width, page_height):
    """pdfium sayfası için {id(yaprak): medyan karakter indeksi}. Her karakter
    merkezini içeren EN KÜÇÜK yaprağa yazılır; en az MIN_STREAM_CHARS karakter
    alan yapraklar sayılır. Sayfa boyutu docling'inkinden >2 punto farklıysa
    (döndürülmüş/kırpılmış sayfa) koordinatlar eşlenemez: None."""
    w, h = pdf_page.get_size()
    if abs(w - page_width) > 2 or abs(h - page_height) > 2:
        return None
    tp = pdf_page.get_textpage()
    try:
        per: dict = {id(i): [] for i in leaves}
        for ci in range(tp.count_chars()):
            left, bottom, right, top = tp.get_charbox(ci)
            cx, cy = (left + right) / 2, h - (bottom + top) / 2
            best, best_area = None, float("inf")
            for i in leaves:
                if i["l"] - 1 <= cx <= i["r"] + 1 and i["t"] - 1 <= cy <= i["b"] + 1:
                    area = (i["r"] - i["l"]) * (i["b"] - i["t"])
                    if area < best_area:
                        best, best_area = i, area
            if best is not None:
                per[id(best)].append(ci)
        return {k: statistics.median(v) for k, v in per.items() if len(v) >= MIN_STREAM_CHARS}
    finally:
        tp.close()


# --------------------------------------------------------------------------
# DoclingDocument yapıştırıcısı
# --------------------------------------------------------------------------
def _label(node) -> str:
    lab = getattr(node, "label", "")
    return str(getattr(lab, "value", lab)).split(".")[-1].lower()


def _refkey(ref):
    return getattr(ref, "cref", None) or id(ref)


def extract_leaves(doc):
    """doc.body çocuklarının yaprakları, docling sırasıyla. Her biri bir
    'unit' (body çocuğunun indeksi) taşır. OPAQUE etiketlerin içine inilmez.
    'text' TAM metindir (prototip 80 karaktere kısaltıyordu; yalnız sigorta
    karşılaştırmasında kullanılır, karar vermede değil)."""
    out = []
    for ui, ref in enumerate(doc.body.children):

        def walk(x, ui=ui):
            provs = getattr(x, "prov", None) or []
            lab = _label(x)
            if provs:
                p = provs[0]
                h = doc.pages[p.page_no].size.height
                bb = p.bbox.to_top_left_origin(h)
                out.append(
                    dict(
                        unit=ui,
                        page=p.page_no,
                        label=lab,
                        l=bb.l,
                        r=bb.r,
                        t=min(bb.t, bb.b),
                        b=max(bb.t, bb.b),
                        text=getattr(x, "text", "") or "",
                        w=doc.pages[p.page_no].size.width,
                        h=h,
                    )
                )
            if lab not in OPAQUE:
                for c in getattr(x, "children", None) or []:
                    walk(c.resolve(doc))

        walk(ref.resolve(doc))
    return out


def _page_texts(leaves):
    """{sayfa: Counter(metin)} — sigorta için sayfa başına metin çoklu kümesi."""
    out: dict = {}
    for leaf in leaves:
        out.setdefault(leaf["page"], Counter())[leaf["text"]] += 1
    return out


def _verify(doc, refs_before, texts_before) -> bool:
    """Sigorta: çocuk kümesi aynı ve her sayfanın metin çoklu kümesi aynı."""
    if len(doc.body.children) != len(refs_before):
        return False
    if {_refkey(r) for r in doc.body.children} != {_refkey(r) for r in refs_before}:
        return False
    return _page_texts(extract_leaves(doc)) == texts_before


def _repair(doc, stream_for_page):
    """Çekirdek: stream_for_page(page_no, leaves, w, h) -> {id: sıra}|None.
    Döndürür (onarılan_sayfalar, şüpheli_sayfalar, bilgiler)."""
    refs = list(doc.body.children)
    leaves = extract_leaves(doc)

    # Unit = body child; children without provenance (captions, ...) travel
    # with the previous unit so they stay next to what they belong to.
    has_leaf = {leaf["unit"] for leaf in leaves}
    groups: dict[int, list] = {}
    unit_ids: list[int] = []
    prefix: list = []
    last = None
    for ui, ref in enumerate(refs):
        if ui in has_leaf:
            groups[ui] = [ref]
            unit_ids.append(ui)
            last = ui
        elif last is None:
            prefix.append(ref)
        else:
            groups[last].append(ref)

    # A unit's page is its first leaf's page; a unit spanning pages poisons
    # every page it touches (no sound way to move it).
    upage: dict[int, int] = {}
    poisoned: set[int] = set()
    for leaf in leaves:
        u = leaf["unit"]
        if u not in upage:
            upage[u] = leaf["page"]
        elif upage[u] != leaf["page"]:
            poisoned.add(upage[u])
            poisoned.add(leaf["page"])
    furniture_units = {leaf["unit"] for leaf in leaves if leaf["label"] in FURNITURE}

    infos: dict[int, dict] = {}
    plans: dict[int, list[int]] = {}
    for pg in sorted({upage[u] for u in unit_ids}):
        page_leaves = [leaf for leaf in leaves if leaf["page"] == pg and leaf["label"] not in FURNITURE]
        if not page_leaves:
            continue
        pw, ph = page_leaves[0]["w"], page_leaves[0]["h"]
        info, order = plan_page(page_leaves, lambda: stream_for_page(pg, page_leaves, pw, ph), pw)
        if pg in poisoned and order is not None:
            info["reason"], order = "multipage-unit", None
        infos[pg] = info
        if order is not None:
            plans[pg] = order

    repaired: list[int] = []
    texts_before = _page_texts(leaves)
    sequence = list(unit_ids)  # current unit order (furniture slots included)
    for pg, order in sorted(plans.items()):
        movable = set(order)
        slots = [k for k, u in enumerate(sequence) if u in movable and u not in furniture_units]
        # The page's movable units must fill exactly their own slots, and
        # nothing from another page may sit between them (furniture may).
        ok = len(slots) == len(order)
        if ok:
            ok = all(upage[sequence[k]] == pg for k in range(slots[0], slots[-1] + 1))
        if not ok:
            infos[pg]["reason"] = "slots-mismatch"
            continue
        trial = list(sequence)
        for k, u in zip(slots, order):
            trial[k] = u
        flat = list(prefix)
        for u in trial:
            flat.extend(groups[u])
        previous = list(doc.body.children)
        doc.body.children[:] = flat
        try:
            fine = _verify(doc, refs, texts_before)
        except Exception:  # noqa: BLE001 — a failing check is a failed check
            fine = False
        if not fine:
            doc.body.children[:] = previous
            infos[pg]["reason"] = "fuse-failed"
            continue
        sequence = trial
        repaired.append(pg)

    suspicious = [pg for pg, info in sorted(infos.items()) if is_suspicious(info)]
    return sorted(repaired), suspicious, infos


def repair_reading_order(doc, pdf_path) -> tuple[list[int], list[int]]:
    """doc.body.children'ı yerinde onarır. Döndürür (onarılan_sayfalar,
    şüpheli_sayfalar). `pdf_path`: docling'in okuduğu PDF (TeX onarımlı kopya
    olabilir) — sayfa numaraları docling'inkilerle aynıdır."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:

        def stream_for_page(pg, page_leaves, pw, ph):
            page = pdf[pg - 1]
            try:
                return stream_ranks(page, page_leaves, pw, ph)
            finally:
                page.close()

        repaired, suspicious, _ = _repair(doc, stream_for_page)
    finally:
        pdf.close()
    return repaired, suspicious


if __name__ == "__main__":  # pragma: no cover
    print("kütüphane modülü: python ingest/reading_order_test.py", file=sys.stderr)
