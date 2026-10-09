# -*- coding: utf-8 -*-
"""Formül kırpımı: docling'in CodeFormulaVlmModel'ine giden kırpımı "adaptive3" ile üretir.

Stok docling kırpımı formül kutusunu %18 her yönde büyütür (`expand_by_scale(0.18, 0.18)`):
bu, komşu satırları/denklem numarasını kırpıma sokar (CodeFormulaV2'yi şaşırtır, döngüye iter,
2-3 kat yavaşlatır) ve ayrıca docling kutusu formülden küçükse parçalarını keser. adaptive3:

  * docling kutusu asla küçülmez;
  * kutudan taşan formül parçalarına (pdfium karakterleri + sayfa görüntüsündeki kutuya bitişik
    koyu bileşenler: kesir çizgisi, büyük parantez, payda, matris sütunu) doğru büyür;
  * kutunun dışındaki düzyazı satırları, sağ yandaki "(5.29)" denklem numarası ve kenar
    etiketleri büyümeyi ENGELLER;
  * kenar payı <= 3.5 pt, kutunun dışındaki her karakterin 0.5 pt önünde durur.

Geometri bench/formula/crop_experiment.py'deki adaptive_box_v3'ün birebir kopyasıdır (yalnız
görüntü ölçeği parametre oldu). Bağlama install() ile yapılır (formula_early_stop.py gibi):
CodeFormulaVlmModel.prepare_element sarılır; herhangi bir uyuşmazlıkta stok kırpım kullanılır,
dönüşüm asla bozulmaz.

VC_FORMULA_CROP=adaptive3 (varsayılan) | stock.   VC_FORMULA_RENDER=pdfium (varsayılan) | docling:
kırpımın çizileceği sayfa görüntüsü. docling'in kendi çizimi bazı MathType simge yazı tiplerinde glifleri
(ör. "=") çizmiyor (Likharev); pypdfium2 çiziyor. İkisi birbirinden bağımsızdır.   VC_FORMULA_CROP_DEBUG=<klasör>: pipeline'ın modele
gönderdiği kırpımları (+ stok karşılığını ve kutuları) oraya yazar (varsayılan kapalı).
"""
from __future__ import annotations

import json
import os
import re
import statistics
import sys
from pathlib import Path
from typing import Any

IMAGES_SCALE = 1.67  # CodeFormulaVlmModel.images_scale
STOCK_EXPANSION = 0.18  # CodeFormulaVlmModel.expansion_factor
MARGIN_PT = 3.5
EQ_RE = re.compile(r"^\(?\s*\d+(?:[.\-]\d+)*[a-z]?\s*\)?$")

V2_PROSE_GAP = 1.3  # satır içi bölme: komşu karakterler arası boşluk > bu * satır medyan yüksekliği -> ayrı parça
V2_VERT_ATTACH = 0.5  # (i) dikey ekleme: kutuya boşluk < bu * formül karakter medyan yüksekliği
V2_HORIZ_ATTACH = 2.0  # (ii) yatay ekleme: kutuya boşluk < bu * medyan yükseklik
V2_PIX_GAP = 0.12  # piksel büyütmede kopuk sayılmayan DÜŞEY boşluk (* medyan yükseklik)
V2_PIX_GAP_X = 0.6  # ... YATAY boşluk (sonda kalan nokta/virgül, ince parantez)
V2_PIX_REACH = 1.2  # piksel büyütmenin kutudan en çok uzaklaşabileceği (* medyan yükseklik)


