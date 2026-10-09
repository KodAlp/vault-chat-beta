# -*- coding: utf-8 -*-
"""docling formül zenginleştirmesi için satır başına döngü kesici + tek yeniden deneme.

docling'in CodeFormulaModel'i formül kırpıntılarını 5'erli gruplar halinde
`model.generate(..., do_sample=False)` ile çözer. Açgözlü çözme bazen bir
formülde döngüye girer (aynı 1-4 token'lık grup yüzlerce kez); grup birlikte
üretildiği için TEK döngülü formül 5'ini de max_new_tokens'a kadar tutar
(Notebook fizik ölçümü: formül yoğun PDF'te sayfa başına 15-25 sn, kitap başına
2-15 döngülü formül). postprocess.py döngüyü sonradan kesiyor ama zaman
çoktan gitmiş. Burada:

1. LoopDetector (StoppingCriteria): yalnız üretilen son WINDOW token'ı 1-4'lük
   bir periyotla birebir tekrarlıyorsa, ya da son tokenlar 5-32'lik bir grubun
   >= 8 kez (toplam >= 64 token) arka arkaya tekrarıysa O satırı bitirir, diğer
   satırlar sürer. Uzun periyot: formülden sonra yanlışlıkla okunan "(5.29) +
   kenar etiketi" gibi ~20 tokenlık grup döngüsü. max_new_tokens'a dokunulmaz.
2. Döngüden kesilen satırlar tek seferde, repetition_penalty ile yeniden
   üretilir. Temiz biterse (EOS, döngü yok) onu kullanırız. Olmazsa ilk
   denemenin kesik çıktısı kalır ve döngü, postprocess.py'nin eskiden olduğu
   gibi uyarı notuna dönüşmesi için DEGENERATE_RUN kadar uzatılır
   (kesilmiş 24 tekrar tek başına postprocess eşiğinin altında kalırdı).

VC_FORMULA_EARLY_STOP=0 kapatır (A/B ölçümü). docling'in iç yapısı farklıysa
bir kez stderr'e yazıp stok davranışa dönülür; dönüşüm asla bozulmaz.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

from postprocess import long_repeats

# Son WINDOW token tamamen p-periyotlu (p = 1..4) ise döngü. 96 token 1-4'lük
# grupla en az 24 tekrar demek. `} {`, `\quad \quad` gibi gerçek LaTeX kısa
# tekrarları bunun çok altında; tek gerçek risk 48+ sütunluk "0 & 0 & ..." sıfır
# matrisi — o da yeniden denemede aynı çıkarsa eskisi gibi uyarıya düşer.
WINDOW = 96
MAX_PERIOD = 4
# Uzun periyot (5..32 token): kural postprocess.long_repeats ile ortak (>= 8 tekrar
# VE toplam >= 64 token). 8 tekrar: 8 satırlık özdeş matris satırı / 8 kez aynı
# \frac{1}{2} terimi gerçek LaTeX'te çok nadir; döngü ise token tavanına kadar
# sürer, bu yüzden 8 tekrar beklemenin maliyeti (en çok 256 token) ihmal edilir.
MIN_LONG_PERIOD = 5
MAX_LONG_PERIOD = 32
LONG_CHECK_EVERY = 4  # uzun periyot kontrolü her 4 adımda (28 küçük karşılaştırma/adım)
REPETITION_PENALTY = 1.15  # 1.1-1.2; no_repeat_ngram_size LaTeX'e zarar verir (`} {`)
# Kurtarılamayan satırın döngüsü bu kadar * DEGENERATE_RUN tekrar uzatılır.
_EXTEND_FACTOR = 2

STATS: dict[str, Any] = {}
_INSTALLED = [False]
_WARNED = [False]


def enabled() -> bool:
    return os.environ.get("VC_FORMULA_EARLY_STOP", "1").strip() != "0"


def reset_stats() -> None:
    STATS.clear()
    STATS.update(rows_stopped=0, retries=0, retries_ok=0, tokens_saved_est=0, retry_skipped=0, periods={})


def snapshot() -> dict[str, Any]:
    out = dict(STATS)
    out["periods"] = dict(STATS.get("periods", {}))  # kesilen satırların periyot histogramı
    return out


def _warn_once(msg: str) -> None:
    if not _WARNED[0]:
        _WARNED[0] = True
        print(f"formula_early_stop: {msg}; stok davranış kullanılıyor", file=sys.stderr)


def _ids(value) -> list[int]:
    if value is None:
        return []
    return [int(v) for v in (value if isinstance(value, (list, tuple)) else [value])]


def long_window(p: int) -> int:
    """p-periyotlu uzun döngü için bakılan son token sayısı (p * tekrar)."""
    return p * long_repeats(p)


MIN_LONG_WINDOW = min(long_window(p) for p in range(MIN_LONG_PERIOD, MAX_LONG_PERIOD + 1))


def _min_period(tail, p: int) -> int:
    """`tail` p-periyotluysa gerçek (en küçük) periyodu: p'nin bölenlerinden en küçüğü."""
    for d in range(1, p):
        if p % d == 0 and bool((tail[d:] == tail[:-d]).all()):
            return d
    return p


