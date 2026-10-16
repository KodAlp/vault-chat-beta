# -*- coding: utf-8 -*-
"""Formül modelinin açgözlü decode'unu CUDA grafiğiyle koşan generate (#82).

Ölçüm (2026-10-16, RTX 4050 Laptop, Windows, docling 2.130, transformers 5.17,
DavidTong_Electromagnetism s. 20-39, 71 formül): CodeFormulaV2 (Idefics3,
576 gizli boyut, 30 katman) stok `generate` ile token başına ~33 ms. Zamanın
neredeyse tamamı Python ve çekirdek başlatma: adım başına ~1000 küçük çekirdek,
GPU'nun asıl işi ~1-2 ms. torch.compile seçenekleri burada yok (Triton kurulu
değil; `cudagraphs` arka ucu HF forward'ındaki grafik kırılmaları yüzünden
kazanç vermedi, 69 ms/token). Bu modül decode adımını (gömme -> 30 katman ->
lm_head -> argmax -> EOS takibi) bir kez yakalayıp her token'da yalnız
`graph.replay()` çağırır. Formül süresi 61,2 -> 33,5 sn.

Çıktı farkı (ölçüldü, 5 belge, 320 formül/kod bloğu): HF'nin kendi statik
önbellekli generate'iyle 81/81 birebir aynı (Carroll). Stok (dinamik önbellek)
ile 6/320 blokta bir token farklı: dikkat, maskelenmiş tam uzunluktaki
anahtarlar üzerinden hesaplanınca çekirdeğin toplama sırası değişiyor ve bf16'da
neredeyse eşit iki aday yer değiştiriyor. Stok yol kendi içinde belirlenimli
(iki koşu 81/81 aynı). PDF'le elle karşılaştırıldı: 6 farkın hiçbiri içerik
hatası değil (Carroll (3.16) `T_{μν}{}^λ` grafikte daha yakın, `{r c l}`
stokta; `close(sockfd);` grafikte doğru; Likharev (1.66) ikisinde de doğru).
Sabit şekilli grafikte bu fark kaçınılmaz; birebir stok gerekirse
VC_FORMULA_CUDA_GRAPH=0.

Uçtan uca (toplam dönüşüm, stok -> grafik): Tong EM 20 s. 104 -> 76 sn,
Likharev QM 30 s. 198 -> 139, Carroll GR 30 s. 221 -> 139, bgnet (C kodu)
20 s. 88 -> 52, JeffE 20 s. 84 -> 65.

Önbellek: azami uzunlukta (girdi + max_new_tokens) TEK StaticCache; her kova
(BUCKETS üretilen token) bu depolamanın ön kısmına bakan görünümler ve kendi
grafiğiyle çalışır. Neden kova: 3 KV başı 9 sorgu başına `repeat_kv` ile
her adımda kopyalanıyor ve dikkat tüm önbellek uzunluğu üzerinden; tek bir
2653 konumluk önbellekte bu ikisi adım başına ~12 ms tutuyordu (formüllerin
çoğu 300 token'ın altında biter).

Stokla eşdeğerlik:
- İlk token ön doldurma (normal forward, görüntü dahil) ile, konumlar stok
  generate gibi `cumsum(attention_mask) - 1`.
- Bitmiş satır sonraki adımlarda pad üretir; tüm satırlar bitince durulur ve
  çıktı stokla aynı genişliğe kırpılır.
- `stopping_criteria` (döngü kesici, docling'in durdurucuları) grafikte
  koşamaz: her SYNC_EVERY adımda bir, aradaki her adım için sırayla ve
  stoktaki gibi o adıma kadarki dizilerle çağrılır; bir satırı durduran ölçüt
  o satırın kalanını pad'e çevirir.
Uygun olmayan çağrı (örnekleme, ışın arama, repetition_penalty, bilinmeyen
argüman, CUDA dışı, beklenmeyen model yapısı) stok generate'e gider; grafik
yolunda bir hata olursa süreç boyunca stok yola dönülür.

VC_FORMULA_CUDA_GRAPH=0 kapatır (A/B ölçümü).
"""
from __future__ import annotations

import json
import os
import sys
import weakref
from typing import Any

