# -*- coding: utf-8 -*-
"""Formül yedeği: CodeFormulaV2'nin bozuk/boş/döngülü çıktısını MinerU2.5-Pro ile yeniden okur.

docling'in formül zenginleştirmesi (CodeFormulaVlmModel) 90 gerçek formül kırpımında KaTeX'e uygun
çıktıyı 76/90 verdi; MinerU2.5-Pro-2605-1.2B 89/90 (CodeFormula'nın geçersiz 14'ünden 13'ünü doğru
okudu; ♯ ve kalın simgeleri de doğru okuyor). MinerU ~2.5 sn/formül ve ~2.2 GB VRAM ister; bu yüzden
yalnız gerektiğinde, belge bittikten sonra yüklenir ve hemen boşaltılır (--serve işçisi 2.2 GB tutmasın).

Akış:
  1. TOPLAMA (install): CodeFormulaVlmModel.prepare_element, formula_crop'unkinin ÜSTÜNE sarılır
     (formula_crop.install() ÖNCE çağrılmalı); crop kancası bittiğinde `el.image` modelin gördüğü
     birebir kırpımdır, PNG baytı olarak saklanır. Anahtar (sayfa, kutu): docling'in `concatenate`
     ettiği (sayfa bazlı OCR) belgede self_ref değişir, prov kutusu değişmez. Bellek: yalnız FORMULA
     etiketli öğeler, PNG (birkaç KB), toplam üst sınırı MAX_STORE_BYTES; aşılırsa yenisi saklanmaz
     (o formül yedeklenemez, "no_image" sayılır). Belge başına reset_stats() ve apply() sonunda boşaltılır.
  2. TETİK (apply, belge düzeyinde, docling dönüşümü bittikten sonra): `document.texts` içindeki
     FORMULA öğelerinin SON metni; (a) boş, (b) döngü (postprocess.find_degenerate_run: erken kesicinin
     yeniden denemesinden sonra da kalan döngü uzatıldığı için burada görünür), (c) saf Python yapısal
     geçersizlik (check_latex: dengesiz {}, eşleşmeyen \\left/\\right, \\begin/\\end, ortam dışı & veya \\\\,
     KaTeX'in bilmediği komutlar). VC_FORMULA_FALLBACK=auto (varsayılan) | off | all (her formül MinerU'ya
     gider, MinerU çıktısı geçerliyse HER ZAMAN tercih edilir).
  3. ÇALIŞTIRMA: CUDA yoksa atlanır (skipped_no_cuda). Aksi halde boş önbellek -> MinerU tembel yükle ->
     toplu çalıştır -> boşalt (del, gc, cuda.empty_cache).
  4. NORMALLEŞTİRME (normalize_mineru): \\[ \\] / $$ sarmalı, \\tag{..} / \\tag*{..} (denklem numarası başka yerde
     işleniyor) ve satır sonları atılır. Çıktı check_latex ve döngü sınamasından geçmezse CodeFormula metni kalır.
  5. DEĞİŞTİRME: `item.text` yerinde değişir; postprocess ve uyarılar düzeltilmiş LaTeX'i görür (döngüden
     kurtarılan formül "döngü nedeniyle kısaltıldı" sayacına girmez).

  6. OKUNAMAYAN FORMÜL GÖRSELİ (VC_FORMULA_IMAGE=1 varsayılan | 0): MinerU adımından sonra (MinerU çalışmasa
     da) her formülün notta görüneceği hâli (fix_latex_artifacts + wrap_alignment_math uygulanmış $$ blokları)
     GERÇEK KaTeX ile sınanır (katex_check.mjs, belge başına tek node çağrısı; node/katex yoksa check_latex
     sezgiseli, STATS["katex_check"] = "node" | "heuristic" | "error"). KaTeX'in derlemediği ya da döngü
     içeren (find_degenerate_run) formül ölümcüldür; kırpımı varsa item.text, `<!-- vc:fimg N -->` yer
     tutucusuyla değiştirilir (docling onu $$..$$ içinde dışa aktarır, postprocess'e dokunmaz) ve kırpım
     PNG'si FATAL_IMAGES'ta tutulur. Dönüşümün sonunda convert.py `resolve_markers()` ile yer tutucuyu
     `![Okunamayan formül — s. N](images/<sha16>.png)` + `<!-- vc:formul-gorsel <sha16> s.N -->` +
     `> ⚠ Formül okunamadı — s. N` bilgi satırı + görünmez `<!-- vc:formul-latex <base64url> -->` (en iyi LaTeX
     denemesi, döngü kuyruğu kesilmiş; read_latex_comment ile okunur) ile değiştirir ve PNG'yi images/ klasörüne yazar;
     dosya adları done olayının `images` listesine girer (Node tarafı onları _meta/attachments/'a taşır).

Her hata stderr'e bir kez yazılır, CodeFormula metni kalır; dönüşüm asla bozulmaz.
VC_FORMULA_FALLBACK_MODEL=<HF kimliği> MinerU modelini değiştirir (yalnız yerel önbellekten yüklenir, indirme yok).
"""
from __future__ import annotations