def _v2_segments(chars):
    """Karakterleri yazı dizilerine (parçalara) böler: iki karakter, dikey aralıkları küçüğünün >= %50'si
    kadar örtüşüyor ve yatay boşluk < V2_PROSE_GAP * (büyük yükseklik) ise bağlıdır (birleşik bileşenler).
    Sözcük boşluğu (~0.4-0.75 h) bağlar; matris sütunu / ayrık yazı (> 1.3 h) bağlamaz.
    Dönüş: [(parça karakterleri, medyan yükseklik)]."""
    n = len(chars)
    order = sorted(range(n), key=lambda i: chars[i][1])
    par = list(range(n))

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x

    maxgap = 0.0
    for c in chars:
        maxgap = max(maxgap, V2_PROSE_GAP * (c[4] - c[2]))
    for a in range(n):
        ca = chars[order[a]]
        for b in range(a + 1, n):
            cb_ = chars[order[b]]
            if cb_[1] - ca[3] > maxgap and cb_[1] - ca[1] > 3 * maxgap:
                break
            ha, hb = ca[4] - ca[2], cb_[4] - cb_[2]
            gap = max(cb_[1] - ca[3], ca[1] - cb_[3], 0.0)
            if gap >= V2_PROSE_GAP * max(ha, hb):
                continue
            ov = min(ca[4], cb_[4]) - max(ca[2], cb_[2])
            if ov >= 0.5 * min(ha, hb):
                par[find(order[a])] = find(order[b])
    comps: dict[int, list] = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(chars[i])
    return [(cs, statistics.median([c[4] - c[2] for c in cs])) for cs in comps.values()]


V2_MATH_WORDS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "coth", "log", "exp", "lim", "max", "min", "det", "ln",
    "sup", "inf", "arg", "mod", "div", "rot", "sgn", "erf", "dim", "ker", "curl", "grad", "diag", "span", "rank", "tr",
    "arcsin", "arccos", "arctan", "limsup", "liminf", "var", "cov", "const", "sign", "real", "imag",
}


def _v2_is_prose(seg):
    """Sözcüklerden oluşan parça: >=4 ardışık küçük harf ya da >=2 ayrı >=3 harflik koşu;
    sin/cos/lim... gibi matematik işlev adları sayılmaz."""
    cs = sorted(seg, key=lambda c: c[1])
    runs, cur = [], []
    for c in cs:
        if c[0].isalpha() and c[0].islower() and c[0].isascii():
            cur.append(c[0])
        else:
            if cur:
                runs.append("".join(cur))
            cur = []
    if cur:
        runs.append("".join(cur))
    runs = [len(r) for r in runs if r not in V2_MATH_WORDS]
    denom = sum(1 for c in cs if not c[0].isascii() or c[0].isalpha())  # rakam/parantez/noktalama sayılmaz
    if sum(r for r in runs if r >= 3) < 0.5 * denom:  # satırın en az yarısı sözcük harfi olmalı (satır içi formül ağırlıklıysa düzyazı değil)
        return False
    return any(r >= 4 for r in runs) or sum(1 for r in runs if r >= 3) >= 2


def _v2_prose_pieces(chars):
    """Düzyazı satır parçaları: bağlı bileşenler (_v2_segments) satırlara ayrılır (satır merkezi farkı
    < 0.5 h), her satır soldan sağa sıralanıp _v2_is_prose ile sınanır. Dönüş: [(karakterler, medyan h)]."""
    out = []
    for comp, mh in _v2_segments(chars):
        lines: list[list] = []
        for c in sorted(comp, key=lambda c: -(c[2] + c[4])):
            cy = (c[2] + c[4]) / 2
            for ln in lines:
                if abs(cy - statistics.mean((x[2] + x[4]) / 2 for x in ln)) < 0.5 * mh:
                    ln.append(c)
                    break
            else:
                lines.append([c])
        for ln in lines:
            if len(ln) >= 4 and _v2_is_prose(ln):
                out.append((ln, statistics.median([c[4] - c[2] for c in ln])))
    return out


def find_eq_number_v2(chars, bbox, region):
    """find_eq_number + matris girdisi ("0 0", "1") gibi yalın rakamları numara saymayan süzgeç:
    kutu ya formül kutusunun sağında ya da parantez/nokta/tire içermeli."""
    eq = find_eq_number(chars, bbox, region)
    if not eq.get("found"):
        return eq
    keep = []
    for bx in eq["boxes"]:
        txt = "".join(c[0] for c in sorted(chars, key=lambda c: c[1]) if bx[0] - 0.3 <= (c[1] + c[3]) / 2 <= bx[2] + 0.3 and bx[1] - 0.3 <= (c[2] + c[4]) / 2 <= bx[3] + 0.3)
        if bx[0] >= bbox[2] - 1 or re.search(r"[().\-]", txt):
            keep.append(bx)
    if not keep:
        return {"found": False}
    return {**eq, "boxes": keep}