def loop_period(row, window: int = WINDOW) -> int:
    """Satırın (yalnız üretilen kısım, 1B tensör) döngü periyodu; yoksa 0.
    1..MAX_PERIOD: son `window` token tamamen periyotlu. MIN_LONG_PERIOD..
    MAX_LONG_PERIOD: son long_window(p) token p'lik grubun birebir tekrarı.
    Döndürülen değer en küçük gerçek periyottur."""
    n = row.shape[0]
    if n >= window:
        tail = row[-window:]
        for p in range(1, MAX_PERIOD + 1):
            if bool((tail[p:] == tail[:-p]).all()):
                return p
    for p in range(MIN_LONG_PERIOD, MAX_LONG_PERIOD + 1):
        w = long_window(p)
        if n >= w:
            tail = row[-w:]
            if bool((tail[p:] == tail[:-p]).all()):
                return _min_period(tail, p)
    return 0


def make_detector(prompt_len: int, stop_ids: list[int]):
    import torch
    from transformers import StoppingCriteria

    class LoopDetector(StoppingCriteria):
        def __init__(self):
            self.hit = None  # [batch] bool, yapışkan
            self.stop_len: dict[int, int] = {}  # satır -> kesildiği üretilmiş token sayısı
            self.period: dict[int, int] = {}  # satır -> tetikleyen (en küçük) periyot

        def __call__(self, input_ids, scores, **kwargs):
            gen = input_ids[:, prompt_len:]  # prompt hariç
            batch, n = gen.shape
            if self.hit is None:
                self.hit = torch.zeros(batch, dtype=torch.bool, device=input_ids.device)
            res = torch.zeros(batch, dtype=torch.bool, device=input_ids.device)
            if n >= WINDOW:
                tail = gen[:, -WINDOW:]
                for p in range(1, MAX_PERIOD + 1):
                    res |= (tail[:, p:] == tail[:, :-p]).all(dim=1)
            if n >= MIN_LONG_WINDOW and n % LONG_CHECK_EVERY == 0:
                for p in range(MIN_LONG_PERIOD, MAX_LONG_PERIOD + 1):
                    w = long_window(p)
                    if n >= w:
                        tail = gen[:, -w:]
                        res |= (tail[:, p:] == tail[:, :-p]).all(dim=1)
            if stop_ids and n:
                # EOS/pad ile bitmiş (pad'le doldurulan) satır döngü sayılmaz.
                res &= ~torch.isin(gen[:, -1], torch.tensor(stop_ids, device=input_ids.device))
            for i in torch.nonzero(res & ~self.hit).flatten().tolist():
                self.stop_len[i] = n
                self.period[i] = loop_period(gen[i])
            self.hit |= res
            return res

    return LoopDetector()


def _with_detector(kwargs: dict, det) -> dict:
    from transformers import StoppingCriteriaList

    crit = StoppingCriteriaList(list(kwargs.get("stopping_criteria") or []) + [det])
    return {**kwargs, "stopping_criteria": crit}


def _slice_rows(kwargs: dict, rows: list[int], batch: int):
    """Batch ekseni `batch` olan her tensörü `rows` ile keser (input_ids,
    attention_mask, pixel_values, pixel_attention_mask ...). Batch ekseni
    uymayan bir tensör varsa güvenle kesilemez: None."""
    import torch

    out = {}
    for k, v in kwargs.items():
        if isinstance(v, torch.Tensor):
            if v.dim() == 0 or v.shape[0] != batch:
                return None
            out[k] = v[torch.tensor(rows, device=v.device)]
        else:
            out[k] = v
    return out