import base64
import gc
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Any, Callable

MODEL_ID = "opendatalab/MinerU2.5-Pro-2605-1.2B"
MAX_STORE_BYTES = 256 * 1024 * 1024
BATCH_SIZE = 12
# MinerU grup boyutu (#82, 2026-10-16, Carroll GR s. 40-69, 25 formül): 4 / 8 / 12 ->
# 36,4 / 28,5 / 21,4 sn, tepe VRAM 3,18 / 3,41 / 3,68 GB. Grup boyutu 25 formülün 3'ünde
# tek-token farkı veriyor (padding'de neredeyse eşit adaylar; aynı boyutta belirlenimli);
# biri 12'de daha doğru. Varsayılan 12 (kullanıcı kararı); VC_FORMULA_FALLBACK_BATCH ile
# değiştirilir (1-32), VRAM darsa 4.


def batch_size() -> int:
    try:
        n = int(os.environ.get("VC_FORMULA_FALLBACK_BATCH", "").strip() or BATCH_SIZE)
    except ValueError:
        n = BATCH_SIZE
    return max(1, min(32, n))
KATEX_TIMEOUT_S = 60
FATAL_LATEX_MAX_CHARS = 2000

STATS: dict[str, Any] = {}
_INSTALLED = [False]
_WARNED = [False]
_CROPS: dict[tuple, bytes] = {}  # (sayfa, l, t, r, b) -> PNG baytı
_STORED = [0]  # _CROPS toplam bayt
# Okunamayan formül görselleri. Koşu boyunca (reset_images'a kadar) kalır, reset_stats'ta SİLİNMEZ: bir
# dönüşümde docling birden çok kez çalışabilir ve notta kalan metin hangisinden geldiyse yer tutucu
# kimlikleri benzersiz olmalı.
FATAL_IMAGES: dict[int, dict] = {}  # kimlik -> {"png", "sha", "page", "latex"}
_NEXT_FATAL_ID = [0]
FATAL_MARKER = re.compile(r"<!-- vc:fimg (\d+) -->")
_FATAL_WRAPPED = re.compile(r"\${1,2}[ \t\r\n]*<!-- vc:fimg (\d+) -->[ \t\r\n]*\${1,2}")

# KaTeX'in desteklemediği (veya markdown hattında anlamsız) komutlar.
UNSUPPORTED_COMMANDS = {"intertext", "eqno", "leqno", "homotopy", "label", "qedhere"}
# \\ ve & içeriğini barındırabilen, ortam olmayan gruplar.
_STACK_GROUP_COMMANDS = {"substack", "shortstack"}
# Argümanı metin kipinde dizilen komutlar (içinde yalnız KaTeX'in metin kipi komutları geçerli).
_TEXT_GROUP_COMMANDS = {"text", "textbf", "textit", "textrm", "textsf", "texttt", "textnormal", "textup", "textmd", "mbox", "hbox", "emph"}


