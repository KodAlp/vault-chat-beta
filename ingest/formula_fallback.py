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

Her hata stderr'e bir kez yazılır, CodeFormula metni kalır; dönüşüm asla bozulmaz.
VC_FORMULA_FALLBACK_MODEL=<HF kimliği> MinerU modelini değiştirir (yalnız yerel önbellekten yüklenir, indirme yok).
"""
from __future__ import annotations

import gc
import io
import json
import os
import re
import sys
import time
from typing import Any, Callable

MODEL_ID = "opendatalab/MinerU2.5-Pro-2605-1.2B"
MAX_STORE_BYTES = 256 * 1024 * 1024
BATCH_SIZE = 4

STATS: dict[str, Any] = {}
_INSTALLED = [False]
_WARNED = [False]
_CROPS: dict[tuple, bytes] = {}  # (sayfa, l, t, r, b) -> PNG baytı
_STORED = [0]  # _CROPS toplam bayt

# KaTeX'in desteklemediği (veya markdown hattında anlamsız) komutlar.
UNSUPPORTED_COMMANDS = {"intertext", "eqno", "leqno", "homotopy", "label", "qedhere"}
# \\ ve & içeriğini barındırabilen, ortam olmayan gruplar.
_STACK_GROUP_COMMANDS = {"substack", "shortstack"}

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
        mode=mode(), flagged=0, reasons={}, replaced=0, kept=0, load_s=0.0, run_s=0.0, skipped_no_cuda=0, no_image=0, errors=0
    )
    _CROPS.clear()
    _STORED[0] = 0


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
    "begin_end", "toplevel_align", "unsupported". KaTeX'in reddettiği en sık CodeFormula hatalarını yakalar;
    KaTeX'in tam ayrıştırıcısı değildir."""
    if not latex or not latex.strip():
        return "empty"
    stack: list[tuple[str, str]] = []  # (tür, ad): brace | left | env | sub
    pending_sub = False

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
            if cmd in _STACK_GROUP_COMMANDS:
                pending_sub = True
        elif sym is not None:
            if sym == "\\" and not in_table():
                return "toplevel_align"
        elif ch == "{":
            stack.append(("sub" if pending_sub else "brace", ""))
            pending_sub = False
        elif ch == "}":
            if not stack or stack[-1][0] not in ("brace", "sub"):
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
            backend="transformers", model=self.model, processor=self.proc, use_tqdm=False, batch_size=BATCH_SIZE
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


# --------------------------------------------------------------------------- uygulama
def _formula_items(document):
    from docling_core.types.doc import DocItemLabel

    for item in getattr(document, "texts", None) or []:
        if getattr(item, "label", None) == DocItemLabel.FORMULA:
            yield item


def apply(document, recognizer: Callable[[list], list] | None = None, has_cuda: Callable[[], bool] | None = None) -> dict | None:
    """Belgedeki bayraklı formüllerin metnini MinerU çıktısıyla değiştirir. `recognizer`
    (PIL listesi -> LaTeX listesi) testlerde sahte verilir; verilmezse MinerU yüklenir ve boşaltılır.
    Dönüş: snapshot() veya kapalıysa None. Hata durumunda belge değişmez."""
    m = STATS.get("mode") or mode()
    if m == "off":
        return None
    session = None
    try:
        todo = []  # (item, neden, PNG)
        for item in _formula_items(document):
            text = item.text or ""
            reason = flag_reason(text)
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
            return snapshot()
        if recognizer is None:
            if not (has_cuda or _cuda_available)():
                STATS["skipped_no_cuda"] += len(todo)
                STATS["kept"] += len(todo)
                return snapshot()
            t0 = time.time()
            session = _open_session()
            session.load()
            STATS["load_s"] = round(time.time() - t0, 2)
            recognizer = session.recognize
        from PIL import Image

        t0 = time.time()
        for start in range(0, len(todo), BATCH_SIZE * 4):
            chunk = todo[start : start + BATCH_SIZE * 4]
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
                    item.text = new
                    STATS["replaced"] += 1
                else:
                    STATS["kept"] += 1
        STATS["run_s"] = round(time.time() - t0, 2)
    except Exception as err:  # noqa: BLE001 — yedek; dönüşümü asla bozmaz
        STATS["errors"] += 1
        _warn_once(f"başarısız ({err})")
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:  # noqa: BLE001
                pass
        _CROPS.clear()
        _STORED[0] = 0
    return snapshot()


def report() -> dict | None:
    """Belge başına sayaçları stderr'e tek JSON satırı olarak yazar; kapalıysa None."""
    if STATS.get("mode", "off") == "off":
        return None
    stats = snapshot()
    print(json.dumps({"formula_fallback": stats}), file=sys.stderr)
    return stats


reset_stats()
