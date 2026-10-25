# -*- coding: utf-8 -*-
"""formula_prefetch.py testleri (ön-getirme üreticisi + işlemci vekili + docling bağlaması).

    python ingest/formula_prefetch_test.py

`npm test` kapsamında değil. GPU ve gerçek model GEREKMEZ: sahte model/motor/işlemci. Docling'in gerçek
`BasePipeline._enrich_document`'i (stok yol) ve gerçek `CodeFormulaVlmModel` sınıfı (alt sınıf, model
yüklenmeden) kullanılır; böylece stok döngüyle grup/sıra denkliği sınanır.
"""
import io
import os
import sys
import threading
import types
from contextlib import redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import docling  # noqa: F401
except ModuleNotFoundError:
    # docling is an optional PDF backend (requirements-optional.txt), not installed in CI.
    print("skip: docling is not installed")
    sys.exit(0)

import formula_prefetch as fp  # noqa: E402
from docling.models.stages.code_formula.code_formula_vlm_model import CodeFormulaVlmModel  # noqa: E402
from docling.pipeline.base_pipeline import BasePipeline  # noqa: E402
from PIL import Image  # noqa: E402

STOCK = BasePipeline._enrich_document  # install() öncesi


class FakeProcessor:
    """Çağrı sayar; eşzamanlı kullanımı yakalar (gerçek tokenizer'ın 'Already borrowed' davranışı)."""

    def __init__(self):
        self.calls = []
        self.busy = False
        self.overlap = False
        self.tokenizer = "tok"
        self.padding_side = "left"

    def _enter(self):
        if self.busy:
            self.overlap = True
        self.busy = True

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=True):
        self._enter()
        try:
            return "T:" + messages[0]["content"][1]["text"]
        finally:
            self.busy = False

    def __call__(self, text=None, images=None, return_tensors=None, padding=None, **kw):
        self._enter()
        try:
            self.calls.append((tuple(text), tuple(id(i) for i in images)))
            return {"text": tuple(text), "sizes": tuple(i.size for i in images)}
        finally:
            self.busy = False