def _extend_loop(gen, repeats: int):
    """Kesik döngü satırının üretilen kısmını döngünün devamıyla uzatır."""
    import torch

    p = loop_period(gen) or 1
    return torch.cat([gen, gen[-p:].repeat(repeats)])


def wrap_generate(orig, model):
    """`model.generate` yerine geçen sarmalayıcı (döngü kesici + tek yeniden deneme)."""
    import torch

    def generate(*args, **kwargs):
        input_ids = kwargs.get("input_ids")
        if not enabled() or args or not isinstance(input_ids, torch.Tensor):
            return orig(*args, **kwargs)
        gc = getattr(model, "generation_config", None)
        eos, pad = _ids(getattr(gc, "eos_token_id", None)), _ids(getattr(gc, "pad_token_id", None))
        batch, plen = input_ids.shape
        det = make_detector(plen, eos + pad)
        out = orig(**_with_detector(kwargs, det))
        if det.hit is None or not bool(det.hit.any()):
            return out

        looped = sorted(det.stop_len)
        max_new = int(kwargs.get("max_new_tokens") or (out.shape[1] - plen))
        STATS["rows_stopped"] += len(looped)
        for i in looped:
            key = str(det.period.get(i, 0))
            STATS["periods"][key] = STATS["periods"].get(key, 0) + 1
        STATS["tokens_saved_est"] += sum(max(0, max_new - det.stop_len[i]) for i in looped)

        rows = [out[i, plen:] for i in range(batch)]
        rescued: set[int] = set()
        sub = _slice_rows(kwargs, looped, batch)
        if sub is None:
            STATS["retry_skipped"] += len(looped)
        else:
            STATS["retries"] += len(looped)
            det2 = make_detector(plen, eos + pad)
            out2 = orig(**_with_detector({**sub, "repetition_penalty": REPETITION_PENALTY}, det2))
            for j, i in enumerate(looped):
                gen2 = out2[j, plen:]
                has_eos = bool(eos) and bool(torch.isin(gen2, torch.tensor(eos, device=gen2.device)).any())
                if has_eos and not bool(det2.hit[j]):
                    rows[i] = gen2
                    rescued.add(i)
                    STATS["retries_ok"] += 1
        from postprocess import DEGENERATE_RUN

        for i in looped:
            if i not in rescued:  # döngü uyarıya dönüşecek kadar uzun kalsın
                rows[i] = _extend_loop(out[i, plen : plen + det.stop_len[i]], _EXTEND_FACTOR * DEGENERATE_RUN)
        pad_id = (pad or eos or [0])[0]
        width = max(r.shape[0] for r in rows)
        result = torch.full((batch, plen + width), pad_id, dtype=out.dtype, device=out.device)
        result[:, :plen] = out[:, :plen]
        for i, r in enumerate(rows):
            result[i, plen : plen + r.shape[0]] = r.to(out.device)
        return result

    return generate


def install() -> bool:
    """CodeFormulaModel.__init__'i sarar: oluşan modelin generate'i değişir.
    Bir kez kurulur; bir şey uymazsa False döner (stok davranış)."""
    if not enabled():
        return False
    if _INSTALLED[0]:
        return True
    try:
        from docling.models.stages.code_formula.code_formula_model import CodeFormulaModel

        orig_init = CodeFormulaModel.__init__

        def patched_init(self, *a, **kw):
            orig_init(self, *a, **kw)
            try:
                model = self._model
                if model is not None and not getattr(model, "_vc_early_stop", False):
                    model.generate = wrap_generate(model.generate, model)
                    model._vc_early_stop = True
            except Exception as err:  # noqa: BLE001
                _warn_once(f"generate sarılamadı ({err})")

        CodeFormulaModel.__init__ = patched_init
        _INSTALLED[0] = True
        return True
    except Exception as err:  # noqa: BLE001 — docling iç yapısı farklı olabilir
        _warn_once(f"kurulamadı ({err})")
        return False


def report() -> dict | None:
    """Belge başına sayaçları stderr'e tek JSON satırı olarak yazar; kapalı/kurulmadıysa None."""
    if not enabled() or not _INSTALLED[0]:
        return None
    stats = snapshot()
    print(json.dumps({"formula_early_stop": stats}), file=sys.stderr)
    return stats


reset_stats()