SYNC_EVERY = 8
BUCKETS = (128, 512)  # + max_new_tokens
MAX_SHAPES = 6  # (grup, girdi uzunluğu) başına grafik takımı; K/V deposu grup boyutu başına tek
_ALLOWED_KWARGS = {"input_ids", "attention_mask", "pixel_values", "pixel_attention_mask",
                   "generation_config", "stopping_criteria"}
# Grafik yolu yalnız bu kadar boş VRAM varken: K/V deposu + ön doldurma payı. Sohbet
# modeli de GPU'dayken (2026-09-23 ölçümü: 5,9/6,1 GB) grafik yolu stoka çekilir.
# Windows'ta (WDDM) VRAM sanallaştırılmış: boştaki Ollama modeli sistem belleğine
# indirilir ve mem_get_info onu boş sayar (2026-10-16: qwen3:8b "4,8 GB VRAM"da iken
# 5 GB boş). Orada taşma OOM değil sayfalama olur; bu eşik yalnız gerçek dolulukta tutar.
# Ölçüm: qwen3:8b yüklüyken Carroll 10 s. 46 sn, tepe 5,84/6,14 GB, hata yok.
MIN_FREE_BYTES = 1536 * 2**20
_DISABLED = [False]
_WARNED = [False]
_DECODERS: "weakref.WeakSet" = None  # type: ignore[assignment]
STATS: dict[str, Any] = {"graph_calls": 0, "stock_calls": 0, "low_vram": 0}


def enabled() -> bool:
    return os.environ.get("VC_FORMULA_CUDA_GRAPH", "1").strip() != "0" and not _DISABLED[0]


def _warn(msg: str) -> None:
    if not _WARNED[0]:
        _WARNED[0] = True
        print(f"formula_graph_decode: {msg}; stok generate kullanılıyor", file=sys.stderr)


def eligible(model, kwargs: dict) -> bool:
    """Bu çağrı grafik yolunda koşabilir mi (stokla aynı sonucu verecek koşullar)."""
    if set(kwargs) - _ALLOWED_KWARGS:
        return False
    ids, am, gc = kwargs.get("input_ids"), kwargs.get("attention_mask"), kwargs.get("generation_config")
    if ids is None or am is None or gc is None or getattr(ids, "device", None) is None or ids.device.type != "cuda":
        return False
    if getattr(gc, "do_sample", False) or (getattr(gc, "num_beams", 1) or 1) != 1:
        return False
    if (getattr(gc, "repetition_penalty", None) or 1.0) != 1.0 or (getattr(gc, "no_repeat_ngram_size", None) or 0):
        return False
    if getattr(gc, "max_new_tokens", None) is None or gc.eos_token_id is None or gc.pad_token_id is None:
        return False
    if isinstance(gc.eos_token_id, (list, tuple)) and len(gc.eos_token_id) != 1:
        return False
    inner = getattr(model, "model", None)
    return hasattr(inner, "text_model") and hasattr(model, "lm_head")


def reset_stats() -> None:
    STATS.update(graph_calls=0, stock_calls=0, low_vram=0)


def report() -> dict | None:
    """Belge başına sayaçları stderr'e tek JSON satırı yazar (hiç çağrı yoksa None)."""
    if not (STATS["graph_calls"] or STATS["stock_calls"]):
        return None
    out = {**STATS, "disabled": _DISABLED[0]}
    print(json.dumps({"formula_graph_decode": out}), file=sys.stderr)
    return out


def release() -> None:
    """Tüm decoder'ların K/V deposunu ve grafiklerini bırakır (belgenin formül aşaması
    bitince, MinerU yedeği GPU'ya yüklenmeden önce). Sonraki çağrı yeniden kurar."""
    if _DECODERS is None:
        return
    for dec in list(_DECODERS):
        dec.clear()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            clear_ws = getattr(torch._C, "_cuda_clearCublasWorkspaces", None)
            if clear_ws is not None:
                clear_ws()
    except Exception:  # noqa: BLE001
        pass


def _vram_ok(dec) -> bool:
    """Boş VRAM (sürücünün boş dediği + PyTorch'un ayırıp kullanmadığı + bu decoder'ın
    zaten tuttuğu depo) MIN_FREE_BYTES'a yetiyor mu."""
    import torch

    try:
        free, _total = torch.cuda.mem_get_info()
        free += torch.cuda.memory_reserved() - torch.cuda.memory_allocated()
    except Exception:  # noqa: BLE001
        return True
    if dec is not None:
        free += dec.held_bytes()
    return free >= MIN_FREE_BYTES