class FakeEngine:
    _initialized = True

    def __init__(self, processor):
        self.processor = processor
        self.processor_seen = []

    def predict_batch(self, inputs):
        # predict_batch gibi: istem biçimle, işlemciyi çağır
        proc = self.processor
        prompts = [proc.apply_chat_template([{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": i.prompt}]}],
                                            tokenize=False, add_generation_prompt=True) for i in inputs]
        out = proc(text=prompts, images=[i.image for i in inputs], return_tensors="pt", padding=True)
        self.processor_seen.append(out)
        return [types.SimpleNamespace(text=f"L{i.image.size[0]}") for i in inputs]


TypeName = type("TransformersVlmEngine", (FakeEngine,), {})


class FakeModel(CodeFormulaVlmModel):
    def __init__(self, n_items, batch=3, engine=None, fail_prepare_at=None, fail_call_at=None, none_every=None):
        self.enabled = True
        self.elements_batch_size = batch
        self.engine = engine
        self.prepared = []
        self.batches = []
        self.fail_prepare_at = fail_prepare_at
        self.fail_call_at = fail_call_at
        self.none_every = none_every
        self.prepare_threads = set()

    def __del__(self):
        pass

    def prepare_element(self, conv_res, element):
        self.prepare_threads.add(threading.current_thread().name)
        if self.fail_prepare_at is not None and element == self.fail_prepare_at:
            raise ValueError("prepare patladı")
        if self.none_every and element % self.none_every == 0:
            return None
        self.prepared.append(element)
        item = types.SimpleNamespace(label="formula", text="")
        return types.SimpleNamespace(item=item, image=Image.new("RGB", (10 + element, 10)), n=element)

    def __call__(self, doc, element_batch):
        els = list(element_batch)
        self.batches.append([e.n for e in els])
        if self.fail_call_at is not None and len(self.batches) == self.fail_call_at:
            raise RuntimeError("model patladı")
        if self.engine is not None:
            outs = self.engine.predict_batch([types.SimpleNamespace(image=e.image, prompt=self._get_prompt(e.item.label)) for e in els])
            for e, o in zip(els, outs):
                e.item.text = o.text
        for e in els:
            yield e.item


class FakePipeline(BasePipeline):
    def __init__(self, models):
        self.enrichment_pipe = models

    def _build_document(self, conv_res):
        return conv_res

    def _determine_status(self, conv_res):
        return None

    @classmethod
    def get_default_options(cls):
        return None

    @classmethod
    def is_backend_supported(cls, backend):
        return True


def make_conv(n):
    doc = types.SimpleNamespace(iterate_items=lambda: ((i, 0) for i in range(n)))
    return types.SimpleNamespace(document=doc, timings={})


def run_with(prefetch: bool, model, n):
    BasePipeline._enrich_document = STOCK
    fp._INSTALLED[0] = False
    fp.reset_stats()
    if prefetch:
        os.environ.pop("VC_FORMULA_PREFETCH", None)
        assert fp.install()
    else:
        os.environ["VC_FORMULA_PREFETCH"] = "0"
    try:
        return FakePipeline([model])._enrich_document(make_conv(n))
    finally:
        fp.uninstall()
        os.environ.pop("VC_FORMULA_PREFETCH", None)


def live_prefetch_threads():
    return [t for t in threading.enumerate() if t.name == "formula-prefetch"]


def test_batches_equal_stock():
    for n, batch, none_every in [(11, 3, None), (9, 3, None), (1, 5, None), (0, 5, None), (14, 4, 3)]:
        a = FakeModel(n, batch, none_every=none_every)
        b = FakeModel(n, batch, none_every=none_every)
        run_with(False, a, n)
        run_with(True, b, n)
        assert a.batches == b.batches, (n, batch, a.batches, b.batches)
        assert a.prepared == b.prepared
    # son kısa grup gerçekten var
    m = FakeModel(11, 3)
    run_with(True, m, 11)
    assert [len(x) for x in m.batches] == [3, 3, 3, 2]
    assert not live_prefetch_threads()


def test_prepare_runs_only_in_producer_thread():
    m = FakeModel(7, 3)
    run_with(True, m, 7)
    assert m.prepare_threads == {"formula-prefetch"}, m.prepare_threads
    s = FakeModel(7, 3)
    run_with(False, s, 7)
    assert s.prepare_threads == {threading.current_thread().name}


def test_processor_cache_hits_and_same_result():
    pa, pb = FakeProcessor(), FakeProcessor()
    ea, eb = TypeName(pa), TypeName(pb)
    a, b = FakeModel(8, 3, engine=ea), FakeModel(8, 3, engine=eb)
    run_with(False, a, 8)
    run_with(True, b, 8)
    assert a.engine.processor_seen == b.engine.processor_seen  # sonuç doğrudan çağrıyla aynı
    assert fp.STATS["hits"] == 3 and fp.STATS["misses"] == 0, fp.STATS
    assert fp.STATS["prefetched"] == 3
    # asıl işlemciye grup başına tek kez gidildi (ön-hesap), ana iş parçacığı çağırmadı
    assert len(pb.calls) == 3 and len(pa.calls) == 3
    assert not pb.overlap
    assert eb.processor is pb  # bitince eski nesne


def test_key_mismatch_calls_real_processor():
    p = FakeProcessor()
    proxy = fp._ProcessorProxy(p)
    img = Image.new("RGB", (4, 4))
    res = proxy.real_call(text=["x"], images=[img], return_tensors="pt", padding=True)
    proxy.put([img], ["x"], res)
    n = len(p.calls)
    other = Image.new("RGB", (4, 4))  # aynı içerik, başka nesne
    fp.reset_stats()
    out = proxy(text=["x"], images=[other], return_tensors="pt", padding=True)
    assert len(p.calls) == n + 1 and out == res and fp.STATS["misses"] == 1
    assert proxy(text=["y"], images=[img], return_tensors="pt", padding=True)  # istem farklı
    assert len(p.calls) == n + 2
    # ek argüman -> önbelleğe bakılmaz
    proxy(text=["x"], images=[img], return_tensors="pt", padding=True, foo=1)
    assert len(p.calls) == n + 3 and fp.STATS["hits"] == 0
    # isabet girdiyi siler
    assert proxy(text=["x"], images=[img], return_tensors="pt", padding=True) == res
    assert fp.STATS["hits"] == 1
    proxy(text=["x"], images=[img], return_tensors="pt", padding=True)
    assert fp.STATS["hits"] == 1
    # öznitelikler asıl işlemciye geçer (okuma ve yazma)
    assert proxy.tokenizer == "tok"
    proxy.padding_side = "right"
    assert p.padding_side == "right"


def test_not_initialized_engine_skips_precompute():
    p = FakeProcessor()
    e = TypeName(p)
    e._initialized = False
    m = FakeModel(4, 2, engine=e)
    run_with(True, m, 4)
    assert fp.STATS["skipped"] == 2 and fp.STATS["prefetched"] == 0 and fp.STATS["hits"] == 0
    assert e.processor is p
    # Transformers olmayan motor
    e2 = FakeEngine(FakeProcessor())
    m2 = FakeModel(4, 2, engine=e2)
    run_with(True, m2, 4)
    assert fp.STATS["skipped"] == 2 and e2.processor_seen


def test_prepare_exception_reraised_in_main_thread():
    m = FakeModel(10, 3, fail_prepare_at=5)
    try:
        run_with(True, m, 10)
    except ValueError as err:
        assert "prepare patladı" in str(err)
    else:
        raise AssertionError("istisna fırlamadı")
    assert not live_prefetch_threads()


def test_model_exception_stops_producer():
    p = FakeProcessor()
    e = TypeName(p)
    m = FakeModel(40, 2, engine=e, fail_call_at=2)
    try:
        run_with(True, m, 40)
    except RuntimeError as err:
        assert "model patladı" in str(err)
    else:
        raise AssertionError("istisna fırlamadı")
    assert not live_prefetch_threads()
    assert len(m.prepared) < 40  # üretici sonuna kadar koşmadı
    assert e.processor is p


def test_disabled_uses_stock_path():
    BasePipeline._enrich_document = STOCK
    fp._INSTALLED[0] = False
    os.environ["VC_FORMULA_PREFETCH"] = "0"
    try:
        assert fp.install() is False
        assert BasePipeline._enrich_document is STOCK
        # kurulduktan sonra kapatılırsa sarmalayıcı stok fonksiyona düşer
        os.environ.pop("VC_FORMULA_PREFETCH")
        assert fp.install()
        os.environ["VC_FORMULA_PREFETCH"] = "0"
        m = FakeModel(5, 2)
        FakePipeline([m])._enrich_document(make_conv(5))
        assert m.prepare_threads == {threading.current_thread().name}
    finally:
        fp.uninstall()
        os.environ.pop("VC_FORMULA_PREFETCH", None)


def test_non_codeformula_models_use_stock_loop():
    class Other:
        elements_batch_size = 2

        def __init__(self):
            self.seen = []

        def prepare_element(self, conv_res, element):
            return element

        def __call__(self, doc, element_batch):
            self.seen.append(list(element_batch))
            yield from element_batch

    o = Other()
    m = FakeModel(4, 2)
    BasePipeline._enrich_document = STOCK
    fp._INSTALLED[0] = False
    assert fp.install()
    try:
        FakePipeline([o, m])._enrich_document(make_conv(5))
    finally:
        fp.uninstall()
    assert o.seen == [[0, 1], [2, 3], [4]] and m.batches == [[0, 1], [2, 3]] + [[4]]


def test_install_refuses_unexpected_stock():
    BasePipeline._enrich_document = STOCK
    fp._INSTALLED[0] = False
    fp._WARNED[0] = False
    saved = BasePipeline._enrich_document

    def odd(self, conv_res):
        return conv_res

    BasePipeline._enrich_document = odd
    buf = io.StringIO()
    try:
        with redirect_stderr(buf):
            assert fp.install() is False
    finally:
        BasePipeline._enrich_document = saved
        fp._WARNED[0] = False
    assert "beklenen yapıda değil" in buf.getvalue() and not fp._INSTALLED[0]


def test_report_json_line():
    BasePipeline._enrich_document = STOCK
    fp._INSTALLED[0] = False
    fp.reset_stats()
    assert fp.install()
    try:
        buf = io.StringIO()
        with redirect_stderr(buf):
            stats = fp.report()
        assert stats["enabled"] is True and '"formula_prefetch"' in buf.getvalue()
    finally:
        fp.uninstall()
    assert fp.report() is None


def test_real_pipeline_structure_matches():
    import inspect

    src = inspect.getsource(STOCK)
    assert "chunkify(" in src and "_prepare_elements" in src and "TimeRecorder(" in src


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    main()