def adaptive_box_v3(bbox, chars, page_wh, margin: float, page_img=None, eq: dict | None = None, scale: float | None = None, info: dict | None = None):
    """v1 + v2'nin yalnız BÜYÜTME adımı. docling kutusu asla küçültülmez (v2'nin düzyazı/numara
    çıkarma adımı pdfium karakter kutuları güvenilmez olduğunda kutuyu çökertiyordu). Kutunun dışındaki
    karakterler/pikseller büyütmeye girer; yalnız dışarıdaki düzyazı satırları ve sağ yan denklem numarası
    büyümeyi ENGELLER (kutunun içindekine dokunulmaz). Sonra v1 kenar payı (<= margin pt, dışarıdaki
    her karakterin 0.5 pt önünde durur)."""
    import numpy as np
    from docling_core.types.doc import BoundingBox, CoordOrigin

    W, H = page_wh
    l, b, r, t = bbox
    own = [c for c in chars if l <= (c[1] + c[3]) / 2 <= r and b <= (c[2] + c[4]) / 2 <= t]
    outside = [c for c in chars if not (l <= (c[1] + c[3]) / 2 <= r and b <= (c[2] + c[4]) / 2 <= t)]
    hs = [c[4] - c[2] for c in own]
    h = max(statistics.median(hs) if hs else (t - b), 3.0)
    excl_ids = set()
    if outside:
        for seg, _mh in _v2_prose_pieces(outside):
            # "ntcosθt" gibi kısa/yunanca-matematik satırlar düzyazı değil: uzun ve matematik simgesiz olmalı
            if len(seg) >= 10 and not any(("Ͱ" <= c[0] <= "Ͽ") or ("∀" <= c[0] <= "⋿") or c[0] == "−" for c in seg):
                excl_ids.update(id(c) for c in seg)
        # parantezli denklem numarası parçaları ("(7.4)") da engellenir
        for comp, _mh in _v2_segments(outside):
            if re.match(r"^\(\d+(?:[.\-]\d+)*[a-z]?\)$", "".join(c[0] for c in sorted(comp, key=lambda c: c[1]))):
                excl_ids.update(id(c) for c in comp)
    if eq and eq.get("found"):
        for el, eb, er, et in eq["boxes"]:
            for c in outside:
                cx, cy = (c[1] + c[3]) / 2, (c[2] + c[4]) / 2
                if el - 0.5 <= cx <= er + 0.5 and eb - 0.5 <= cy <= et + 0.5:
                    excl_ids.add(id(c))
    cand = [c for c in outside if id(c) not in excl_ids]
    L, B, R, T = l, b, r, t
    dx = 0.3 * h
    for _ in range(6):
        grown = False
        for c in cand:
            cl, cb, cr, ct = c[1:5]
            cx, cy = (cl + cr) / 2, (cb + ct) / 2
            vgap = max(B - ct, cb - T, 0.0)
            hgap = max(L - cr, cl - R, 0.0)
            ok = (L - dx <= cx <= R + dx and vgap < V2_VERT_ATTACH * h) or (cb < T and ct > B and hgap < V2_HORIZ_ATTACH * h)
            if ok and (cl < L or cr > R or cb < B or ct > T):
                L, B, R, T = min(L, cl), min(B, cb), max(R, cr), max(T, ct)
                grown = True
        if page_img is not None:
            from scipy import ndimage

            S = scale or (page_img.width / W if W else IMAGES_SCALE)  # piksel/pt
            reach = V2_PIX_REACH * h
            x0, x1 = max(0, int((L - reach) * S)), min(page_img.width, int((R + reach) * S) + 1)
            y0, y1 = max(0, int((H - T - reach) * S)), min(page_img.height, int((H - B + reach) * S) + 1)
            if x1 > x0 and y1 > y0:
                g = np.asarray(page_img.crop((x0, y0, x1, y1)).convert("L"))
                dark = g < 160
                for c in outside:  # engellenen (düzyazı/numara) karakterlerin pikselleri silinir
                    if id(c) in excl_ids:
                        xa, xb = int((c[1] - 1.2) * S) - x0, int((c[3] + 1.2) * S) - x0 + 1
                        ya, yb = int((H - c[4] - 1.2) * S) - y0, int((H - c[2] + 1.2) * S) - y0 + 1
                        dark[max(ya, 0) : max(yb, 0), max(xa, 0) : max(xb, 0)] = False
                gv = max(1, int(round(V2_PIX_GAP * h * S)))
                gh = max(1, int(round(V2_PIX_GAP_X * h * S)))
                dil = ndimage.binary_dilation(dark, structure=np.ones((2 * gv + 1, 2 * gh + 1), bool))
                lab, n = ndimage.label(dil)
                bx0, bx1 = int(L * S) - x0, int(R * S) - x0
                by0, by1 = int((H - T) * S) - y0, int((H - B) * S) - y0
                sub = lab[max(by0, 0) : max(by1, 0) + 1, max(bx0, 0) : max(bx1, 0) + 1]
                for i in set(np.unique(sub[sub > 0]).tolist()):
                    ys, xs = np.nonzero((lab == i) & dark)
                    if xs.size == 0:
                        continue
                    nl, nr = (x0 + xs.min()) / S, (x0 + xs.max() + 1) / S
                    nt, nb = H - (y0 + ys.min()) / S, H - (y0 + ys.max() + 1) / S
                    nl, nr = max(nl, L - reach), min(nr, R + reach)
                    nb, nt = max(nb, B - reach), min(nt, T + reach)
                    if nl < L - 0.01 or nr > R + 0.01 or nb < B - 0.01 or nt > T + 0.01:
                        L, R, B, T = min(L, nl), max(R, nr), min(B, nb), max(T, nt)
                        grown = True
        if not grown:
            break
    if info is not None:
        info["grown"] = (L, B, R, T) != (l, b, r, t)
    top = bot = left = right = margin
    for ch, cl, cb, cr, ct in chars:
        cx, cy = (cl + cr) / 2, (cb + ct) / 2
        if L <= cx <= R and B <= cy <= T:
            continue
        if cy > T and cr > L - margin and cl < R + margin:
            top = min(top, max(0.0, cb - T - 0.5))
        elif cy < B and cr > L - margin and cl < R + margin:
            bot = min(bot, max(0.0, B - ct - 0.5))
        if ct > B and cb < T:
            if cx > R:
                right = min(right, max(0.0, cl - R - 0.5))
            elif cx < L:
                left = min(left, max(0.0, L - cr - 0.5))
    return BoundingBox(
        l=max(0.0, L - left), r=min(W, R + right), b=max(0.0, B - bot), t=min(H, T + top), coord_origin=CoordOrigin.BOTTOMLEFT
    )


