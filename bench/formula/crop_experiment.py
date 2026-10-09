# -*- coding: utf-8 -*-
"""Formül kırpımı / döngü deneyi: CodeFormulaV2'yi AYNI formüller üzerinde kontrollü
koşullarla çalıştırıp görüntüden kaynaklanan bozulmayı çözme döngüsünden ayırır.

Alt komutlar (ayrıntı için bench/formula/README.md):

    run      sayfaları bul (docling yerleşimi, önbellekli) + koşulları çöz + results.jsonl
             (--locate-only: yalnızca sayfa/bbox/karakter önbelleğini üret, model yüklenmez)
    summary  koşul başına döngü oranı, token/sn, EOS oranı (+ isteğe bağlı yargılar)
    review   hedef başına kırpım + KaTeX çıktısı + tam/eksik/hatalı/döngü seçim sayfası

Üretimdeki çözme yolu birebir kopyalanır: docling 2.130 StandardPdfPipeline formülleri
`CodeFormulaVlmModel` ile çözer (eski `CodeFormulaModel` DEĞİL): `create_vlm_engine`
(AUTO_INLINE -> Transformers), preset codeformulav2 (bfloat16), sol dolgu, padding=True,
açgözlü, max_new_tokens=2048, 5'erli gruplar. Motoru doğrudan kullanırız; ölçüm için tek
ek, ham davranışı değiştirmeyen bir gözlemci StoppingCriteria'dır (yalnız kaydeder; isteğe
bağlı --cap-after-hit ile döngüye girmiş satırı, tüm denemenin süresini şişirmesin diye,
döngü tespitinden N token sonra keser). ingest/formula_early_stop.py dedektörünü
(periyot 1-32) yalnız gözlem amaçlı kullanır; erken kesme KAPALIDIR.

Koşullar tek değişkenli: genişletme (0.18 stok | 0.05 | adaptif), grup boyutu (5 | 1),
denklem numarası (bırak | beyazla). Beyazlama kırpımı küçültmez, yalnız numaranın
karakter kutusunu beyaza boyar.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import statistics
import sys
import time
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "ingest"))

IMAGES_SCALE = 1.67  # CodeFormulaVlmModel.images_scale
STOCK_EXPANSION = 0.18  # CodeFormulaVlmModel.expansion_factor
STOCK_MAX_NEW_TOKENS = 2048  # CodeFormulaVlmModel.__call__ -> VlmEngineInput.max_new_tokens
STOCK_BATCH = 5  # CodeFormulaVlmModel.elements_batch_size
CACHE_VERSION = 2
EQ_RE = re.compile(r"^\(?\s*\d+(?:[.\-]\d+)*[a-z]?\s*\)?$")
KATEX = "0.16.11"


# --------------------------------------------------------------------------- koşullar
@dataclass(frozen=True)
class Cond:
    name: str
    expansion: object  # 0.18 | 0.05 | "adaptive"
    batch: int
    eqnum: str  # "keep" | "white"
    dtype: str = ""  # "" = --dtype (varsayılan auto = üretimdeki bfloat16); "float32" = fp32 motoru


CONDITIONS = {
    c.name: c
    for c in [
        Cond("stock", STOCK_EXPANSION, STOCK_BATCH, "keep"),
        Cond("exp005", 0.05, STOCK_BATCH, "keep"),
        Cond("adaptive", "adaptive", STOCK_BATCH, "keep"),
        Cond("batch1", STOCK_EXPANSION, 1, "keep"),
        Cond("noeq", STOCK_EXPANSION, STOCK_BATCH, "white"),
        Cond("adaptive_noeq", "adaptive", STOCK_BATCH, "white"),
        # adaptive_box_v2: docling kutusu formülden küçük olabilir -> önce büyüt, düzyazı/numarayı dışla
        Cond("adaptive2", "adaptive2", STOCK_BATCH, "keep"),
        Cond("adaptive2_noeq", "adaptive2", STOCK_BATCH, "white"),
        # adaptive_box_v3: docling kutusu asla küçülmez; yalnız büyütme (düzyazı/numara büyümeyi engeller)
        Cond("adaptive3", "adaptive3", STOCK_BATCH, "keep"),
        Cond("adaptive_noeq_b1", "adaptive", 1, "white"),
        Cond("exp005_noeq_b1", 0.05, 1, "white"),
        # dtype değişkeni: aynı koşul fp32 motorla (üretim bf16; fp32 yalnız deney, GPU'da daha çok VRAM)
        Cond("stock_fp32", STOCK_EXPANSION, STOCK_BATCH, "keep", "float32"),
        Cond("adaptive_noeq_b1_fp32", "adaptive", 1, "white", "float32"),
    ]
}
DEFAULT_CONDS = ["stock", "exp005", "adaptive", "batch1", "noeq", "adaptive_noeq", "adaptive_noeq_b1"]


# --------------------------------------------------------------------------- yardımcılar
def page_key(src: str, page: int) -> str:
    return f"{re.sub(r'[^A-Za-z0-9_.-]+', '_', Path(src).stem)}__p{page}"


def load_dataset(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["looped"]


def find_pdf(root: Path, src: str) -> Path | None:
    hits = sorted(root.glob(f"*/{src}")) or sorted(root.glob(f"**/{src}"))
    return hits[0] if hits else None


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def group_pages(rows: list[dict], flt: str | None) -> tuple[dict, list[dict]]:
    """(src, page) -> [veri satırları]; sayfası bilinmeyenler ayrı döner."""
    pages: dict[tuple[str, int], list[dict]] = {}
    unlocated = []
    for i, r in enumerate(rows):
        r = {**r, "veri_index": i}
        if r.get("page") is None:
            unlocated.append(r)
            continue
        if flt:
            sub, _, pg = flt.partition(":")
            if sub not in r["src"] or (pg and int(pg) != r["page"]):
                continue
        pages.setdefault((r["src"], r["page"]), []).append(r)
    return pages, unlocated


# --------------------------------------------------------------------------- PDF karakterleri / sayfa görüntüsü
def extract_chars(pdf_path: Path, page_no: int) -> dict:
    """pypdfium2 karakter kutuları (PDF noktası, sol-alt orijin, kırpma kutusu başa alınmış)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        pg = pdf[page_no - 1]
        w, h = pg.get_size()
        cb = pg.get_cropbox()
        tp = pg.get_textpage()
        n = tp.count_chars()
        txt = tp.get_text_range(0, n) if n else ""
        exact = len(txt) == n
        out = []
        for i in range(n):
            l, b, r, t = tp.get_charbox(i)
            ch = txt[i] if exact else tp.get_text_range(i, 1)
            if not ch or ch.isspace() or r <= l or t <= b:
                continue
            out.append([ch, round(l - cb[0], 2), round(b - cb[1], 2), round(r - cb[0], 2), round(t - cb[1], 2)])
        return {"size": [w, h], "rotation": pg.get_rotation(), "chars": out}
    finally:
        pdf.close()