def _load_katex_commands() -> tuple[frozenset, frozenset] | None:
    """ingest/katex_commands.json: KaTeX'in (uygulamanın kullandığı sürüm) tanıdığı komutlar, matematik ve
    metin kipi için ayrı. KaTeX'in kendisine karşı denenerek üretildi (bkz. dosyadaki "katex" sürümü). Dosya
    yoksa bilinmeyen komut sınaması atlanır."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "katex_commands.json"), encoding="utf-8") as f:
            d = json.load(f)
        return frozenset(d["math"]), frozenset(d["text"])
    except Exception:
        return None


_KATEX = _load_katex_commands()

_TOKEN = re.compile(
    r"\\begin\s*\{([^{}]*)\}"
    r"|\\end\s*\{([^{}]*)\}"
    r"|\\(left|right)(?![A-Za-z])"
    r"|\\([A-Za-z]+)"
    r"|\\(.)"
    r"|([{}&])",
    re.DOTALL,
)


def mode() -> str:
    m = os.environ.get("VC_FORMULA_FALLBACK", "auto").strip().lower()
    if m in ("off", "0", "false", "no", ""):
        return "off"
    return "all" if m == "all" else "auto"


def reset_stats() -> None:
    STATS.clear()
    STATS.update(
        mode=mode(),
        flagged=0,
        reasons={},
        replaced=0,
        kept=0,
        load_s=0.0,
        run_s=0.0,
        skipped_no_cuda=0,
        no_image=0,
        errors=0,
        fatal=0,
        fatal_images=0,
        katex_check="off",
    )
    _CROPS.clear()
    _STORED[0] = 0


def reset_images() -> None:
    """Koşu başında (convert.py reset_run_state) okunamayan formül görsellerini boşaltır."""
    FATAL_IMAGES.clear()
    _NEXT_FATAL_ID[0] = 0


def image_mode() -> bool:
    """VC_FORMULA_IMAGE=0|off|false|no kapatır; varsayılan açık."""
    return os.environ.get("VC_FORMULA_IMAGE", "1").strip().lower() not in ("0", "off", "false", "no")


def snapshot() -> dict[str, Any]:
    out = dict(STATS)
    out["reasons"] = dict(STATS.get("reasons", {}))
    return out


def _warn_once(msg: str) -> None:
    if not _WARNED[0]:
        _WARNED[0] = True
        print(f"formula_fallback: {msg}; CodeFormula çıktısı kullanılıyor", file=sys.stderr)


# --------------------------------------------------------------------------- geçerlilik
def check_latex(latex: str) -> str | None:
    """Saf Python yapısal sınama. Geçerliyse None; değilse nedeni: "empty", "braces", "left_right",
    "begin_end", "toplevel_align", "unsupported", "unknown_cmd" (KaTeX bilmiyor), "text_mode" (\text{} içinde
    yalnız matematik kipinde geçerli komut). KaTeX'in reddettiği en sık CodeFormula hatalarını yakalar;
    KaTeX'in tam ayrıştırıcısı değildir."""
    if not latex or not latex.strip():
        return "empty"
    stack: list[tuple[str, str]] = []  # (tür, ad): brace | left | env | sub
    pending_sub = False
    pending_text = False

    def in_table() -> bool:
        return any(k in ("env", "sub") for k, _ in stack)

    for m in _TOKEN.finditer(latex):
        begin, end, lr, cmd, sym, ch = m.groups()
        if begin is not None:
            stack.append(("env", begin.strip()))
        elif end is not None:
            if not stack or stack[-1] != ("env", end.strip()):
                return "begin_end"
            stack.pop()
        elif lr is not None:
            if lr == "left":
                stack.append(("left", ""))
            else:
                if not stack or stack[-1][0] != "left":
                    return "left_right"
                stack.pop()
        elif cmd is not None:
            if cmd in UNSUPPORTED_COMMANDS:
                return "unsupported"
            if _KATEX is not None:
                if any(k == "text" for k, _ in stack):
                    if cmd not in _KATEX[1]:
                        return "text_mode"
                elif cmd not in _KATEX[0]:
                    return "unknown_cmd"
            if cmd in _STACK_GROUP_COMMANDS:
                pending_sub = True
            elif cmd in _TEXT_GROUP_COMMANDS:
                pending_text = True
        elif sym is not None:
            if sym == "\\" and not in_table():
                return "toplevel_align"
        elif ch == "{":
            stack.append(("sub" if pending_sub else "text" if pending_text else "brace", ""))
            pending_sub = pending_text = False
        elif ch == "}":
            if not stack or stack[-1][0] not in ("brace", "sub", "text"):
                return "braces"
            stack.pop()
        elif ch == "&":
            if not in_table():
                return "toplevel_align"
    if stack:
        kind = stack[-1][0]
        return {"left": "left_right", "env": "begin_end"}.get(kind, "braces")
    return None