def find_eq_number(chars, bbox, region):
    """Formülle aynı satırdaki denklem numarası ("(5.29)", "3.12", "(4a)").
    `region` (sol,alt,sağ,üst): stok kırpımı. Dönüş: {found, text, boxes, inside_formula}."""
    l, b, r, t = bbox
    rl, rb, rr, rt = region
    cand = []
    for c in chars:
        cx, cy = (c[1] + c[3]) / 2, (c[2] + c[4]) / 2
        if rl <= cx <= rr and rb <= cy <= rt and b <= cy <= t:
            cand.append(c)
    if not cand:
        return {"found": False}
    cand.sort(key=lambda c: -(c[2] + c[4]))
    lines: list[list] = []  # [satır merkezi, en büyük karakter yüksekliği, karakterler]
    for c in cand:
        cy, h = (c[2] + c[4]) / 2, c[4] - c[2]
        if lines and abs(cy - lines[-1][0]) < 0.5 * max(h, lines[-1][1], 1.0):
            lines[-1][1] = max(lines[-1][1], h)
            lines[-1][2].append(c)
        else:
            lines.append([cy, h, [c]])
    found, boxes, texts, inside = False, [], [], False
    for _cy, _h, cs in lines:
        cs.sort(key=lambda c: c[1])
        med_h = statistics.median([c[4] - c[2] for c in cs])
        groups: list[list] = [[cs[0]]]
        for prev, cur in zip(cs, cs[1:]):
            if cur[1] - prev[3] > 1.5 * med_h:
                groups.append([])
            groups[-1].append(cur)
        # en sağdaki numaraya benzeyen küme (sağında kenar etiketi olabilir: "(5.29) magnetic")
        for gi in range(len(groups) - 1, -1, -1):
            last = groups[gi]
            text = "".join(c[0] for c in last)
            if EQ_RE.match(text) and (gi > 0 or last[0][1] >= r - 1):
                break
        else:
            continue
        found = True
        texts.append(text)
        boxes.append([min(c[1] for c in last), min(c[2] for c in last), max(c[3] for c in last), max(c[4] for c in last)])
        inside = inside or last[0][1] < r - 1
    return {"found": found, "text": " ".join(texts), "boxes": boxes, "inside_formula": inside} if found else {"found": False}