def render_page(pdf_path: Path, page_no: int, scale: float = IMAGES_SCALE):
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        return pdf[page_no - 1].render(scale=scale).to_pil().convert("RGB")
    finally:
        pdf.close()


# --------------------------------------------------------------------------- yerleşim (modelsiz)
def locate_pages(todo: list[tuple[str, int, Path, Path]], device: str) -> None:
    """Her (src, sayfa) için docling PDF boru hattını (OCR kapalı, formül/kod zenginleştirme
    KAPALI) çalıştırır ve FORMULA/CODE öğelerini, docling'in kendi kırpımlarıyla birlikte
    önbelleğe yazar. Kırpımlar CodeFormulaVlmModel.prepare_element'ten gelir: modeli
    yüklemeyen bir taklit `CodeFormulaVlmModel` yalnızca gelen görüntüleri yakalar."""
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.models.stages.code_formula.code_formula_vlm_model import CodeFormulaVlmModel
    from docling_core.types.doc import CodeItem

    captured: list[tuple[object, object, int]] = []  # (item, image, batch_no)
    state = {"batch": 0}

    def fake_init(self, enabled, enable_remote_services, artifacts_path, options, accelerator_options):
        self.enabled, self.options, self.engine = enabled, options, None

    def fake_call(self, doc, element_batch):
        state["batch"] += 1
        for el in element_batch:
            captured.append((el.item, el.image.copy(), state["batch"]))
            yield el.item

    saved = (CodeFormulaVlmModel.__init__, CodeFormulaVlmModel.__call__)
    CodeFormulaVlmModel.__init__, CodeFormulaVlmModel.__call__ = fake_init, fake_call
    try:
        opts = PdfPipelineOptions()
        opts.do_ocr = False
        opts.do_table_structure = False
        opts.do_formula_enrichment = True  # yalnız taklit modeli devreye sokar (kırpım yakalama)
        opts.do_code_enrichment = True
        opts.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.CUDA if device == "cuda" else AcceleratorDevice.CPU)
        conv = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
        for src, page, pdf_path, cache_file in todo:
            t0 = time.time()
            captured.clear()
            state["batch"] = 0
            res = conv.convert(str(pdf_path), page_range=(page, page))
            doc = res.document
            psize = doc.pages[page].size
            H = psize.height
            items = []
            for idx, (item, img, bno) in enumerate(captured):
                bb = item.prov[0].bbox.to_bottom_left_origin(page_height=H)
                crop_rel = f"docling_crops/{cache_file.stem}/i{idx}.png"
                (cache_file.parent / crop_rel).parent.mkdir(parents=True, exist_ok=True)
                img.save(cache_file.parent / crop_rel)
                items.append(
                    {
                        "idx": idx,
                        "ref": item.self_ref,
                        "kind": "code" if isinstance(item, CodeItem) else "formula",
                        "label": str(item.label.value if hasattr(item.label, "value") else item.label),
                        "bbox": [round(bb.l, 3), round(bb.b, 3), round(bb.r, 3), round(bb.t, 3)],
                        "docling_crop": crop_rel,
                        "locate_batch": bno,
                    }
                )
            pc = extract_chars(pdf_path, page)
            inside = 0
            for it in items:
                l, b, r, t = it["bbox"]
                n = sum(1 for c in pc["chars"] if l <= (c[1] + c[3]) / 2 <= r and b <= (c[2] + c[4]) / 2 <= t)
                it["chars_inside"] = n
                inside += n
            write_json(
                cache_file,
                {
                    "version": CACHE_VERSION,
                    "src": src,
                    "page": page,
                    "pdf": str(pdf_path),
                    "docling_page_size": [psize.width, psize.height],
                    "pdfium_page_size": pc["size"],
                    "rotation": pc["rotation"],
                    "items": items,
                    "chars": pc["chars"],
                },
            )
            print(f"[locate] {cache_file.stem}: {len(items)} öğe, {inside} karakter bbox içinde, {time.time() - t0:.1f} sn", flush=True)
    finally:
        CodeFormulaVlmModel.__init__, CodeFormulaVlmModel.__call__ = saved


def load_page_cache(cache_dir: Path, key: str) -> dict | None:
    f = cache_dir / f"{key}.json"
    if not f.exists():
        return None
    d = json.loads(f.read_text(encoding="utf-8"))
    return d if d.get("version") == CACHE_VERSION else None


# --------------------------------------------------------------------------- geometri: kırpım kutuları
def stock_box(bbox, scale_factor: float, page_h: float):
    """docling'in kullandığı ifade: BoundingBox.expand_by_scale (sol-alt orijin)."""
    from docling_core.types.doc import BoundingBox, CoordOrigin

    bb = BoundingBox(l=bbox[0], b=bbox[1], r=bbox[2], t=bbox[3], coord_origin=CoordOrigin.BOTTOMLEFT)
    return bb.expand_by_scale(scale_factor, scale_factor)


def adaptive_box(bbox, chars, page_wh, margin: float):
    """Formül kutusu + en çok `margin` pt; komşu metne (üst/alt satır, yan sözcük)
    değmeden durur. Formül kutusunun kendisi asla kesilmez."""
    from docling_core.types.doc import BoundingBox, CoordOrigin

    l, b, r, t = bbox
    top = bot = left = right = margin
    for ch, cl, cb, cr, ct in chars:
        cx, cy = (cl + cr) / 2, (cb + ct) / 2
        if l <= cx <= r and b <= cy <= t:
            continue  # formülün kendi karakteri
        if cy > t and cr > l - margin and cl < r + margin:
            top = min(top, max(0.0, cb - t - 0.5))
        elif cy < b and cr > l - margin and cl < r + margin:
            bot = min(bot, max(0.0, b - ct - 0.5))
        if ct > b and cb < t:  # düşeyde örtüşen (aynı satır)
            if cx > r:
                right = min(right, max(0.0, cl - r - 0.5))
            elif cx < l:
                left = min(left, max(0.0, l - cr - 0.5))
    W, H = page_wh
    return BoundingBox(
        l=max(0.0, l - left), r=min(W, r + right), b=max(0.0, b - bot), t=min(H, t + top), coord_origin=CoordOrigin.BOTTOMLEFT
    )


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