def _has_loop(latex: str) -> bool:
    from postprocess import find_degenerate_run

    return find_degenerate_run(latex) != -1


def flag_reason(text: str) -> str | None:
    """auto modunda yedeğe gönderme nedeni; None = CodeFormula metni kalır."""
    if not text or not text.strip():
        return "empty"
    if _has_loop(text):
        return "loop"
    return check_latex(text)


# --------------------------------------------------------------------------- normalleştirme
def _strip_tags(s: str) -> str:
    """\\tag{..} / \\tag*{..} (iç içe {} dahil) siler."""
    out = []
    i = 0
    pat = re.compile(r"\\tag\*?\s*\{")
    while True:
        m = pat.search(s, i)
        if not m:
            out.append(s[i:])
            break
        out.append(s[i : m.start()])
        depth, j = 1, m.end()
        while j < len(s) and depth:
            if s[j] == "\\":
                j += 2
                continue
            depth += 1 if s[j] == "{" else -1 if s[j] == "}" else 0
            j += 1
        i = j
    return "".join(out)


def normalize_mineru(raw: Any) -> str:
    """MinerU çıktısını CodeFormula biçimine getirir: sarmalayıcı, \\tag ve satır sonları atılır."""
    if raw is None:
        return ""
    s = str(raw).strip()
    for _ in range(2):
        s = s.strip()
        if s.startswith("\\[") and s.endswith("\\]"):
            s = s[2:-2]
        elif s.startswith("$$") and s.endswith("$$") and len(s) >= 4:
            s = s[2:-2]
        elif s.startswith("\\(") and s.endswith("\\)"):
            s = s[2:-2]
    s = _strip_tags(s)
    s = re.sub(r"\s*\n\s*", " ", s).strip()
    s = re.sub(r"(\\\\\s*)+$", "", s).strip()  # \tag atılınca kalan kuyruk satır sonu
    return s


# --------------------------------------------------------------------------- toplama
def _key(item) -> tuple | None:
    try:
        prov = item.prov[0]
        b = prov.bbox
        return (int(prov.page_no), round(float(b.l), 1), round(float(b.t), 1), round(float(b.r), 1), round(float(b.b), 1))
    except Exception:  # noqa: BLE001
        return None


def record(item, image) -> bool:
    """Formül öğesinin modele giden kırpımını PNG olarak saklar (üst sınırlı)."""
    key = _key(item)
    if key is None or image is None:
        return False
    if key in _CROPS:
        return True
    try:
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        data = buf.getvalue()
    except Exception:  # noqa: BLE001
        return False
    if _STORED[0] + len(data) > MAX_STORE_BYTES:
        return False
    _CROPS[key] = data
    _STORED[0] += len(data)
    return True