# --------------------------------------------------------------------------- üretim bağlaması
STATS: dict[str, Any] = {}
_INSTALLED = [False]
_WARNED = [False]
_PDF: dict[str, Any] = {"path": None, "doc": None}  # tek belgelik pdfium tutamağı
_CHARS: dict[tuple[str, int], dict | None] = {}  # (pdf, sayfa) -> {"chars", "rotation"}
_DEBUG_SEQ = [0]
_RENDER: dict[str, Any] = {"key": None, "img": None}  # son pdfium sayfa çizimi


def mode() -> str:
    m = os.environ.get("VC_FORMULA_CROP", "adaptive3").strip().lower()
    return "stock" if m in ("stock", "0", "off", "") else "adaptive3"


def render_mode() -> str:
    m = os.environ.get("VC_FORMULA_RENDER", "pdfium").strip().lower()
    return "docling" if m in ("docling", "0", "off", "stock") else "pdfium"


def reset_stats() -> None:
    STATS.clear()
    STATS.update(mode=mode(), render_mode=render_mode(), render=0, cropped=0, grown=0, fallbacks=0, render_fallbacks=0, eq_blocked=0)
    _RENDER.update(key=None, img=None)
    _close_pdf()
    _CHARS.clear()
    _DEBUG_SEQ[0] = 0


def snapshot() -> dict[str, Any]:
    return dict(STATS)


def _warn_once(msg: str) -> None:
    if not _WARNED[0]:
        _WARNED[0] = True
        print(f"formula_crop: {msg}; stok kırpım kullanılıyor", file=sys.stderr)


def _close_pdf() -> None:
    doc = _PDF.get("doc")
    _PDF.update(path=None, doc=None)
    if doc is not None:
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass


def extract_page_chars(pdf_path, page_no: int, key_id: str | None = None) -> dict | None:
    """pypdfium2 karakter kutuları: PDF noktası, sol-alt orijin, kırpma kutusu başa alınmış (docling
    sayfa koordinatlarıyla aynı). page_no: mutlak 1 tabanlı sayfa (docling page_no; page_range
    seçimi sayfa numarasını değiştirmez). pdf_path: dosya yolu, bytes veya BytesIO; key_id belge
    kimliği (yoksa yol). Sayfa/belge başına önbellekli."""
    ident = key_id or str(pdf_path)
    key = (ident, page_no)
    if key in _CHARS:
        return _CHARS[key]
    import pypdfium2 as pdfium

    if _PDF["path"] != ident:
        _close_pdf()
        _CHARS.clear()
        src = pdf_path.getvalue() if hasattr(pdf_path, "getvalue") else pdf_path
        _PDF.update(path=ident, doc=pdfium.PdfDocument(src))
    doc = _PDF["doc"]
    res = None
    if 1 <= page_no <= len(doc):
        pg = doc[page_no - 1]
        cb = pg.get_cropbox()
        tp = pg.get_textpage()
        n = tp.count_chars()
        txt = tp.get_text_range(0, n) if n else ""
        exact = len(txt) == n
        chars = []
        for i in range(n):
            l, b, r, t = tp.get_charbox(i)
            ch = txt[i] if exact else tp.get_text_range(i, 1)
            if not ch or ch.isspace() or r <= l or t <= b:
                continue
            chars.append([ch, round(l - cb[0], 2), round(b - cb[1], 2), round(r - cb[0], 2), round(t - cb[1], 2)])
        res = {"chars": chars, "rotation": pg.get_rotation()}
    _CHARS[key] = res
    return res