def adaptive_box_v2(bbox, chars, page_wh, margin: float, page_img=None, eq: dict | None = None):
    """Düzeltilmiş adaptif kırpım. docling kutusu bazen formülden KÜÇÜK olduğundan kutu önce
    formüle ait karakterlerle (ve çizimle) BÜYÜTÜLÜR, sonra komşu metne değmeden bir kenar payı
    eklenir.
      a. büyütme: (i) kutunun yatay bandında ve dikey boşluğu < 0.5 h olan karakterler (kesir parçaları,
         üst/alt indisler, limitler); (ii) dikey bandı örtüşen ve yatay boşluğu < 2.0 h olan karakterler
         (matris girdileri, parantez, işleç); (iii) sayfa görüntüsünde kutuya bitişik koyu piksel
         bileşenleri (kesir çizgisi, büyük parantez; boşluk <= 0.12 h, en çok 1.2 h uzağa).
         h = formülün kendi karakterlerinin medyan yüksekliği.
      b. dışlama: sözcüklerden oluşan satır parçaları (düzyazı) ve denklem numarası büyütmeye girmez.
      c. kenar payı <= margin pt: büyütülmüş kutunun dışındaki HER karakterin 0.5 pt önünde durur.
    `eq`: find_eq_number çıktısı (numara karakterleri dışlanır)."""
    import numpy as np
    from docling_core.types.doc import BoundingBox, CoordOrigin

    W, H = page_wh
    l, b, r, t = bbox
    own = [c for c in chars if l <= (c[1] + c[3]) / 2 <= r and b <= (c[2] + c[4]) / 2 <= t]
    excl_ids = set()
    # docling kutusu bazen düzyazı/numara da içerir (örn. "(polarizer with ... ) (6.19)"): uzun sözcük
    # parçaları ve gerçek numara, formülün başka karakteri varsa kutudan ÇIKARILIR.
    removed = []
    if own:
        keep = []
        pieces = _v2_prose_pieces(own)
        for comp, mh in _v2_segments(own):  # parantezli denklem numarası "(7.4)": ayrı parça olarak
            if re.match(r"^\(\d+(?:[.\-]\d+)*[a-z]?\)$", "".join(c[0] for c in sorted(comp, key=lambda c: c[1]))):
                pieces.append((comp, mh))
        piece_ids = set()
        cand_ids = {id(c) for seg, _ in pieces for c in seg}
        for comp, mh in _v2_segments(own):  # "Wave" gibi saf harf sözcükleri de aday say (uzaklık hesabında yok sayılır)
            txt = "".join(c[0] for c in sorted(comp, key=lambda c: c[1]))
            if len(txt) >= 3 and txt.isascii() and txt.isalpha() and txt.lower() not in V2_MATH_WORDS:
                cand_ids |= {id(c) for c in comp}
        rest_all = [c for c in own if id(c) not in cand_ids]
        for seg, mh in pieces:
            ids = {id(c) for c in seg}
            sl, sr = min(c[1] for c in seg), max(c[3] for c in seg)
            gap = min((max(c[1] - sr, sl - c[3], 0.0) for c in rest_all), default=0.0)
            # uzun düzyazı VEYA kısa ama formülden >= 3 h uzak sözcük/numara
            sb_, st_ = min(c[2] for c in seg), max(c[4] for c in seg)
            # kısa parça yalnız bir yanında formül yoksa (kenar etiketi / numara) çıkarılır; ardından formül
            # gelen "for any |x|<1" gibi metin formülün parçasıdır
            row = [c for c in rest_all if min(c[4], st_) - max(c[2], sb_) > 0.3 * (st_ - sb_)]
            free = not any(c[1] >= sr for c in row) or not any(c[3] <= sl for c in row)
            if len(seg) >= 10 or (gap >= 3 * mh and free):
                removed += seg
                piece_ids |= ids
        keep = [c for c in own if id(c) not in piece_ids]
        if piece_ids and keep:
            # düzyazı satırının sözcük kuyruğu ("Re", ayrı parça kalmış): aynı satır bandında, parçaya yakın ve
            # formül gövdesinin satırından >= 1 h dışta olan karakterler
            cys = sorted((c[2] + c[4]) / 2 for c in keep)
            mcy = cys[len(cys) // 2]
            for seg, mh in pieces:
                if id(seg[0]) not in piece_ids:
                    continue
                pb, pt = min(c[2] for c in seg), max(c[4] for c in seg)
                pl, pr_ = min(c[1] for c in seg), max(c[3] for c in seg)
                if pb <= mcy <= pt:
                    continue  # formülün kendi satırındaki parça
                tail = []
                while True:  # zincirleme: eklenen karakter kapsamı büyütür ("Re" + "calling" gibi)
                    new = [c for c in keep if c not in tail and pb <= (c[2] + c[4]) / 2 <= pt and max(c[1] - pr_, pl - c[3], 0.0) < 3 * mh]
                    if not new:
                        break
                    tail += new
                    pl, pr_ = min(pl, *(c[1] for c in new)), max(pr_, *(c[3] for c in new))
                removed += tail
                tail_ids = {id(c) for c in tail}
                keep = [c for c in keep if id(c) not in tail_ids]
        if piece_ids and keep:
            # kenar etiketinin düzyazı olmayan kalıntıları ("2nd and 3rd"): çıkarılan parçanın bulunduğu
            # yandaki, onun sol/sağ sınırından ötedeki tüm karakterler de çıkar
            xs = sorted(c[1] for c in keep)
            med = xs[len(xs) // 2]
            rm_r = [min(c[1] for c in seg) for seg, _ in pieces if id(seg[0]) in piece_ids and min(c[1] for c in seg) > med]
            rm_l = [max(c[3] for c in seg) for seg, _ in pieces if id(seg[0]) in piece_ids and max(c[3] for c in seg) < med]
            if rm_r:
                lim = min(rm_r)
                removed += [c for c in keep if c[1] >= lim]
                keep = [c for c in keep if c[1] < lim]
            if rm_l and keep:
                lim = max(rm_l)
                removed += [c for c in keep if c[3] <= lim]
                keep = [c for c in keep if c[3] > lim]
        if eq and eq.get("found"):
            for c in list(keep):
                cx, cy = (c[1] + c[3]) / 2, (c[2] + c[4]) / 2
                if any(el - 0.5 <= cx <= er + 0.5 and eb - 0.5 <= cy <= et + 0.5 for el, eb, er, et in eq["boxes"]):
                    keep.remove(c)
                    removed.append(c)
        if keep and removed:
            own = keep
            l, b = min(c[1] for c in own), min(c[2] for c in own)
            r, t = max(c[3] for c in own), max(c[4] for c in own)
            excl_ids.update(id(c) for c in removed)
        else:
            removed = []
    hs = [c[4] - c[2] for c in own]
    h = statistics.median(hs) if hs else (t - b)
    h = max(h, 3.0)
    own_ids = {id(c) for c in own}
    outside = [c for c in chars if id(c) not in own_ids and not (not removed and l <= (c[1] + c[3]) / 2 <= r and b <= (c[2] + c[4]) / 2 <= t)]
    if outside:
        for seg, _mh in _v2_prose_pieces(outside):
            excl_ids.update(id(c) for c in seg)
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
            # dışlanan karakterleri beyazla, kutuya bitişik koyu bileşenleri kutuya kat
            from scipy import ndimage

            S = IMAGES_SCALE
            reach = V2_PIX_REACH * h
            x0, x1 = max(0, int((L - reach) * S)), min(page_img.width, int((R + reach) * S) + 1)
            y0, y1 = max(0, int((H - T - reach) * S)), min(page_img.height, int((H - B + reach) * S) + 1)
            if x1 > x0 and y1 > y0:
                g = np.asarray(page_img.crop((x0, y0, x1, y1)).convert("L"))
                dark = g < 160
                # dışlananların kutularını (ve ancak onların) sil; formüle dahil edilebilir karakterlere dokunma
                for c in outside:
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
                ids = set(np.unique(sub[sub > 0]).tolist())
                for i in ids:
                    ys, xs = np.nonzero((lab == i) & dark)
                    if xs.size == 0:
                        continue
                    nl, nr = (x0 + xs.min()) / S, (x0 + xs.max() + 1) / S
                    nt, nb = H - (y0 + ys.min()) / S, H - (y0 + ys.max() + 1) / S
                    nl, nr = max(nl, L - reach), min(nr, R + reach)
                    nb, nt = max(nb, B - reach), min(nt, T + reach)
                    # bileşen, formülle ilgisiz bir dışlanmayan karakteri çekmesin: yalnız yeni kutu genişlemesi
                    if nl < L - 0.01 or nr > R + 0.01 or nb < B - 0.01 or nt > T + 0.01:
                        L, R, B, T = min(L, nl), max(R, nr), min(B, nb), max(T, nt)
                        grown = True
        if not grown:
            break
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


def adaptive_box_v3(bbox, chars, page_wh, margin: float, page_img=None, eq: dict | None = None):
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

            S = IMAGES_SCALE
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


def make_crop(page_img, box, page_h: float, eq: dict | None):
    """docling'le aynı ifade: kutu -> sol-üst orijin -> ölçek -> PIL crop. `eq` verilirse
    numara kutuları kırpımdan ÖNCE beyaza boyanır (kırpım boyutu değişmez)."""
    from PIL import ImageDraw

    img = page_img
    if eq and eq.get("found"):
        img = page_img.copy()
        d = ImageDraw.Draw(img)
        for l, b, r, t in eq["boxes"]:
            d.rectangle([(l - 0.6) * IMAGES_SCALE, (page_h - t - 0.6) * IMAGES_SCALE, (r + 0.6) * IMAGES_SCALE, (page_h - b + 0.6) * IMAGES_SCALE], fill="white")
    tl = box.to_top_left_origin(page_height=page_h).scaled(scale=IMAGES_SCALE)
    return img.crop(tl.as_tuple())


# --------------------------------------------------------------------------- motor / çözme
def load_engine(device: str, dtype: str, threads: int):
    """Üretimle aynı: CodeFormulaVlmOptions.from_preset('codeformulav2') + create_vlm_engine."""
    import torch
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.pipeline_options import CodeFormulaVlmOptions
    from docling.models.inference_engines.vlm import create_vlm_engine

    if device == "cpu":
        torch.set_num_threads(threads)
    opts = CodeFormulaVlmOptions.from_preset("codeformulav2")
    if dtype != "auto":
        from docling.datamodel.vlm_engine_options import VlmEngineType  # noqa: F401

        spec = opts.model_spec.model_copy(deep=True)
        for cfg in spec.engine_overrides.values():
            if "torch_dtype" in cfg.extra_config:
                cfg.extra_config["torch_dtype"] = dtype
        opts = opts.model_copy(update={"model_spec": spec})
    engine = create_vlm_engine(
        options=opts.engine_options,
        model_spec=opts.model_spec,
        enable_remote_services=False,
        artifacts_path=None,
        accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CUDA if device == "cuda" else AcceleratorDevice.CPU),
    )
    inner = getattr(engine, "actual_engine", engine)
    return engine, inner


def make_observer(stop_ids: list[int], cap_after_hit: int):
    """Ham davranışı değiştirmeyen gözlemci. Dedektör yalnız kaydeder; cap_after_hit>0 ise
    döngü tespitinden bu kadar token sonra O satırı keser (süre için, kayıt 'capped_after_loop')."""
    import torch
    from transformers import StoppingCriteria

    import formula_early_stop as fes

    class Observer(StoppingCriteria):
        def __init__(self):
            self.det = None
            self.plen = None
            self.capped: dict[int, int] = {}
            self.last = None

        def __call__(self, input_ids, scores, **kw):
            if self.det is None:
                self.plen = input_ids.shape[1] - 1  # ilk çağrı: istem + 1 üretilmiş token
                self.det = fes.make_detector(self.plen, stop_ids)
            self.last = input_ids
            self.det(input_ids, scores)  # dönüş değeri yok sayılır: yalnız gözlem
            res = torch.zeros(input_ids.shape[0], dtype=torch.bool, device=input_ids.device)
            if cap_after_hit:
                n = input_ids.shape[1] - self.plen
                for i, s in self.det.stop_len.items():
                    if n - s >= cap_after_hit:
                        res[i] = True
                        self.capped.setdefault(i, n)
            return res

    return Observer()


def docling_clean(text: str) -> str:
    """CodeFormulaVlmModel._post_process ile aynı."""
    idx = text.find("<end_of_utterance>")
    if idx == -1:
        idx = text.find("<end_of_utterance")
    if idx != -1:
        text = text[:idx]
    for tok in ("</code>", "</formula>", "<loc_0><loc_0><loc_500><loc_500>"):
        text = text.replace(tok, "")
    return text.lstrip()


def postprocess_loop(text: str) -> dict:
    """ingest/postprocess.py kuralı: {offset, period}; döngü yoksa offset -1."""
    import postprocess as pp

    at = pp.find_degenerate_run(text)
    if at < 0:
        return {"offset": -1, "period": None}
    toks = [m.group(0) for m in pp._LATEX_TOKEN.finditer(text[at:])]
    for g in range(1, pp._MAX_LONG_GROUP + 1):
        if len(toks) > 3 * g and all(toks[i] == toks[i + g] for i in range(min(len(toks) - g, 3 * g))):
            return {"offset": at, "period": g}
    return {"offset": at, "period": None}


def decode_batch(engine, inner, images, labels, max_new, cap_after_hit, device):
    """Bir grubu üretimdeki gibi çözer. Dönüş: (satır sözlükleri, süre sn)."""
    import torch
    from docling.models.inference_engines.vlm import VlmEngineInput

    tok = inner.processor.tokenizer
    eos = [tok.eos_token_id]
    stop_ids = [i for i in {tok.eos_token_id, tok.pad_token_id} if i is not None]
    obs = make_observer(stop_ids, cap_after_hit)
    inputs = [
        VlmEngineInput(
            image=im,
            prompt="<formula>" if lb == "formula" else "<code>",
            temperature=0.0,
            max_new_tokens=max_new,
            extra_generation_config={"skip_special_tokens": False, "custom_stopping_criteria": [obs]},
        )
        for im, lb in zip(images, labels)
    ]
    if device == "cuda":
        torch.cuda.synchronize()
    t0 = time.time()
    outs = engine.predict_batch(inputs)
    if device == "cuda":
        torch.cuda.synchronize()
    secs = time.time() - t0
    ids_all = obs.last[:, obs.plen :].tolist()
    rows = []
    for i, gen in enumerate(ids_all):
        cut = next((k for k, v in enumerate(gen) if v in eos), None)
        if cut is not None:
            n, reason = cut + 1, "eos"
        elif i in obs.capped:
            n, reason = obs.capped[i], "capped_after_loop"
        else:
            n, reason = len(gen), "max_tokens"
        ids = gen[:n]
        raw = tok.decode(ids, skip_special_tokens=False)
        rows.append(
            {
                "token_ids": ids,
                "n_tokens": n,
                "stop_reason": reason,
                "raw": raw,
                "text_skip_special": tok.decode(ids, skip_special_tokens=True),
                "docling_text": docling_clean(raw),
                "engine_text_matches": docling_clean(outs[i].text) == docling_clean(raw),
                "detector": {
                    "hit": obs.det is not None and i in obs.det.stop_len,
                    "period": obs.det.period.get(i) if obs.det else None,
                    "at_token": obs.det.stop_len.get(i) if obs.det else None,
                },
            }
        )
    return rows, secs


# --------------------------------------------------------------------------- hedef eşleme
def _ltoks(s: str) -> list[str]:
    import postprocess as pp

    return [m.group(0) for m in pp._LATEX_TOKEN.finditer(s)]


def match_targets(veri_rows: list[dict], stock: dict[int, dict], items: list[dict]) -> list[dict]:
    """Not'taki `head` ile stok çıktının ilk ~len(head) LaTeX belirteci arasındaki benzerlik
    (difflib oranı). Eşitlikte stok koşuşunda döngüye giren öğe kazanır (+0.1)."""
    formula_idx = [it["idx"] for it in items if it["kind"] == "formula" and it["idx"] in stock]
    scored = []
    for v in veri_rows:
        H = _ltoks(v.get("head") or "")
        sc = {}
        for i in formula_idx:
            O = _ltoks(stock[i]["docling_text"])
            ratio = SequenceMatcher(None, H, O[: len(H) + 2], autojunk=False).ratio() if H else 0.0
            looped = stock[i]["detector"]["hit"] or stock[i]["postprocess"]["offset"] >= 0
            sc[i] = (ratio, looped)
        scored.append((v, H, sc))
    out, taken = [], set()
    for v, H, sc in sorted(scored, key=lambda x: -max((r + 0.1 * lp for r, lp in x[2].values()), default=0)):
        ranked = sorted(sc.items(), key=lambda kv: -(kv[1][0] + 0.1 * kv[1][1] + (0 if kv[0] not in taken else -1)))
        if not ranked:
            out.append({"veri_index": v["veri_index"], "item_idx": None, "score": 0.0, "low_confidence": True, "why": "formül öğesi yok"})
            continue
        best_i, (best_r, best_l) = ranked[0]
        second = ranked[1][1][0] if len(ranked) > 1 else 0.0
        why = []
        if best_r < 0.75:
            why.append(f"benzerlik {best_r:.2f} < 0.75")
        if len(H) < 4:
            why.append(f"head kısa ({len(H)} belirteç)")
        if second > best_r - 0.05 and len(ranked) > 1:
            why.append(f"ikinci aday yakın ({second:.2f})")
        if not best_l:
            why.append("stok koşuşunda döngü yeniden üretilmedi")
        taken.add(best_i)
        out.append(
            {
                "veri_index": v["veri_index"],
                "item_idx": best_i,
                "score": round(best_r, 3),
                "second_score": round(second, 3),
                "looped_in_stock": bool(best_l),
                "head": v.get("head"),
                "low_confidence": bool(why),
                "why": why,
            }
        )
    return sorted(out, key=lambda m: m["veri_index"])


# --------------------------------------------------------------------------- run
def cmd_run(a) -> None:
    out = Path(a.out)
    cache = out / "located"
    rows = load_dataset(Path(a.dataset))
    pages, unlocated = group_pages(rows, a.pages)
    keys = sorted(pages)[: a.limit_pages] if a.limit_pages else sorted(pages)
    conds = [CONDITIONS[c] for c in (a.conditions.split(",") if a.conditions else DEFAULT_CONDS)]
    if conds[0].name != "stock":
        conds = [CONDITIONS["stock"]] + [c for c in conds if c.name != "stock"]
    pdfs = {}
    todo = []
    for src, page in keys:
        p = find_pdf(Path(a.pdf_root), src)
        if p is None:
            print(f"[uyarı] PDF bulunamadı: {src}")
            continue
        pdfs[(src, page)] = p
        if load_page_cache(cache, page_key(src, page)) is None:
            todo.append((src, page, p, cache / f"{page_key(src, page)}.json"))
    if todo:
        locate_pages(todo, a.device)
    if a.locate_only:
        return

    matches_f = out / "matches.json"
    matches = json.loads(matches_f.read_text(encoding="utf-8")) if matches_f.exists() else {}
    matches["_unlocated"] = [{"veri_index": r["veri_index"], "src": r["src"], "head": r.get("head")} for r in unlocated]
    res_f = out / "results.jsonl"
    done_counts: dict[tuple[str, str], int] = {}
    for r in read_jsonl(res_f):
        done_counts[(r["key"], r["cond"])] = done_counts.get((r["key"], r["cond"]), 0) + 1

    engines: dict[str, tuple] = {}

    def engine_for(cond):
        """Koşulun dtype'ına göre motor (tembel yüklenir, önbelleğe alınır)."""
        dt = cond.dtype or a.dtype
        if dt not in engines:
            engines[dt] = load_engine(a.device, dt, a.threads)
            inner_ = engines[dt][1]
            print(f"[motor] {type(inner_).__name__}, cihaz={a.device}, dtype={getattr(inner_.vlm_model, 'dtype', '?')}", flush=True)
        return engines[dt]

    max_new = a.max_new_tokens or STOCK_MAX_NEW_TOKENS
    only = {int(x) for x in a.only_items.split(",")} if a.only_items else None

    for src, page in keys:
        if (src, page) not in pdfs:
            continue
        key = page_key(src, page)
        pc = load_page_cache(cache, key)
        items = [it for it in pc["items"] if only is None or it["idx"] in only]
        if not items:
            continue
        W, H = pc["docling_page_size"]
        page_img = render_page(pdfs[(src, page)], page)
        chars = pc["chars"]
        eqinfo, eqinfo2 = {}, {}
        for it in items:
            sb = stock_box(it["bbox"], STOCK_EXPANSION, H)
            eqinfo[it["idx"]] = find_eq_number(chars, it["bbox"], (sb.l, sb.b, sb.r, sb.t)) if it["kind"] == "formula" else {"found": False}
            eqinfo2[it["idx"]] = find_eq_number_v2(chars, it["bbox"], (sb.l, sb.b, sb.r, sb.t)) if it["kind"] == "formula" else {"found": False}
        crops_dir = out / "crops" / key
        crops_dir.mkdir(parents=True, exist_ok=True)
        stock_out: dict[int, dict] = {}
        for cond in conds:
            if done_counts.get((key, cond.name), 0) >= len(items) and (cond.name != "stock" or key in matches):
                continue  # önceki koşuşta tamamlanmış (devam)
            boxes, images = {}, {}
            for it in items:
                if cond.expansion == "adaptive":
                    box = adaptive_box(it["bbox"], chars, (W, H), a.adaptive_margin)
                elif cond.expansion == "adaptive2":
                    box = adaptive_box_v2(it["bbox"], chars, (W, H), a.adaptive_margin, page_img, eqinfo2[it["idx"]])
                elif cond.expansion == "adaptive3":
                    box = adaptive_box_v3(it["bbox"], chars, (W, H), a.adaptive_margin, page_img, eqinfo2[it["idx"]])
                else:
                    box = stock_box(it["bbox"], float(cond.expansion), H)
                boxes[it["idx"]] = box
                eq = (eqinfo2 if cond.expansion in ("adaptive2", "adaptive3") else eqinfo)[it["idx"]] if cond.eqnum == "white" else None
                im = make_crop(page_img, box, H, eq)
                im.save(crops_dir / f"i{it['idx']}_{cond.name}.png")
                images[it["idx"]] = im
            engine, inner = engine_for(cond)
            batches = [items[i : i + cond.batch] for i in range(0, len(items), cond.batch)]
            t_cond = time.time()
            recs = []
            for b in batches:
                rows_, secs = decode_batch(engine, inner, [images[i["idx"]] for i in b], [i["kind"] for i in b], max_new, a.cap_after_hit, a.device)
                for it, r in zip(b, rows_):
                    r["postprocess"] = postprocess_loop(r["docling_text"])
                    eq = (eqinfo2 if cond.expansion in ("adaptive2", "adaptive3") else eqinfo)[it["idx"]]
                    bx =boxes[it["idx"]]
                    recs.append(
                        {
                            "key": key,
                            "src": src,
                            "page": page,
                            "cond": cond.name,
                            "item_idx": it["idx"],
                            "kind": it["kind"],
                            "crop": f"crops/{key}/i{it['idx']}_{cond.name}.png",
                            "crop_size": list(images[it["idx"]].size),
                            "crop_box_pt": [round(bx.l, 2), round(bx.b, 2), round(bx.r, 2), round(bx.t, 2)],
                            "formula_bbox_pt": it["bbox"],
                            "expansion": cond.expansion,
                            "adaptive_margin_pt": a.adaptive_margin if str(cond.expansion).startswith("adaptive") else None,
                            "batch_size": cond.batch,
                            "batch_members": [i["idx"] for i in b],
                            "batch_seconds": round(secs, 3),
                            "seconds_per_formula": round(secs / len(b), 3),
                            "eqnum": {
                                "found": eq.get("found", False),
                                "text": eq.get("text"),
                                "inside_formula_bbox": eq.get("inside_formula"),
                                "whitened": cond.eqnum == "white" and eq.get("found", False),
                            },
                            "decoding": {"greedy": True, "max_new_tokens": max_new, "cap_after_hit": a.cap_after_hit, "device": a.device, "dtype": str(getattr(inner.vlm_model, "dtype", "?")), "early_stop": False},
                            **r,
                        }
                    )
                with res_f.open("a", encoding="utf-8") as f:
                    for rec in recs[-len(b):]:
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            print(f"[{key}] {cond.name}: {len(items)} öğe, {len(batches)} grup, {time.time() - t_cond:.1f} sn, " f"döngü={sum(1 for r in recs if r['detector']['hit'])}", flush=True)
            if cond.name == "stock":
                stock_out = {r["item_idx"]: r for r in recs}
                targets = match_targets(pages[(src, page)], stock_out, items)
                matches[key] = {"src": src, "page": page, "targets": targets}
                write_json(matches_f, matches)
                for m in targets:
                    print(f"   hedef veri#{m['veri_index']} -> öğe {m['item_idx']} skor={m['score']} " f"{'DÜŞÜK GÜVEN: ' + '; '.join(m['why']) if m['low_confidence'] else 'tamam'}", flush=True)
    write_json(matches_f, matches)


# --------------------------------------------------------------------------- summary
def role_of(matches: dict, key: str, item_idx: int, kind: str) -> str:
    if kind == "code":
        return "filler"
    for m in matches.get(key, {}).get("targets", []):
        if m["item_idx"] == item_idx:
            return "target"
    return "control"


def cmd_summary(a) -> None:
    out = Path(a.out)
    recs = read_jsonl(out / "results.jsonl")
    matches = json.loads((out / "matches.json").read_text(encoding="utf-8")) if (out / "matches.json").exists() else {}
    judg = {}
    if a.judgments:
        judg = {(j["key"], j["item_idx"], j["cond"]): j["verdict"] for j in json.loads(Path(a.judgments).read_text(encoding="utf-8"))["judgments"]}
    by: dict[str, dict[str, list]] = {}
    for r in recs:
        role = role_of(matches, r["key"], r["item_idx"], r["kind"])
        r["role"] = role
        by.setdefault(r["cond"], {}).setdefault(role, []).append(r)
    table = {}

    def stats(rs):
        if not rs:
            return None
        loops = sum(1 for r in rs if r["detector"]["hit"] or r["postprocess"]["offset"] >= 0)
        return {
            "n": len(rs),
            "loop_rate": round(loops / len(rs), 3),
            "loops": loops,
            "tokens_mean": round(statistics.mean(r["n_tokens"] for r in rs), 1),
            "tokens_median": statistics.median(r["n_tokens"] for r in rs),
            "sec_mean": round(statistics.mean(r["seconds_per_formula"] for r in rs), 3),
            "sec_median": round(statistics.median(r["seconds_per_formula"] for r in rs), 3),
            "eos_rate": round(sum(1 for r in rs if r["stop_reason"] == "eos") / len(rs), 3),
            "eq_found_rate": round(sum(1 for r in rs if r["eqnum"]["found"]) / len(rs), 3),
        }

    for cond, roles in by.items():
        table[cond] = {role: stats(rs) for role, rs in roles.items() if role != "filler"}
        if judg:
            tg = [r for r in roles.get("target", []) if (r["key"], r["item_idx"], cond) in judg]
            table[cond]["target_verdicts"] = {v: sum(1 for r in tg if judg[(r["key"], r["item_idx"], cond)] == v) for v in ("tam", "eksik", "hatalı", "döngü")}
    write_json(out / "summary.json", table)
    hdr = f"{'koşul':<18}{'rol':<9}{'n':>5}{'döngü%':>8}{'tok ort':>9}{'tok med':>9}{'sn ort':>8}{'sn med':>8}{'EOS%':>7}{'nu%':>6}"
    print(hdr)
    for cond in [c for c in CONDITIONS if c in table]:
        for role in ("target", "control"):
            s = table[cond].get(role)
            if s:
                print(f"{cond:<18}{role:<9}{s['n']:>5}{100 * s['loop_rate']:>8.1f}{s['tokens_mean']:>9.1f}{s['tokens_median']:>9.0f}{s['sec_mean']:>8.2f}{s['sec_median']:>8.2f}{100 * s['eos_rate']:>7.0f}{100 * s['eq_found_rate']:>6.0f}")
        if "target_verdicts" in table[cond]:
            print(f"{'':<18}yargı: {table[cond]['target_verdicts']}")
    low = [(k, m) for k, v in matches.items() if k != "_unlocated" for m in v["targets"] if m["low_confidence"]]
    print(f"\nhedef eşleme: {sum(len(v['targets']) for k, v in matches.items() if k != '_unlocated')} hedef, {len(low)} düşük güven; " f"sayfası bilinmeyen: {len(matches.get('_unlocated', []))}")


# --------------------------------------------------------------------------- review
REVIEW_JS = r"""
const D = JSON.parse(document.getElementById('data').textContent);
const VERDICTS = ['', 'tam', 'eksik', 'hatalı', 'döngü'];
const state = {};
function wrap(tex){
  tex = tex.trim();
  if (tex.indexOf('&') >= 0 && tex.indexOf('\\begin{') < 0) tex = '\\begin{aligned}' + tex.replace(/\\\\\s*$/, '') + '\\end{aligned}';
  return tex;
}
function render(el, tex){
  const shown = tex.length > 700 ? tex.slice(0, 700) : tex;
  try { katex.render(wrap(shown), el, {displayMode: true, throwOnError: true}); }
  catch (e) { el.textContent = shown; el.classList.add('err'); }
  if (tex.length > 700) { const s = document.createElement('div'); s.className = 'more'; s.textContent = '… +' + (tex.length - 700) + ' karakter'; el.appendChild(s); }
}
function build(){
  const root = document.getElementById('root');
  D.targets.forEach(t => {
    const sec = document.createElement('section');
    sec.innerHTML = '<h2>' + t.title + '</h2><p class="meta">' + t.meta + '</p>';
    const row = document.createElement('div'); row.className = 'row';
    const src = document.createElement('div'); src.className = 'cell src';
    src.innerHTML = '<div class="lab">kaynak kırpım (stok)</div><img src="' + t.stock_crop + '">';
    row.appendChild(src);
    t.groups.forEach(g => {
      const c = document.createElement('div'); c.className = 'cell';
      c.innerHTML = '<div class="lab">' + g.conds.join(', ') + '<br><small>' + g.info + '</small></div><img class="mini" src="' + g.crop + '">';
      const o = document.createElement('div'); o.className = 'out'; render(o, g.text); c.appendChild(o);
      const sel = document.createElement('select');
      VERDICTS.forEach(v => { const op = document.createElement('option'); op.value = v; op.textContent = v || '— seç —'; sel.appendChild(op); });
      const id = g.id; if (!(id in state)) state[id] = '';
      const paint = () => { c.className = 'cell v-' + (state[id] || 'none'); };
      sel.value = state[id]; paint();
      sel.onchange = () => { state[id] = sel.value; paint(); count(); };
      c.appendChild(sel); row.appendChild(c);
    });
    sec.appendChild(row); root.appendChild(sec);
  });
  document.getElementById('save').onclick = save;
  document.getElementById('load').onchange = load;
  count();
}
function count(){ const n = Object.values(state).filter(Boolean).length; document.getElementById('cnt').textContent = n + ' / ' + Object.keys(state).length + ' yargı'; }
function save(){
  const judgments = [];
  D.targets.forEach(t => t.groups.forEach(g => { const v = state[g.id]; if (v) g.members.forEach(m => judgments.push({key: t.key, item_idx: t.item_idx, cond: m, verdict: v, veri_index: t.veri_index})); }));
  const blob = new Blob([JSON.stringify({judgments}, null, 1)], {type: 'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'judgments.json'; a.click();
}
function load(ev){
  const f = ev.target.files[0]; if (!f) return;
  f.text().then(txt => {
    const m = {}; JSON.parse(txt).judgments.forEach(j => m[j.key + '|' + j.item_idx + '|' + j.cond] = j.verdict);
    D.targets.forEach(t => t.groups.forEach(g => { const v = m[t.key + '|' + t.item_idx + '|' + g.members[0]]; if (v) state[g.id] = v; }));
    document.getElementById('root').innerHTML = ''; build();
  });
}
window.addEventListener('load', build);
"""

REVIEW_CSS = """
body{font:14px system-ui,sans-serif;margin:16px;background:#fafafa;color:#111}
h2{margin:24px 0 2px;font-size:16px} .meta{margin:0 0 8px;color:#555;font-size:12px}
.row{display:flex;flex-wrap:wrap;gap:10px} .cell{border:1px solid #ccc;background:#fff;padding:6px;width:330px;border-radius:4px}
.cell.src{background:#eef} .lab{font-weight:600;font-size:12px;margin-bottom:4px} small{font-weight:400;color:#666}
img{max-width:100%;border:1px solid #ddd;background:#fff} img.mini{max-height:70px}
.out{margin:6px 0;max-height:240px;overflow:auto;border-top:1px dashed #ddd} .out.err{font:11px monospace;white-space:pre-wrap;color:#a00}
.more{color:#a00;font-size:11px} select{width:100%}
.cell.v-tam{background:#e6f6e6} .cell.v-eksik{background:#fff3d6} .cell.v-hatalı{background:#fde0e0} .cell.v-döngü{background:#f0e0f8}
.bar{position:sticky;top:0;background:#fffc;padding:6px 0;display:flex;gap:12px;align-items:center}
"""


def cmd_review(a) -> None:
    out = Path(a.out)
    recs = read_jsonl(out / "results.jsonl")
    matches = json.loads((out / "matches.json").read_text(encoding="utf-8"))
    by = {(r["key"], r["item_idx"], r["cond"]): r for r in recs}
    targets = []
    for key, v in sorted(matches.items()):
        if key == "_unlocated":
            continue
        for m in v["targets"]:
            if m["item_idx"] is None:
                continue
            conds = [c for c in CONDITIONS if (key, m["item_idx"], c) in by]
            if "stock" not in conds:
                continue
            groups: dict[str, list[str]] = {}
            for c in conds:
                groups.setdefault(by[(key, m["item_idx"], c)]["docling_text"], []).append(c)
            glist = []
            for text, members in groups.items():
                r0 = by[(key, m["item_idx"], members[0])]
                info = f"{r0['n_tokens']} tok, {r0['stop_reason']}, çözme {r0['seconds_per_formula']} sn"
                if r0["detector"]["hit"]:
                    info += f", DÖNGÜ(p={r0['detector']['period']}@{r0['detector']['at_token']})"
                if r0["eqnum"]["whitened"]:
                    info += ", numara beyazlandı"
                glist.append({"id": f"{key}|{m['item_idx']}|{members[0]}", "conds": members, "members": members, "text": text, "crop": r0["crop"], "info": info})
            targets.append(
                {
                    "key": key,
                    "item_idx": m["item_idx"],
                    "veri_index": m["veri_index"],
                    "title": f"{v['src']} s.{v['page']} öğe {m['item_idx']}",
                    "meta": html.escape(f"eşleme skoru {m['score']}" + (f" — DÜŞÜK GÜVEN: {'; '.join(m['why'])}" if m["low_confidence"] else "") + f" — head: {(m.get('head') or '')[:160]}"),
                    "stock_crop": by[(key, m["item_idx"], "stock")]["crop"],
                    "groups": glist,
                }
            )
    data = json.dumps({"targets": targets}, ensure_ascii=False).replace("</", "<\\/")
    page = f"""<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Formül kırpım incelemesi</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/{KATEX}/katex.min.css">
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/KaTeX/{KATEX}/katex.min.js"></script>
<style>{REVIEW_CSS}</style></head><body>
<div class="bar"><b>Formül kırpım incelemesi</b><span id="cnt"></span><button id="save">Yargıları indir (JSON)</button>
<label>Önceki JSON: <input type="file" id="load" accept=".json"></label></div>
<div id="root"></div>
<script id="data" type="application/json">{data}</script>
<script>{REVIEW_JS}</script></body></html>"""
    (out / "review.html").write_text(page, encoding="utf-8")
    print(f"{out / 'review.html'}: {len(targets)} hedef")


def cmd_debug_v2(a) -> None:
    """Her formül için: sol yarı sayfa üstünde üç kutu (stok kırmızı, adaptive mavi, adaptive2 yeşil),
    sağda üç kırpım yan yana. out/debug_v2/<anahtar>_i<öğe>.png"""
    from PIL import Image, ImageDraw

    out = Path(a.out)
    only = {int(x) for x in a.items.split(",")} if a.items else None
    for f in sorted((out / "located").glob("*.json")):
        pc = json.loads(f.read_text(encoding="utf-8"))
        if a.pages:
            sub, _, pg = a.pages.partition(":")
            if sub not in pc["src"] or (pg and int(pg) != pc["page"]):
                continue
        pdf = find_pdf(Path(a.pdf_root), pc["src"])
        W, H = pc["docling_page_size"]
        page_img = render_page(pdf, pc["page"])
        chars = pc["chars"]
        for it in pc["items"]:
            if it["kind"] != "formula" or (only is not None and it["idx"] not in only):
                continue
            sb = stock_box(it["bbox"], STOCK_EXPANSION, H)
            eq = find_eq_number_v2(chars, it["bbox"], (sb.l, sb.b, sb.r, sb.t))
            boxes = [
                ("stock", sb, (220, 0, 0)),
                ("adaptive", adaptive_box(it["bbox"], chars, (W, H), a.adaptive_margin), (0, 90, 255)),
                ("adaptive2", adaptive_box_v2(it["bbox"], chars, (W, H), a.adaptive_margin, page_img, eq), (0, 160, 0)),
            ]
            ov = page_img.copy()
            d = ImageDraw.Draw(ov)
            ll, bb_, rr, tt = it["bbox"]
            d.rectangle([ll * IMAGES_SCALE, (H - tt) * IMAGES_SCALE, rr * IMAGES_SCALE, (H - bb_) * IMAGES_SCALE], outline=(255, 160, 0), width=1)
            for _n, bx, col in boxes:
                tl = bx.to_top_left_origin(page_height=H).scaled(scale=IMAGES_SCALE)
                d.rectangle(tl.as_tuple(), outline=col, width=2)
            # sayfadan formül çevresi (stok kutusunun 120 pt çevresi)
            cx0, cx1 = max(0, int((sb.l - 60) * IMAGES_SCALE)), min(ov.width, int((sb.r + 60) * IMAGES_SCALE))
            cy0, cy1 = max(0, int((H - sb.t - 50) * IMAGES_SCALE)), min(ov.height, int((H - sb.b + 50) * IMAGES_SCALE))
            ctx = ov.crop((cx0, cy0, cx1, cy1))
            crops = []
            for _n, bx, col in boxes:
                im = make_crop(page_img, bx, H, None)
                bd = Image.new("RGB", (im.width + 6, im.height + 6), col)
                bd.paste(im, (3, 3))
                crops.append(bd)
            wtot = max(ctx.width, sum(c.width for c in crops) + 10 * 2)
            htot = ctx.height + 10 + max(c.height for c in crops)
            canvas = Image.new("RGB", (wtot, htot), "white")
            canvas.paste(ctx, (0, 0))
            x = 0
            for c in crops:
                canvas.paste(c, (x, ctx.height + 10))
                x += c.width + 10
            dst = out / "debug_v2" / f"{f.stem}_i{it['idx']}.png"
            dst.parent.mkdir(parents=True, exist_ok=True)
            canvas.save(dst)
            print(dst.name, [f"{n}:{bx.r - bx.l:.0f}x{bx.t - bx.b:.0f}" for n, bx, _ in boxes])


# --------------------------------------------------------------------------- CLI
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--out", required=True, help="çıktı klasörü (located/, crops/, results.jsonl, matches.json)")

    r = sub.add_parser("run")
    common(r)
    r.add_argument("--dataset", required=True, help="veri.json (looped listesi)")
    r.add_argument("--pdf-root", required=True, help="PDF'lerin <root>/*/<dosya>.pdf biçiminde bulunduğu kök")
    r.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    r.add_argument("--dtype", default="auto", help="auto = üretimdeki preset (bfloat16); CPU denemesi için float32")
    r.add_argument("--threads", type=int, default=4, help="yalnız CPU")
    r.add_argument("--conditions", help="virgülle: " + ",".join(CONDITIONS) + f" (varsayılan: {','.join(DEFAULT_CONDS)})")
    r.add_argument("--pages", help="süzgeç 'altdizge[:sayfa]' (örn. Likharev_Part-EM:145)")
    r.add_argument("--limit-pages", type=int)
    r.add_argument("--only-items", help="hata ayıklama: yalnız bu öğe indeksleri (grup bileşimi değişir!)")
    r.add_argument("--adaptive-margin", type=float, default=3.5, help="adaptif genişletme üst sınırı (pt)")
    r.add_argument("--max-new-tokens", type=int, help=f"varsayılan {STOCK_MAX_NEW_TOKENS} (üretim)")
    r.add_argument("--cap-after-hit", type=int, default=256, help="döngü tespitinden N token sonra satırı kes (0 = kesme, ham)")
    r.add_argument("--locate-only", action="store_true")
    d = sub.add_parser("debug-v2", help="stok/adaptive/adaptive2 kutularını sayfa üzerinde çizer (debug_v2/*.png)")
    common(d)
    d.add_argument("--pdf-root", required=True)
    d.add_argument("--pages", help="süzgeç 'altdizge[:sayfa]'")
    d.add_argument("--items", help="virgülle öğe indeksleri (yoksa hepsi)")
    d.add_argument("--adaptive-margin", type=float, default=3.5)
    s = sub.add_parser("summary")
    common(s)
    s.add_argument("--judgments", help="review sayfasından inen judgments.json")
    v = sub.add_parser("review")
    common(v)
    a = ap.parse_args()
    {"run": cmd_run, "summary": cmd_summary, "review": cmd_review, "debug-v2": cmd_debug_v2}[a.cmd](a)


if __name__ == "__main__":
    main()
