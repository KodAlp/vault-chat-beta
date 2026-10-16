# -*- coding: utf-8 -*-
"""formula_graph_decode: CUDA grafikli decode stok generate ile birebir aynı mı.

    python ingest/formula_graph_decode_test.py

Rastgele ağırlıklı minik bir Idefics3 (CodeFormulaV2'nin mimarisi: GQA'lı
Llama metin modeli + görüntü kodlayıcı) üzerinde, sol dolgulu karışık
uzunlukta grupla. CUDA yoksa atlanır. Asıl model üzerindeki ölçüm modülün
başındaki notta."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import torch
except ImportError:  # pragma: no cover
    torch = None

import formula_graph_decode as fgd

VOCAB = 300
IMG_TOKEN = 299
IMG_TOKENS = 4  # (32/8)^2 yama / scale_factor^2


def _model():
    from transformers import GenerationConfig, Idefics3Config, Idefics3ForConditionalGeneration

    torch.manual_seed(0)
    cfg = Idefics3Config(
        text_config={"model_type": "llama", "hidden_size": 64, "intermediate_size": 128, "num_hidden_layers": 2,
                     "num_attention_heads": 4, "num_key_value_heads": 2, "vocab_size": VOCAB,
                     "max_position_embeddings": 512, "pad_token_id": 0},
        vision_config={"hidden_size": 32, "intermediate_size": 64, "num_hidden_layers": 1,
                       "num_attention_heads": 2, "image_size": 32, "patch_size": 8},
        scale_factor=2, image_token_id=IMG_TOKEN,
    )
    m = Idefics3ForConditionalGeneration(cfg).to("cuda", torch.float32).eval()
    m.generation_config = GenerationConfig()
    return m


def _inputs(lengths):
    """Sol dolgulu grup: her satır [metin..., 4 görüntü token'ı, metin...]."""
    g = torch.Generator().manual_seed(1)
    L = max(lengths)
    ids = torch.zeros(len(lengths), L, dtype=torch.long)
    am = torch.zeros(len(lengths), L, dtype=torch.long)
    for i, n in enumerate(lengths):
        row = torch.randint(3, 250, (n,), generator=g)
        row[1 : 1 + IMG_TOKENS] = IMG_TOKEN
        ids[i, L - n :] = row
        am[i, L - n :] = 1
    pv = torch.randn(len(lengths), 1, 3, 32, 32, generator=g)
    pam = torch.ones(len(lengths), 1, 32, 32, dtype=torch.long)
    return {"input_ids": ids.cuda(), "attention_mask": am.cuda(), "pixel_values": pv.cuda(),
            "pixel_attention_mask": pam.cuda()}


def _gc(max_new, eos, pad=0):
    from transformers import GenerationConfig

    return GenerationConfig(max_new_tokens=max_new, do_sample=False, eos_token_id=eos, pad_token_id=pad,
                            use_cache=True)


class StopRowAt:
    """Stokta adım başına çağrılan saf ölçüt: `row` satırı `n` token üretince durur."""

    def __init__(self, plen, row, n):
        self.plen, self.row, self.n = plen, row, n

    def __call__(self, input_ids, scores, **kw):
        res = torch.zeros(input_ids.shape[0], dtype=torch.bool, device=input_ids.device)
        if input_ids.shape[1] - self.plen >= self.n:
            res[self.row] = True
        return res


def _both(m, inputs, gc, crit_factory=None):
    from transformers import StoppingCriteriaList

    def kw():
        k = {**inputs, "generation_config": gc}
        if crit_factory:
            k["stopping_criteria"] = StoppingCriteriaList([crit_factory()])
        return k

    with torch.inference_mode():
        stock = m.generate(**kw())
    fgd._DISABLED[0] = False
    fgd.STATS.update(graph_calls=0, stock_calls=0)
    graph = fgd.wrap(m.generate, m)(**kw())
    assert fgd.STATS["graph_calls"] == 1, fgd.STATS
    return stock, graph


def test_plain_and_bucket_crossing():
    m = _model()
    inputs = _inputs([12, 9, 12, 7])
    saved = fgd.BUCKETS
    try:
        fgd.BUCKETS = (4, 8)  # 30 token: 4 -> 8 -> 30 kovalarından geçer
        stock, graph = _both(m, inputs, _gc(30, eos=VOCAB + 5 - 6))  # ulaşılmaz EOS
    finally:
        fgd.BUCKETS = saved
    assert stock.shape == graph.shape and torch.equal(stock, graph), (stock[:, -30:], graph[:, -30:])


def test_eos_rows_padded_and_width_trimmed():
    m = _model()
    inputs = _inputs([12, 9, 12, 7])
    plen = inputs["input_ids"].shape[1]
    with torch.inference_mode():
        probe = m.generate(**inputs, generation_config=_gc(12, eos=VOCAB - 6))
    eos = int(probe[1, plen + 3])  # 2. satırın 4. token'ı EOS olsun
    stock, graph = _both(m, inputs, _gc(40, eos=eos))
    assert stock.shape == graph.shape and torch.equal(stock, graph), (stock[:, plen:], graph[:, plen:])
    assert (stock[:, plen:] == eos).any()


def test_stopping_criteria_replayed_per_step():
    m = _model()
    inputs = _inputs([12, 9, 12, 7])
    plen = inputs["input_ids"].shape[1]
    # 6 SYNC_EVERY'ye bölünmez: ölçüt senkron noktaları arasında tetiklenir
    stock, graph = _both(m, inputs, _gc(25, eos=VOCAB - 6), lambda: StopRowAt(plen, 2, 6))
    assert stock.shape == graph.shape and torch.equal(stock, graph), (stock[:, plen:], graph[:, plen:])
    assert int((graph[2, plen:] == 0).sum()) == 25 - 6  # kalan pad


def test_shape_changes_share_one_decoder():
    """Aynı decoder'da girdi uzunluğu büyür (depo büyür, grafikler atılır), küçülür,
    grup boyutu değişir; her çağrı stokla aynı."""
    m = _model()
    saved = fgd.MAX_SHAPES
    try:
        # MAX_SHAPES=1: her şekil değişiminde grafikler atılıp yeniden yakalanır (bgnet'te
        # paylaşılan havuz kimliği bu yolda ayırıcı iç hatası veriyordu).
        for max_shapes in (saved, 1):
            fgd.MAX_SHAPES = max_shapes
            fgd._DISABLED[0] = False
            fgd.STATS.update(graph_calls=0, stock_calls=0)
            gen = fgd.wrap(m.generate, m)
            for lengths in ([9, 7, 9], [20, 14, 20], [9, 9, 8], [12], [20, 14, 20], [9, 7, 9]):
                inputs = _inputs(lengths)
                gc = _gc(18, eos=VOCAB - 6)
                with torch.inference_mode():
                    stock = m.generate(**inputs, generation_config=gc)
                graph = gen(**inputs, generation_config=gc)
                assert stock.shape == graph.shape and torch.equal(stock, graph), (lengths, stock, graph)
            assert fgd.STATS["graph_calls"] == 6 and not fgd._DISABLED[0], fgd.STATS
    finally:
        fgd.MAX_SHAPES = saved


def test_ineligible_goes_stock():
    m = _model()
    inputs = _inputs([8, 8])
    calls = []

    def fake(*a, **k):
        calls.append(k)
        return "stock"

    gen = fgd.wrap(fake, m)
    gc = _gc(5, eos=7)
    gc.repetition_penalty = 1.15  # döngü kesicinin yeniden denemesi
    assert gen(**inputs, generation_config=gc) == "stock"
    assert gen(**inputs, generation_config=_gc(5, eos=7), max_new_tokens=3) == "stock"  # bilinmeyen argüman
    os.environ["VC_FORMULA_CUDA_GRAPH"] = "0"
    try:
        assert gen(**inputs, generation_config=_gc(5, eos=7)) == "stock"
    finally:
        del os.environ["VC_FORMULA_CUDA_GRAPH"]
    assert len(calls) == 3


def test_error_falls_back_to_stock():
    m = _model()
    inputs = _inputs([8, 8])
    gen = fgd.wrap(lambda **k: "stock", m)
    saved = fgd.GraphDecoder.generate
    try:
        fgd.GraphDecoder.generate = lambda self, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        fgd._DISABLED[0] = False
        assert gen(**inputs, generation_config=_gc(5, eos=7)) == "stock"
        assert fgd._DISABLED[0] is True and not fgd.enabled()
    finally:
        fgd.GraphDecoder.generate = saved
        fgd._DISABLED[0] = False


def test_low_vram_goes_stock_and_release_clears():
    m = _model()
    inputs = _inputs([9, 9])
    fgd._DISABLED[0] = False
    gen = fgd.wrap(m.generate, m)
    gen(**inputs, generation_config=_gc(6, eos=VOCAB - 6))  # depo kuruldu
    decs = list(fgd._DECODERS)
    assert decs and any(d.store for d in decs)
    fgd.release()
    assert all(not d.store and not d.shapes for d in decs)
    saved = fgd.MIN_FREE_BYTES
    try:
        fgd.MIN_FREE_BYTES = 1 << 50
        fgd.STATS.update(low_vram=0)
        with torch.inference_mode():
            stock = m.generate(**inputs, generation_config=_gc(6, eos=VOCAB - 6))
        out = gen(**inputs, generation_config=_gc(6, eos=VOCAB - 6))
        assert fgd.STATS["low_vram"] == 1 and torch.equal(out, stock)
    finally:
        fgd.MIN_FREE_BYTES = saved


def main():
    if torch is None or not torch.cuda.is_available():
        print("SKIP formula_graph_decode_test: CUDA yok")
        return
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} passed")


if __name__ == "__main__":
    main()