def stock_region(bbox, factor: float = STOCK_EXPANSION):
    """BoundingBox.expand_by_scale(f, f) ile aynı: her kenar genişlik/yükseklik * f kadar uzar
    (sol, alt, sağ, üst; sol-alt orijin). Yalnız numara aramasının bölgesi olarak kullanılır."""
    l, b, r, t = bbox
    return (l - (r - l) * factor, b - (t - b) * factor, r + (r - l) * factor, t + (t - b) * factor)


def crop_formula(page_img, bbox, chars, page_wh, scale: float | None = None):
    """Saf işlev: (kırpım PIL görüntüsü, bilgi). bbox: sol-alt orijin (l, b, r, t) PDF noktası."""
    sb = stock_region(bbox)
    eq = find_eq_number_v2(chars, bbox, sb)
    info: dict = {}
    box = adaptive_box_v3(bbox, chars, page_wh, MARGIN_PT, page_img, eq, scale, info)
    S = scale or (page_img.width / page_wh[0])
    tl = box.to_top_left_origin(page_height=page_wh[1]).scaled(scale=S)
    info["eq"] = bool(eq.get("found"))
    info["box"] = [round(box.l, 2), round(box.b, 2), round(box.r, 2), round(box.t, 2)]
    return page_img.crop(tl.as_tuple()), info


def _debug_dir() -> Path | None:
    d = os.environ.get("VC_FORMULA_CROP_DEBUG", "").strip()
    return Path(d) if d else None


def _pdfium_page_image(src, ident: str, page_no: int, scale: float):
    """Sayfayı pypdfium2 ile RGB olarak çizer (docling sayfa görüntüsüyle aynı boyut/ölçek; docling
    get_page_image(...).convert("RGB") verir). Docling'in kendi çizimi bazı MathType simge yazı
    tiplerinde glifleri (ör. "=") ÇİZMİYOR; pdfium çiziyor. Belge/sayfa başına önbellekli (tek sayfa)."""
    key = (ident, page_no, round(scale, 4))
    if _RENDER["key"] == key:
        return _RENDER["img"]
    import pypdfium2 as pdfium

    if _PDF["path"] != ident:
        _close_pdf()
        _CHARS.clear()
        _PDF.update(path=ident, doc=pdfium.PdfDocument(src.getvalue() if hasattr(src, "getvalue") else src))
    pg = _PDF["doc"][page_no - 1]
    img = pg.render(scale=scale, rotation=0, may_draw_forms=False, draw_annots=False).to_pil().convert("RGB")
    _RENDER.update(key=key, img=img)
    return img


def _resolve_src(conv_res):
    src = getattr(getattr(conv_res.input, "_backend", None), "path_or_stream", None)
    if isinstance(src, (str, Path)):
        src = str(src)
        return src if os.path.isfile(src) else None
    return src if hasattr(src, "getvalue") else None


