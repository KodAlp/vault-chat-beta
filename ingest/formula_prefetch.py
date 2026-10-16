# -*- coding: utf-8 -*-
"""Formül ön-getirme (#82): bir sonraki grubun kırpımı ve işlemci girdisi, GPU decode'u sürerken hazırlanır.

docling 2.130'da zenginleştirme (`BasePipeline._enrich_document`) şöyle akar:

    for model in self.enrichment_pipe:
        for element_batch in chunkify(_prepare_elements(conv_res, model), model.elements_batch_size):
            for element in model(doc=..., element_batch=element_batch): pass

`_prepare_elements` her öğe için `model.prepare_element` çağırır (formula_crop: pdfium ile sayfa çizip
kırpar, öğe başına ~65 ms; formula_fallback kırpımı saklar). `CodeFormulaVlmModel.__call__` ->
`TransformersVlmEngine.predict_batch`: istem biçimlendirme + `processor(text=, images=, ...)` (CPU,
grup başına ~0,37 sn: görüntüyü büyütüp 512'lik parçalara böler) ve sonra GPU'da `generate` (grup başına
1-9 sn; GPU beklerken GIL bırakılır). Yani N+1. grubun kırpımı ve işlemcisi N. grubun decode'u bitene
kadar başlamıyordu.

Bu modül `_enrich_document`'i sarar: yalnız `enrichment_pipe` içindeki CodeFormulaVlmModel için bir
üretici iş parçacığı stokla BİREBİR AYNI grupları (aynı sıra, aynı boyut, kısa son grup) hazırlar:
`prepare_element` çağrıları + işlemci girdisinin ön-hesabı. Ön-hesap sonucu bir önbellekte durur;
`engine.processor` geçici olarak bir vekille değiştirilir: ana iş parçacığının predict_batch'teki
`processor(...)` çağrısı, anahtarı (görüntü nesne kimlikleri + istemler) ve argümanları ön-hesapla
eşleşiyorsa önbellekten döner, aksi halde asıl işlemciye gider. Çıktı değişmez: aynı işlemci, aynı
argümanlar, aynı nesneler. Kimlik anahtarı yüzünden uyuşmazlık yalnız ıska (yavaş yol) demektir.

İş parçacığı güvenliği: HF hızlı tokenizer'ları eşzamanlı kullanımda "Already borrowed" verir; asıl
işlemciye giden TÜM `__call__` ve `apply_chat_template` çağrıları tek bir kilitle seri yapılır (önbellek
isabeti kilide girmez). pdfium: prepare_element yalnız üretici iş parçacığında koşar; ana iş parçacığı o
sırada yalnız model çağırır (GPU).

Kurulum install() ile (formula_crop.py gibi). VC_FORMULA_PREFETCH=0 kapatır (varsayılan açık). Stok
fonksiyonun beklenen yapıda olmadığı (docling sürümü) ya da herhangi bir uyuşmazlıkta stok yol kullanılır;
dönüşüm asla bozulmaz.
"""
from __future__ import annotations

import inspect
import json
import os
import queue
import sys
import threading
import time
from typing import Any

STATS: dict[str, Any] = {}
_INSTALLED = [False]
_WARNED = [False]
_ORIG: list[Any] = [None]

_STOP_POLL_S = 0.1  # put/get zaman aşımı: durma isteğine bu aralıkla bakılır


def enabled() -> bool:
    return os.environ.get("VC_FORMULA_PREFETCH", "1").strip().lower() not in ("0", "off", "false", "no", "")


def reset_stats() -> None:
    STATS.clear()
    STATS.update(
        enabled=enabled(), docs=0, batches=0, prefetched=0, skipped=0, hits=0, misses=0,
        producer_s=0.0, wait_s=0.0, errors=0,
    )


def snapshot() -> dict[str, Any]:
    out = dict(STATS)
    out["producer_s"] = round(out["producer_s"], 3)
    out["wait_s"] = round(out["wait_s"], 3)
    return out


def _warn_once(msg: str) -> None:
    if not _WARNED[0]:
        _WARNED[0] = True
        print(f"formula_prefetch: {msg}; stok zenginleştirme kullanılıyor", file=sys.stderr)