def _prepare(orig, self, conv_res, element):
    el = orig(self, conv_res, element)
    try:
        if el is not None and STATS.get("mode", "off") != "off":
            from docling_core.types.doc import DocItemLabel

            item = getattr(el, "item", None)
            if item is not None and getattr(item, "label", None) == DocItemLabel.FORMULA:
                record(item, getattr(el, "image", None))
    except Exception as err:  # noqa: BLE001 — toplama başarısızsa yalnız yedek devre dışı
        _warn_once(f"kırpım saklanamadı ({err})")
    return el


def install() -> bool:
    """CodeFormulaVlmModel.prepare_element'i sarar (formula_crop.install() SONRASI çağrılmalı).
    VC_FORMULA_FALLBACK=off ise kurmaz."""
    if mode() == "off":
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
    except Exception as err:  # noqa: BLE001
        _warn_once(f"kurulamadı ({err})")
        return False


# --------------------------------------------------------------------------- MinerU
class MineruSession:
    """MinerU2.5-Pro'yu tembel yükler; close() VRAM'i bırakır. recognize(PIL listesi) -> [LaTeX | None]."""

    def __init__(self) -> None:
        self.client = None
        self.model = None
        self.proc = None

    def load(self) -> None:
        import torch
        from mineru_vl_utils import MinerUClient
        from transformers import AutoProcessor, Qwen2VLForConditionalGeneration

        vid = os.environ.get("VC_FORMULA_FALLBACK_MODEL", "").strip() or MODEL_ID
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        self.model = Qwen2VLForConditionalGeneration.from_pretrained(
            vid, dtype=torch.bfloat16, device_map="cuda", local_files_only=True
        )
        if not hasattr(self.model.config, "max_position_embeddings"):  # transformers 5 + mineru_vl_utils
            self.model.config.max_position_embeddings = self.model.config.text_config.max_position_embeddings
        self.proc = AutoProcessor.from_pretrained(vid, use_fast=True, local_files_only=True)
        self.client = MinerUClient(
            backend="transformers", model=self.model, processor=self.proc, use_tqdm=False, batch_size=batch_size()
        )

    def recognize(self, images: list) -> list:
        out = self.client.batch_content_extract(images, types="equation")
        return [None if r is None else str(r) for r in out]

    def close(self) -> None:
        self.client = self.model = self.proc = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass


def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def _open_session():
    return MineruSession()


# --------------------------------------------------------------------------- KaTeX sınaması
def _node_bin() -> str | None:
    return os.environ.get("VC_NODE_BIN", "").strip() or shutil.which("node")


def katex_batch(latexes: list[str]) -> tuple[list[bool] | None, str]:
    """Hepsini tek `node katex_check.mjs` çağrısıyla gerçek KaTeX'e (displayMode) sınatır.
    Dönüş: (geçerlilik listesi | None, "node" | "heuristic" | "error"). node ya da katex yoksa
    "heuristic" (çağıran check_latex'e düşer), node çalıştı ama başarısızsa/zaman aşımında "error"."""
    if not latexes:
        return [], "node"
    node = _node_bin()
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "katex_check.mjs")
    if not node or not os.path.exists(script):
        return None, "heuristic"
    try:
        proc = subprocess.run(
            [node, script],
            input=json.dumps(latexes).encode("utf-8"),
            capture_output=True,
            timeout=KATEX_TIMEOUT_S,
            creationflags=0x08000000 if os.name == "nt" else 0,  # CREATE_NO_WINDOW
        )
    except FileNotFoundError:
        return None, "heuristic"
    except Exception as err:  # noqa: BLE001 — zaman aşımı vb.
        _warn_once(f"KaTeX sınaması çalışmadı ({err})")
        return None, "error"
    if proc.returncode == 2:  # katex bulunamadı
        return None, "heuristic"
    try:
        out = json.loads(proc.stdout.decode("utf-8"))
        if proc.returncode != 0 or not isinstance(out, list) or len(out) != len(latexes):
            raise ValueError(f"çıkış {proc.returncode}")
        return [bool(x) for x in out], "node"
    except Exception as err:  # noqa: BLE001
        _warn_once(f"KaTeX sınaması geçersiz çıktı verdi ({err})")
        return None, "error"