def _prepare(orig, self, conv_res, element):
    el = orig(self, conv_res, element)  # stok kırpım (ve yedek)
    cm, rm = STATS.get("mode"), STATS.get("render_mode")
    if el is None or not hasattr(el, "image") or (cm != "adaptive3" and rm != "pdfium"):
        return el
    from docling_core.types.doc import DocItemLabel, TextItem

    if not (isinstance(element, TextItem) and element.label == DocItemLabel.FORMULA and element.prov):
        return el  # kod blokları stok kalır
    info: dict = {}
    try:
        prov = element.prov[0]
        page = conv_res.pages[prov.page_no - conv_res.pages[0].page_no]
        # kaynak PDF: docling girdisinin arka ucu (convert.py ToUnicode-onarımlı geçici dosyayı verir;
        # input.file yalnız dosya adı olabilir). Yol/BytesIO dışı -> stok.
        src = _resolve_src(conv_res)
        if src is None or page.size is None:
            raise RuntimeError("kaynak PDF/sayfa boyutu yok")
        ident = getattr(conv_res.input, "document_hash", None) or str(getattr(conv_res.input, "file", ""))
        scale = float(getattr(self, "images_scale", IMAGES_SCALE))
        W, H = page.size.width, page.size.height
        bb = prov.bbox.to_bottom_left_origin(page_height=H)
        page_img = None
        if rm == "pdfium":
            try:
                page_img = _pdfium_page_image(src, ident, prov.page_no, scale)
                if not (abs(page_img.width - W * scale) <= 2 and abs(page_img.height - H * scale) <= 2):
                    raise RuntimeError(f"pdfium boyutu uyuşmuyor ({page_img.size} != {W * scale:.0f}x{H * scale:.0f})")
                STATS["render"] += 1
            except Exception as err:  # noqa: BLE001
                page_img = None
                STATS["render_fallbacks"] += 1
                _warn_once(f"pdfium çizimi başarısız ({err}); docling sayfa görüntüsü")
        if page_img is None:
            if cm != "adaptive3":
                return el  # stok kırpım + docling çizimi = değişiklik yok
            page_img = page.get_image(scale=scale)
            if page_img is None:
                raise RuntimeError("sayfa görüntüsü yok")
        if cm == "adaptive3":
            pc = extract_page_chars(src, prov.page_no, ident)
            if pc is None or pc["rotation"] or not pc["chars"]:
                raise RuntimeError("sayfa karakterleri yok/döndürülmüş sayfa")
            img, info = crop_formula(page_img, (bb.l, bb.b, bb.r, bb.t), pc["chars"], (W, H), page_img.width / W)
        else:  # stok geometri, pdfium çizimi
            exp = prov.bbox.expand_by_scale(self.expansion_factor, self.expansion_factor)
            img = page_img.crop(exp.to_top_left_origin(page_height=H).scaled(scale=page_img.width / W).as_tuple())
        if img.width < 2 or img.height < 2:
            raise RuntimeError("boş kırpım")
    except Exception as err:  # noqa: BLE001 — hızlandırma/kalite; dönüşümü asla bozmaz
        STATS["fallbacks"] += 1
        _warn_once(f"kırpım üretilemedi ({err})")
        return el
    STATS["cropped"] += 1
    STATS["grown"] += 1 if info.get("grown") else 0
    STATS["eq_blocked"] += 1 if info.get("eq") else 0
    dbg = _debug_dir()
    if dbg is not None:
        try:
            dbg.mkdir(parents=True, exist_ok=True)
            _DEBUG_SEQ[0] += 1
            stem = f"{Path(str(getattr(conv_res.input, 'file', 'doc'))).stem[:40]}_p{prov.page_no}_{_DEBUG_SEQ[0]:03d}"
            img.save(dbg / f"{stem}_{cm if cm == 'adaptive3' else 'pdfium'}.png")
            el.image.save(dbg / f"{stem}_stock.png")
            with open(dbg / "crops.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"id": stem, "page": prov.page_no, "ref": element.self_ref, "bbox": [round(v, 2) for v in (bb.l, bb.b, bb.r, bb.t)], **info}, ensure_ascii=False) + "\n")
        except Exception as err:  # noqa: BLE001
            _warn_once(f"hata ayıklama kırpımı yazılamadı ({err})")
    el.image = img
    return el


def install() -> bool:
    """CodeFormulaVlmModel.prepare_element'i sarar. VC_FORMULA_CROP=stock VE VC_FORMULA_RENDER=docling
    ise kurmaz. Hiçbir sınıf uymazsa False döner (stok kırpım)."""
    if mode() == "stock" and render_mode() == "docling":
        return False
    if _INSTALLED[0]:
        return True
    try:
        from docling.models.stages.code_formula.code_formula_vlm_model import CodeFormulaVlmModel

        orig = CodeFormulaVlmModel.prepare_element

        def prepare_element(self, conv_res, element):
            return _prepare(orig, self, conv_res, element)

        CodeFormulaVlmModel.prepare_element = prepare_element
        _INSTALLED[0] = True
        return True
    except Exception as err:  # noqa: BLE001 — docling iç yapısı farklı olabilir
        _warn_once(f"kurulamadı ({err})")
        return False


def report() -> dict | None:
    """Belge başına sayaçları stderr'e tek JSON satırı olarak yazar; stok/kurulmadıysa None."""
    if not _INSTALLED[0] or (STATS.get("mode") != "adaptive3" and STATS.get("render_mode") != "pdfium"):
        return None
    stats = snapshot()
    _close_pdf()
    print(json.dumps({"formula_crop": stats}), file=sys.stderr)
    return stats


reset_stats()