# --------------------------------------------------------------------------- işlemci vekili
class _ProcessorProxy:
    """Asıl işlemcinin yerine geçer: her şeyi ona geçirir, `__call__`'da önbelleğe bakar.

    Asıl işlemciye giden `__call__` ve `apply_chat_template` tek kilitle seri yapılır. Öznitelik
    okuma/yazma asıl işlemciye yönlenir (tokenizer, padding_side vb. aynı nesne üzerinde kalır)."""

    def __init__(self, real: Any) -> None:
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_lock", threading.Lock())  # asıl işlemci kilidi
        object.__setattr__(self, "_cache_lock", threading.Lock())
        object.__setattr__(self, "_cache", {})

    def __getattr__(self, name: str) -> Any:
        return getattr(object.__getattribute__(self, "_real"), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(object.__getattribute__(self, "_real"), name, value)

    def apply_chat_template(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._real.apply_chat_template(*args, **kwargs)

    def real_call(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._real(*args, **kwargs)

    def put(self, images: list, prompts: list, result: Any) -> None:
        key = (tuple(id(i) for i in images), tuple(prompts))
        with self._cache_lock:
            # görüntü nesnelerinin kendisi de tutulur: id'ler yeniden kullanılamaz
            self._cache[key] = (list(images), result)

    def clear(self) -> None:
        with self._cache_lock:
            self._cache.clear()

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        if not args and set(kwargs) == {"text", "images", "return_tensors", "padding"} \
                and kwargs["return_tensors"] == "pt" and kwargs["padding"] is True:
            try:
                text, images = list(kwargs["text"]), list(kwargs["images"])
                key = (tuple(id(i) for i in images), tuple(text))
            except Exception:  # noqa: BLE001
                key = None
            if key is not None:
                with self._cache_lock:
                    entry = self._cache.pop(key, None)
                if entry is not None and all(a is b for a, b in zip(entry[0], images)):
                    STATS["hits"] += 1
                    return entry[1]
                STATS["misses"] += 1
        return self.real_call(*args, **kwargs)


def _transformers_engine(model: Any) -> Any:
    """Modelin Transformers motoru (auto_inline ise gerçek motor) ya da None."""
    eng = getattr(model, "engine", None)
    inner = getattr(eng, "actual_engine", None)
    if inner is not None:
        eng = inner
    if eng is None or type(eng).__name__ != "TransformersVlmEngine":
        return None
    return eng


def _precompute(model: Any, batch: list, state: dict) -> bool:
    """Grubun işlemci girdisini hesaplayıp önbelleğe koyar; yapılamazsa False (o grup ön-hesapsız)."""
    eng = _transformers_engine(model)
    if eng is None or not getattr(eng, "_initialized", False) or getattr(eng, "processor", None) is None:
        return False
    if state.get("proxy") is None:
        state["engine"] = eng
        state["proxy"] = _ProcessorProxy(eng.processor)
        eng.processor = state["proxy"]
    proxy = state["proxy"]
    if eng.processor is not proxy:
        return False
    from docling.models.inference_engines.vlm._utils import normalize_image_to_pil

    images = []
    prompts = []
    for el in batch:
        img = normalize_image_to_pil(el.image)  # predict_batch aynı dönüşümü yapacak
        if img is not el.image:
            el.image = img  # nesne kimliği korunur; CodeFormulaVlmModel.__call__ da bunu okur
        images.append(img)
        messages = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": model._get_prompt(el.item.label)}]}]
        prompts.append(proxy.apply_chat_template(messages, tokenize=False, add_generation_prompt=True))
    result = proxy.real_call(text=prompts, images=images, return_tensors="pt", padding=True)
    proxy.put(images, prompts, result)
    return True


def _restore(state: dict) -> None:
    proxy, eng = state.get("proxy"), state.get("engine")
    if proxy is not None:
        proxy.clear()
        if eng is not None and eng.processor is proxy:
            eng.processor = object.__getattribute__(proxy, "_real")
        state["proxy"] = None


# --------------------------------------------------------------------------- ön-getirme döngüsü
def _run_model_prefetch(conv_res: Any, model: Any) -> None:
    """Tek bir CodeFormulaVlmModel için stoktaki döngünün ön-getirmeli karşılığı."""
    n = model.elements_batch_size
    q: queue.Queue = queue.Queue(maxsize=1)
    stop = threading.Event()
    state: dict[str, Any] = {"proxy": None, "engine": None}

    def put(item) -> bool:
        while not stop.is_set():
            try:
                q.put(item, timeout=_STOP_POLL_S)
                return True
            except queue.Full:
                continue
        return False

    def emit(batch: list) -> bool:
        t0 = time.perf_counter()
        try:
            ok = _precompute(model, batch, state)
        except Exception as err:  # noqa: BLE001 — ön-hesap başarısızsa ana iş parçacığı kendisi hesaplar
            _warn_once(f"ön-hesap başarısız ({err})")
            ok = False
        STATS["producer_s"] += time.perf_counter() - t0
        STATS["prefetched" if ok else "skipped"] += 1
        return put(("batch", batch))

    def producer() -> None:
        try:
            batch: list = []
            for doc_element, _level in conv_res.document.iterate_items():
                if stop.is_set():
                    return
                t0 = time.perf_counter()
                prepared = model.prepare_element(conv_res=conv_res, element=doc_element)
                STATS["producer_s"] += time.perf_counter() - t0
                if prepared is None:
                    continue
                batch.append(prepared)
                if len(batch) == n:
                    if not emit(batch):
                        return
                    batch = []
            if batch and not emit(batch):
                return
            put(("end", None))
        except BaseException as err:  # noqa: BLE001 — ana iş parçacığında yeniden fırlatılır
            put(("error", err))

    thread = threading.Thread(target=producer, name="formula-prefetch")
    thread.start()
    try:
        while True:
            t0 = time.perf_counter()
            while True:
                try:
                    kind, payload = q.get(timeout=_STOP_POLL_S)
                    break
                except queue.Empty:
                    if not thread.is_alive() and q.empty():
                        raise RuntimeError("formula_prefetch: üretici beklenmedik şekilde bitti")
            STATS["wait_s"] += time.perf_counter() - t0
            if kind == "end":
                break
            if kind == "error":
                STATS["errors"] += 1
                raise payload
            STATS["batches"] += 1
            for _element in model(doc=conv_res.document, element_batch=payload):  # Must exhaust!
                pass
    finally:
        stop.set()
        thread.join()
        _restore(state)


def _enrich_document(self: Any, conv_res: Any) -> Any:
    orig = _ORIG[0]
    if not enabled():
        return orig(self, conv_res)
    from docling.models.stages.code_formula.code_formula_vlm_model import CodeFormulaVlmModel

    pipe = list(getattr(self, "enrichment_pipe", None) or [])
    if not any(isinstance(m, CodeFormulaVlmModel) for m in pipe):
        return orig(self, conv_res)
    from docling.utils.profiling import ProfilingScope, TimeRecorder
    from docling.utils.utils import chunkify

    STATS["docs"] += 1
    with TimeRecorder(conv_res, "doc_enrich", scope=ProfilingScope.DOCUMENT):
        for model in pipe:
            if isinstance(model, CodeFormulaVlmModel):
                _run_model_prefetch(conv_res, model)
                continue

            def prepared_elements(model=model):
                for doc_element, _level in conv_res.document.iterate_items():
                    prepared = model.prepare_element(conv_res=conv_res, element=doc_element)
                    if prepared is not None:
                        yield prepared

            for element_batch in chunkify(prepared_elements(), model.elements_batch_size):
                for _element in model(doc=conv_res.document, element_batch=element_batch):  # Must exhaust!
                    pass
    return conv_res


def install() -> bool:
    """BasePipeline._enrich_document'i sarar. VC_FORMULA_PREFETCH=0 ise ya da stok fonksiyon beklenen
    yapıda değilse kurmaz (False)."""
    if not enabled():
        return False
    if _INSTALLED[0]:
        return True
    try:
        from docling.pipeline.base_pipeline import BasePipeline

        orig = BasePipeline._enrich_document
        src = inspect.getsource(orig)
        for needle in ("chunkify(", "_prepare_elements", "enrichment_pipe", "TimeRecorder(", "prepare_element("):
            if needle not in src:
                _warn_once(f"docling _enrich_document beklenen yapıda değil ({needle!r} yok)")
                return False
        _ORIG[0] = orig
        BasePipeline._enrich_document = _enrich_document
        _INSTALLED[0] = True
        return True
    except Exception as err:  # noqa: BLE001 — docling iç yapısı farklı olabilir
        _warn_once(f"kurulamadı ({err})")
        return False


def uninstall() -> None:
    """Testler için: stok _enrich_document'i geri koyar."""
    if _INSTALLED[0]:
        from docling.pipeline.base_pipeline import BasePipeline

        BasePipeline._enrich_document = _ORIG[0]
        _INSTALLED[0] = False


def report() -> dict | None:
    """Belge başına sayaçları stderr'e tek JSON satırı olarak yazar; kapalı/kurulmadıysa None."""
    if not enabled() or not _INSTALLED[0]:
        return None
    stats = snapshot()
    print(json.dumps({"formula_prefetch": stats}), file=sys.stderr)
    return stats


reset_stats()