def note_blocks(text: str) -> list[str]:
    """Formülün nota gireceği hâldeki $$ gövdeleri: postprocess'in fix_latex_artifacts (düzeltmeler, kaçak
    düzyazıyı bloktan çıkarma) ve wrap_alignment_math (üst düzey & -> aligned) adımları uygulanmış."""
    from postprocess import fix_latex_artifacts, wrap_alignment_math

    out = wrap_alignment_math(fix_latex_artifacts("$$" + text + "$$"))
    return [m.group(1) for m in re.finditer(r"\$\$(.*?)\$\$", out, re.DOTALL)]


def _best_attempt(text: str) -> str:
    """Görselin altındaki ```latex bloğu için: döngü kuyruğu kesilmiş, uzunluğu sınırlı LaTeX."""
    from postprocess import _DEGENERATE_HEAD_MAX, find_degenerate_run

    s = text.strip()
    at = find_degenerate_run(s)
    if at != -1:
        s = s[:at][:_DEGENERATE_HEAD_MAX]
    s = re.sub(r"(\s|\\\\)+$", "", s)[:FATAL_LATEX_MAX_CHARS]
    return s.strip()


def find_fatal(texts: list[str], katex: Callable | None = None) -> tuple[list[str | None], str]:
    """Her metin için ölümcül neden ("empty" | "loop" | "katex" | "heuristic") ya da None (okunabilir)
    ve kullanılan sınama ("node" | "heuristic" | "error"). Tek toplu KaTeX çağrısı."""
    reasons: list[str | None] = [None] * len(texts)
    flat: list[str] = []
    owner: list[int] = []
    for i, text in enumerate(texts):
        if not text or not text.strip():
            reasons[i] = "empty"
        elif _has_loop(text):
            reasons[i] = "loop"
        else:
            for body in note_blocks(text):
                flat.append(body)
                owner.append(i)
    valid, source = (katex or katex_batch)(flat) if flat else ([], "node")
    if valid is None:
        valid = [check_latex(b) is None for b in flat]
    elif not flat:
        source = "node"
    for ok, i in zip(valid, owner):
        if not ok and reasons[i] is None:
            reasons[i] = "katex" if source == "node" else "heuristic"
    return reasons, source


def mark_fatal(document, katex: Callable | None = None) -> None:
    """Son metni KaTeX'e uymayan ya da döngülü formülleri (kırpımı varsa) yer tutucuyla değiştirir."""
    items = list(_formula_items(document))
    if not items:
        return
    reasons, source = find_fatal([it.text or "" for it in items], katex)
    STATS["katex_check"] = source
    for item, reason in zip(items, reasons):
        if reason is None:
            continue
        STATS["fatal"] += 1
        png = _CROPS.get(_key(item))
        if png is None:
            continue
        fid = _NEXT_FATAL_ID[0]
        _NEXT_FATAL_ID[0] += 1
        FATAL_IMAGES[fid] = {
            "png": png,
            "sha": hashlib.sha256(png).hexdigest()[:16],
            "page": int(item.prov[0].page_no),
            "latex": _best_attempt(item.text or ""),
        }
        item.text = f"<!-- vc:fimg {fid} -->"
        STATS["fatal_images"] += 1


def fatal_warning(count: int, *, images_on: bool = True) -> str:
    """İçe aktarma penceresi ve import-log için Türkçe uyarı (Python'dan düz metin gelir, i18n kodu yok)."""
    if images_on:
        return f"{count} formül okunamadı; görseli (sayfa numarasıyla) nota eklendi — kaynakla karşılaştırın."
    return f"{count} formül okunamadı; sayfa numarası notta belirtildi — kaynakla karşılaştırın."