def _first_id(v) -> int:
    return int(v[0] if isinstance(v, (list, tuple)) else v)


class GraphDecoder:
    def __init__(self, model):
        import torch

        self.model = model
        self.text = model.model.text_model
        self.head = model.lm_head
        self.store: dict[int, dict] = {}  # grup boyutu -> paylaşılan K/V deposu
        self.shapes: dict[tuple, dict] = {}  # (grup, girdi uzunluğu, max_new) -> grafikler + tamponlar
        # Isınma için TEK yan akış: her yakalamada yeni akış, akış başına ayrı cuBLAS
        # çalışma alanı demek (empty_cache bunları bırakmaz).
        self.stream = torch.cuda.Stream()
        global _DECODERS
        if _DECODERS is None:
            _DECODERS = weakref.WeakSet()
        _DECODERS.add(self)

    def held_bytes(self) -> int:
        return sum(t.numel() * t.element_size() for st in self.store.values() for t in st["k"] + st["v"])

    def clear(self) -> None:
        import torch

        self.shapes.clear()
        self.store.clear()

    def _storage(self, B: int, L: int, like) -> dict:
        """Grup boyutu başına TEK K/V deposu (katman başına [B, kv_başı, L, d]); daha
        uzun bir girdi gelince büyür ve o grup boyutunun grafikleri atılır (eski depoya
        bakıyorlardı). `like`: ön doldurmanın DynamicCache'i (dtype, baş sayısı)."""
        import torch

        cur = self.store.get(B)
        if cur is not None and cur["L"] >= L:
            return cur
        for key in [k for k in self.shapes if k[0] == B]:
            del self.shapes[key]
        self.store.pop(B, None)
        torch.cuda.empty_cache()
        L = -(-L // 256) * 256
        ks, vs = [], []
        for lay in like.layers:
            k, v = lay.keys, lay.values
            ks.append(torch.zeros(B, k.shape[1], L, k.shape[3], dtype=k.dtype, device=k.device))
            vs.append(torch.zeros(B, v.shape[1], L, v.shape[3], dtype=v.dtype, device=v.device))
        cur = self.store[B] = {"L": L, "k": ks, "v": vs}
        return cur

    def _state(self, B: int, in_len: int, max_new: int, store: dict) -> dict:
        import torch

        key = (B, in_len, max_new)
        st = self.shapes.get(key)
        if st is not None:
            return st
        while len(self.shapes) >= MAX_SHAPES:
            self.shapes.pop(next(iter(self.shapes)))
        dev = self.head.weight.device
        L = in_len + max_new
        st = {
            "in_len": in_len,
            "store": store,
            # Durum başına grafik havuzu: kova grafikleri birlikte oluşur, birlikte silinir.
            # Tüm grafikleri silinmiş bir havuz kimliğini yeni yakalamada yeniden kullanmak
            # PyTorch ayırıcısında iç doğrulama hatası veriyordu (use_count > 0, bgnet).
            "pool": torch.cuda.graph_pool_handle(),
            "caps": sorted({c for c in BUCKETS if c < max_new} | {max_new}),
            "buckets": {},
            "ids": torch.zeros(B, 1, dtype=torch.long, device=dev),
            "pos": torch.zeros(B, 1, dtype=torch.long, device=dev),
            "mask": torch.zeros(B, 1, 1, L, dtype=torch.bool, device=dev),
            "cidx": torch.zeros(1, dtype=torch.long, device=dev),
            "tidx": torch.zeros(1, dtype=torch.long, device=dev),
            "unfinished": torch.ones(B, dtype=torch.bool, device=dev),
            "out": torch.zeros(B, max_new, dtype=torch.long, device=dev),
            "eos": None,
            "pad": None,
        }
        self.shapes[key] = st
        return st

    def _bucket_cache(self, st: dict, cap: int):
        """Deponun ilk in_len+cap konumuna bakan görünümlü StaticCache."""
        import torch
        from transformers import StaticCache

        Lb = st["in_len"] + cap
        store = st["store"]
        c = StaticCache(config=self.model.config.text_config, max_cache_len=Lb)
        for lay, k, v in zip(c.layers, store["k"], store["v"]):
            lay.dtype, lay.device = k.dtype, k.device
            lay.batch_size, lay.num_heads = k.shape[0], k.shape[1]
            lay.k_head_dim, lay.v_head_dim = k.shape[3], v.shape[3]
            lay.keys = k[:, :, :Lb]
            lay.values = v[:, :, :Lb]
            lay.cumulative_length = torch.zeros((), dtype=torch.long, device=k.device)
            lay.is_initialized = True
        return c

    def _step(self, st: dict, b: dict) -> None:
        import torch

        mask = b["mask"]
        mask.index_fill_(3, st["cidx"], True)
        emb = self.text.embed_tokens(st["ids"])
        h = self.text(inputs_embeds=emb, attention_mask=mask, position_ids=st["pos"],
                      past_key_values=b["cache"], use_cache=True).last_hidden_state
        nxt = self.head(h[:, -1, :]).argmax(-1)
        nxt = torch.where(st["unfinished"], nxt, st["pad"])
        st["out"].index_copy_(1, st["tidx"], nxt.unsqueeze(1))
        st["unfinished"] &= nxt != st["eos"]
        st["ids"].copy_(nxt.unsqueeze(1))
        st["pos"].add_(1)
        st["cidx"].add_(1)
        st["tidx"].add_(1)

    def _enter_bucket(self, st: dict, cap: int) -> dict:
        """Kovayı hazırla (ilk kullanımda ısıt + yakala), konum sayacını ona aktar."""
        import torch

        b = st["buckets"].get(cap)
        if b is None:
            b = {"cache": self._bucket_cache(st, cap), "mask": st["mask"][..., : st["in_len"] + cap]}
            st["buckets"][cap] = b
        for lay in b["cache"].layers:
            lay.cumulative_length.copy_(st["cidx"][0])
        if "graph" not in b:
            names = ("ids", "pos", "mask", "cidx", "tidx", "unfinished", "out")
            snap = {k: st[k].clone() for k in names}
            lens = [lay.cumulative_length.clone() for lay in b["cache"].layers]

            def restore() -> None:
                for k in names:
                    st[k].copy_(snap[k])
                for lay, v in zip(b["cache"].layers, lens):
                    lay.cumulative_length.copy_(v)

            s = self.stream
            s.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(s):
                self._step(st, b)  # ısınma
            torch.cuda.current_stream().wait_stream(s)
            restore()
            g = torch.cuda.CUDAGraph()
            with torch.cuda.graph(g, pool=st["pool"]):
                self._step(st, b)
            restore()
            # Isınma/yakalama cidx konumuna yazdı: gerçek adım aynı konuma önce yazar, sonra okur.
            b["graph"] = g
        return b

    def generate(self, input_ids, attention_mask, generation_config, stopping_criteria=None, **mm):
        import torch

        B, in_len = input_ids.shape
        max_new = int(generation_config.max_new_tokens)
        eos_id = _first_id(generation_config.eos_token_id)
        pad_id = _first_id(generation_config.pad_token_id)
        # Ön doldurma stoktaki gibi DynamicCache ile (ilk token ve önbellek içeriği birebir
        # stok; tam uzunluk maskesinin geçici belleği yok), sonra K/V statik depoya.
        from transformers import DynamicCache

        dyn = DynamicCache(config=self.model.config.text_config)
        pos = attention_mask.long().cumsum(-1) - 1
        pos = pos.masked_fill(attention_mask == 0, 0)
        # logits_to_keep=1 (stok generate de böyle): tüm konumların logiti [B, girdi, 100480]
        # 1135 token'lık girdide >1 GB geçici bellek demekti.
        out = self.model(input_ids=input_ids, attention_mask=attention_mask, position_ids=pos,
                         past_key_values=dyn, use_cache=True, logits_to_keep=1, **mm)
        first = out.logits[:, -1, :].argmax(-1)
        del out
        store = self._storage(B, in_len + max_new, dyn)
        st = self._state(B, in_len, max_new, store)
        if st["eos"] is None:
            st["eos"] = torch.tensor(eos_id, device=input_ids.device)
            st["pad"] = torch.tensor(pad_id, device=input_ids.device)
        for lay, k, v in zip(dyn.layers, store["k"], store["v"]):
            k[:, :, :in_len].copy_(lay.keys)
            v[:, :, :in_len].copy_(lay.values)
        del dyn
        st["mask"].zero_()
        st["mask"][:, 0, 0, :in_len] = attention_mask.bool()
        st["ids"].copy_(first.unsqueeze(1))
        st["pos"].copy_(pos[:, -1:] + 1)
        st["cidx"].fill_(in_len)
        st["tidx"].fill_(1)
        st["unfinished"].copy_(first != st["eos"])
        st["out"].fill_(pad_id)
        st["out"][:, 0] = first

        crit = list(stopping_criteria or [])
        alive = [True] * B  # stoktaki unfinished_sequences (sunucu tarafı kopya)
        end_at = [0] * B  # satırın bittiği adım (üretilmiş token sayısı)
        checked = [0]  # işlenmiş son adım

        def settle(upto: int) -> None:
            """Stok generate'in checked+1..upto adımlarında yaptığını sırayla yap: önce
            ölçütler (o adıma kadarki dizilerle), sonra EOS. Ölçütün kapattığı satırın
            kalanı pad olur ve grafik de ondan sonra pad üretir."""
            toks = st["out"]
            first_j = checked[0] + 1
            new = toks[:, first_j - 1 : upto].tolist()
            for j in range(first_j, upto + 1):
                if crit and any(alive):
                    ids_j = torch.cat([input_ids, toks[:, :j]], dim=1)
                    done = torch.zeros(B, dtype=torch.bool, device=input_ids.device)
                    for c in crit:
                        r = torch.as_tensor(c(ids_j, None), device=input_ids.device).bool()
                        done |= r.expand(B) if r.dim() == 0 else r
                    for i in torch.nonzero(done).flatten().tolist():
                        if alive[i]:
                            alive[i] = False
                            end_at[i] = j
                            if j < toks.shape[1]:
                                toks[i, j:] = pad_id
                            st["unfinished"][i] = False
                for i in range(B):
                    if alive[i] and new[i][j - first_j] == eos_id:
                        alive[i] = False
                        end_at[i] = j
            checked[0] = upto

        n = 1  # üretilmiş token; sıradaki adım in_len + n - 1 konumuna yazar
        settle(1)
        if any(alive):
            caps = st["caps"]
            cap_i = 0
            b = self._enter_bucket(st, caps[cap_i])
            while n < max_new:
                room = caps[cap_i] - (n - 1)
                if room <= 0:
                    cap_i += 1
                    b = self._enter_bucket(st, caps[cap_i])
                    continue
                k = min(SYNC_EVERY, room, max_new - n)
                g = b["graph"]
                for _ in range(k):
                    g.replay()
                n += k
                settle(n)
                if not any(alive):
                    break
        # stok generate tüm satırlar bittiği adımda durur: genişliği oraya kırp
        width = max((end_at[i] if not alive[i] else n) for i in range(B))
        toks = st["out"]
        return torch.cat([input_ids, toks[:, :width].clone()], dim=1)


def wrap(orig, model):
    """`orig` (stok model.generate) yerine geçen: uygun çağrı grafik yolunda."""
    holder: dict[str, Any] = {}

    def generate(*args, **kwargs):
        if args or not enabled() or not eligible(model, kwargs):
            STATS["stock_calls"] += 1
            return orig(*args, **kwargs)
        if not _vram_ok(holder.get("dec")):
            # Boş VRAM az: depo/grafik ayırmak yerine bu çağrı stok yoldan.
            release()
            STATS["stock_calls"] += 1
            STATS["low_vram"] += 1
            return orig(*args, **kwargs)
        try:
            import torch

            dec = holder.get("dec")
            if dec is None:
                dec = holder["dec"] = GraphDecoder(model)
            with torch.inference_mode():
                res = dec.generate(**kwargs)
            # Ön doldurmanın geçici blokları + K/V deposu yanında parçalanma ayrılmış belleği
            # ~1 GB şişiriyordu (Carroll 30 s.: nvidia-smi tepe 2,6 -> 3,8 GB); sohbet modeli
            # de GPU'dayken bu pay önemli, boş blokları her grupta sürücüye geri ver.
            torch.cuda.empty_cache()
            STATS["graph_calls"] += 1
            return res
        except Exception as err:  # noqa: BLE001 — hız iyileştirmesi; dönüşümü asla bozmaz
            _DISABLED[0] = True
            holder.clear()
            _warn(f"CUDA grafiği hatası ({type(err).__name__}: {err})")
            STATS["stock_calls"] += 1
            return orig(*args, **kwargs)

    return generate