LATEX_COMMENT = re.compile(r"<!-- vc:formul-latex ([A-Za-z0-9_-]+) -->")


def latex_comment(latex: str) -> str:
    """Ham (en iyi deneme) LaTeX'i görünmez HTML yorumu olarak sarar (urlsafe base64, `--` sorunu yok)."""
    enc = base64.urlsafe_b64encode(latex.encode("utf-8")).decode("ascii").rstrip("=")
    return f"<!-- vc:formul-latex {enc} -->"


def read_latex_comment(line: str) -> str | None:
    """latex_comment'in tersi; eşleşme yoksa None."""
    m = LATEX_COMMENT.search(line)
    if not m:
        return None
    enc = m.group(1)
    return base64.urlsafe_b64decode(enc + "=" * (-len(enc) % 4)).decode("utf-8")


def resolve_markers(md: str, images_dir=None) -> tuple[str, list[str]]:
    """Yer tutucuları son bloğa çevirir ve (images_dir verildiyse) PNG'leri yazar. Dönüş: (markdown,
    yazılan dosya adları). images_dir=None (--no-images / --dry-run): görsel yok, yalnız uyarı + LaTeX."""
    names: list[str] = []
    done = [False]

    def block(fid: int) -> str:
        info = FATAL_IMAGES.get(fid)
        if info is None:
            return ""
        done[0] = True
        sha, page = info["sha"], info["page"]
        if images_dir is not None:
            name = f"{sha}.png"
            if name not in names:
                images_dir.mkdir(parents=True, exist_ok=True)
                (images_dir / name).write_bytes(info["png"])
                names.append(name)
            parts = [f"![Okunamayan formül — s. {page}](images/{name})\n<!-- vc:formul-gorsel {sha} s.{page} -->"]
        else:
            parts = []
        # Görünür kısım tek satırlık bilgi; ham LaTeX görünmez yorumda saklanır (yalnız bozuk formülü onarma işi).
        parts.append(f"> ⚠ Formül okunamadı — s. {page}")
        if info["latex"]:
            parts.append(latex_comment(info["latex"]))
        return "\n\n" + "\n\n".join(parts) + "\n\n"

    md = _FATAL_WRAPPED.sub(lambda m: block(int(m.group(1))), md)
    md = FATAL_MARKER.sub(lambda m: block(int(m.group(1))), md)
    if done[0]:
        md = re.sub(r"\n{3,}", "\n\n", md)
    return md, names


# --------------------------------------------------------------------------- uygulama
def _formula_items(document):
    from docling_core.types.doc import DocItemLabel

    for item in getattr(document, "texts", None) or []:
        if getattr(item, "label", None) == DocItemLabel.FORMULA:
            yield item


def apply(
    document,
    recognizer: Callable[[list], list] | None = None,
    has_cuda: Callable[[], bool] | None = None,
    katex: Callable[[list], tuple] | None = None,
) -> dict | None:
    """Belgedeki bayraklı formüllerin metnini MinerU çıktısıyla değiştirir; ardından hâlâ okunamayan
    formülleri görsel yer tutucusuna çevirir (mark_fatal). `recognizer` (PIL listesi -> LaTeX listesi) ve
    `katex` (LaTeX listesi -> (bool listesi | None, kaynak)) testlerde sahte verilir; recognizer verilmezse
    MinerU yüklenir ve boşaltılır. Dönüş: snapshot() veya kapalıysa None. Hata durumunda belge değişmez."""
    m = STATS.get("mode") or mode()
    if m == "off":
        return None
    session = None
    try:
        todo = []  # (item, neden, PNG)
        items = list(_formula_items(document))
        pre = [flag_reason(it.text or "") for it in items]
        if m == "auto":
            # Sezgisel sınamayı geçip KaTeX'in reddettiği formüller de MinerU'ya gider (görsele düşmeden önce).
            rest = [i for i, r in enumerate(pre) if r is None]
            if rest:
                found, _src = find_fatal([items[i].text or "" for i in rest], katex)
                for i, r in zip(rest, found):
                    if r == "katex":
                        pre[i] = "katex"
        for item, reason in zip(items, pre):
            if reason is None and m == "all":
                reason = "all"
            if reason is None:
                continue
            STATS["flagged"] += 1
            STATS["reasons"][reason] = STATS["reasons"].get(reason, 0) + 1
            png = _CROPS.get(_key(item))
            if png is None:
                STATS["no_image"] += 1
                STATS["kept"] += 1
                continue
            todo.append((item, reason, png))
        if not todo:
            return _finish(document, katex)
        if recognizer is None:
            if not (has_cuda or _cuda_available)():
                STATS["skipped_no_cuda"] += len(todo)
                STATS["kept"] += len(todo)
                return _finish(document, katex)
            t0 = time.time()
            session = _open_session()
            session.load()
            STATS["load_s"] = round(time.time() - t0, 2)
            recognizer = session.recognize
        from PIL import Image

        t0 = time.time()
        candidates = []  # (item, MinerU metni) — kabulü KaTeX'le topluca verilir
        for start in range(0, len(todo), batch_size() * 4):
            chunk = todo[start : start + batch_size() * 4]
            try:
                images = [Image.open(io.BytesIO(png)).convert("RGB") for _i, _r, png in chunk]
                outs = recognizer(images)
                if len(outs) != len(chunk):
                    raise RuntimeError(f"{len(chunk)} kırpım için {len(outs)} çıktı")
            except Exception as err:  # noqa: BLE001 — bu grup CodeFormula metniyle kalır
                STATS["errors"] += 1
                STATS["kept"] += len(chunk)
                _warn_once(f"MinerU çalışmadı ({err})")
                continue
            for (item, _reason, _png), raw in zip(chunk, outs):
                new = normalize_mineru(raw)
                if new and check_latex(new) is None and not _has_loop(new):
                    candidates.append((item, new))
                else:
                    STATS["kept"] += 1
        if candidates:
            # MinerU çıktısı da notta görüneceği biçimde KaTeX'ten geçmeli (node yoksa sezgisel sınama yeter).
            found, _src = find_fatal([new for _item, new in candidates], katex)
            for (item, new), r in zip(candidates, found):
                if r is None:
                    item.text = new
                    STATS["replaced"] += 1
                else:
                    STATS["kept"] += 1
        STATS["run_s"] = round(time.time() - t0, 2)
        if session is not None:  # VRAM'i KaTeX sınamasından önce bırak
            try:
                session.close()
            except Exception:  # noqa: BLE001
                pass
            session = None
        return _finish(document, katex)
    except Exception as err:  # noqa: BLE001 — yedek; dönüşümü asla bozmaz
        STATS["errors"] += 1
        _warn_once(f"başarısız ({err})")
        _finish(document, katex)  # MinerU çökse de okunamayan formüller görsele çevrilir
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:  # noqa: BLE001
                pass
        _CROPS.clear()
        _STORED[0] = 0
    return snapshot()


def _finish(document, katex) -> dict:
    """MinerU adımından sonra: hâlâ okunamayan formülleri görsele çevirir. Hata dönüşümü bozmaz.
    (Kırpımlar çağıranın finally'sinde boşaltılır.)"""
    if image_mode():
        try:
            mark_fatal(document, katex)
        except Exception as err:  # noqa: BLE001
            STATS["errors"] += 1
            _warn_once(f"okunamayan formül görseli eklenemedi ({err})")
    return snapshot()


def report() -> dict | None:
    """Belge başına sayaçları stderr'e tek JSON satırı olarak yazar; kapalıysa None."""
    if STATS.get("mode", "off") == "off":
        return None
    stats = snapshot()
    print(json.dumps({"formula_fallback": stats}), file=sys.stderr)
    return stats


reset_stats()
