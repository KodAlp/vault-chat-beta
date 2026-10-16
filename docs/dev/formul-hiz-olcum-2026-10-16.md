# Formül yoğun PDF'lerde hız (#82) — 2026-10-16

## Düzen

- Donanım: RTX 4050 Laptop 6 GB, Windows 11, Python 3.12, torch 2.8.0+cu128, transformers 5.17, docling 2.130.
- Kod: main `40c201b` üstü, `ingest/convert.py --tool docling` (uygulamanın hattı).
- Profil: formül/kod modelinin (`CodeFormulaV2`, Idefics3: 576 gizli boyut, 30 katman, 3 KV başı, bf16) `predict_batch` çağrıları zamanlandı; gruplar diske alınıp modelle doğrudan, docling'siz yeniden çözüldü (çıktı docling'inkiyle 71/71 aynı).

## Darboğaz

DavidTong_Electromagnetism s. 20–39: toplam 105 sn, bunun 63,5 sn'si formül modeli (71 formül, 5'li 15 grup).

| Bulgu | Ölçüm |
|---|---|
| Token başına süre | 33 ms (bf16, SDPA, KV önbelleği açık) |
| cProfile, 63 adımlık bir generate | 2,4 sn; 13.366 `linear`, 7.812 `cat` çağrısı; GPU çoğunlukla boşta |
| Döngü kesicinin payı | yok (kapalıyken 61,8 sn, açıkken 62,6) |
| 5'li grubu bekleten | en uzun formül (664 karakter → 8,9 sn'lik grup) |

Yani sorun Windows'ta Python + çekirdek başlatma yükü. GPU'nun adım başına asıl işi 1–2 ms.

## Denenen ve bırakılanlar

| Deneme | Formül süresi | Not |
|---|---|---|
| Stok | 61,2–63,5 sn | |
| 40'lık grubu genişliğe göre sırala, 5'li alt grup | 60,6 | |
| … 10'lu alt grup | 48,6 | bazı satırlar döngüye girip yeniden denendi |
| … 16'lı alt grup | 70,6 | 15'lik bir grup 41,6 sn |
| Grafik decoder + sıralı 10/15'li | 66 / 102 | ön doldurma (görüntü kodlayıcı, grup başına ~45 parça) VRAM baskısıyla çöküyor |
| `torch.compile` (Inductor) | — | Triton kurulu değil |
| `cudagraphs` arka ucu + statik önbellek | 133,8 | HF forward'ında grafik kırılmaları; nesne kimliğinden 8 kez yeniden derleme |
| Elle CUDA grafiği, tek 2653 konumluk önbellek | 33 → 16 ms/token | `repeat_kv` (6,3 ms) ve dikkat (5,7 ms) tüm önbellek uzunluğu üzerinden |

## Uygulanan: `ingest/formula_graph_decode.py` (`6f5297d`)

- Ön doldurma stoktaki gibi (DynamicCache, `logits_to_keep=1`), K/V sonra grup boyutu başına tek statik depoya kopyalanır.
- Her token tek `graph.replay()`: gömme → 30 katman → lm_head → argmax → EOS takibi.
- Kovalar (128 / 512 / max üretilen token) deponun ön kısmına bakan görünümler; dikkat ve `repeat_kv` kova uzunluğuyla orantılı. Token başına 7–10 ms.
- Durdurma ölçütleri (döngü kesici, docling) her 8 adımda bir, aradaki her adım için stoktaki sırayla çağrılır.
- Stok yola düşenler: `repetition_penalty`'li yeniden deneme, örnekleme, CPU, az boş VRAM; grafik yolunda hata olursa süreç boyunca stok. `VC_FORMULA_CUDA_GRAPH=0` kapatır.
- Belgenin formül aşaması bitince depo ve grafikler bırakılır (MinerU yedeği GPU'ya ondan sonra yüklenir).

### Hız (toplam dönüşüm)

| Belge | Sayfa | Blok | Stok | Grafik | Formül modeli |
|---|---|---|---|---|---|
| Tong EM | 20–39 | 71 formül | 104 sn | 76 sn | 62,5 → 34,9 |
| Likharev QM (3 döngü) | 1–30 | 106 | 198 | 135 | 106 → 47 |
| Carroll GR | 40–69 | 81 | 221 | 144 | 135 → 52 |
| bgnet (C kodu) | 30–49 | 30 kod | 88 | 49 | 79 → 40 |
| JeffE algoritmalar | 40–59 | 32 | 84 | 65 | 38 → 20 |

Formül/kod modeli 2,2–2,6 kat, toplam dönüşüm 1,3–1,8 kat hızlı. Döngü kesici iki yolda da aynı satırları aynı noktada kesti (Likharev: 3 satır, tasarruf tahmini 5732 token).

### Çıktı

- Grafik yolu HF'nin kendi statik önbellekli `generate`'iyle birebir aynı (Carroll 81/81).
- Stokla 320 blokta 6 tek-token farkı. Stok kendi içinde belirlenimli (iki koşu 81/81 aynı); fark statik uzunlukta dikkatin toplama sırasından (bf16'da neredeyse eşit iki aday). Sabit şekilli grafikte kaçınılmaz.
- 6 fark PDF'le elle karşılaştırıldı, hiçbiri içerik hatası değil: Carroll (3.16) `T_{μν}{}^λ` grafikte PDF'e daha yakın, s. 59 sonundaki ∇g dizisinde `{r c l}` stokta daha yakın, bir `\intertext` düzyazı çöpü ikisinde de bozuk; bgnet `close(sockfd);` grafikte doğru; Likharev (1.66) stokta `cases`, grafikte MinerU yedeğinin dizisi, ikisi de doğru; `({r})` ↔ `(r)` aynı görünüyor.
- KaTeX (`scripts/validate-math.mjs`): 5 belgede iki modda da 0 hata.

### Bellek

| Ölçüm (Carroll 40–69, nvidia-smi) | Stok | Grafik |
|---|---|---|
| Formül aşaması | 2,4 GB düz | 1,9 GB, ön doldurmada 2,7'ye sıçrama |
| MinerU yedek aşaması | 2,4–2,6 GB | 3,2 GB |

İlk sürüm 3,8 GB'a çıkıyordu; nedenleri ve düzeltmeleri: ön doldurmada tüm konumların logiti (`logits_to_keep=1`), şekil başına ayrı tam boy önbellek (grup boyutu başına tek depo), her yakalamada yeni akış (tek yan akış), MinerU'dan önce bırakmama (`release()`). MinerU aşamasındaki fark, boşalan belleği gören MinerU'nun daha büyük grup seçmesine benziyor (doğrulanmadı).

qwen3:8b GPU'da yüklüyken: Carroll 10 sayfa 46 sn, tepe 5,84/6,14 GB, hata yok. Windows (WDDM) VRAM'i sanallaştırıyor: boştaki Ollama modeli sistem belleğine iniyor ve `mem_get_info` onu boş sayıyor, yani düşük VRAM koruması yalnız gerçek dolulukta devreye girer; taşma OOM değil sayfalama olur.

## Sonraki adımlar (aynı gece)

Grafik decoder'dan sonra Carroll 30 sayfanın aşamaları (docling profil zamanları + sarmalayıcılar):

| Aşama | Süre |
|---|---|
| Formül modeli (`predict_batch`, grafikli) | 48–50 sn |
| MinerU yedeği (25 formül, `toplevel_align`) | 36,5 sn |
| Formül kırpımı (`prepare_element`, 81 formül) | 25,5 sn |
| İşlemci (görüntü → 512'lik parçalar, CPU) | 5,1 sn |
| Metin katmanı okuma (başlık onarımı için) | 4,5 sn |

### Formül kırpımı: ızgara (`e172d97`)

`formula_crop._v2_segments` sayfadaki karakterleri x'e göre sıralı tarayıp aynı x aralığındaki tüm satırları ikili karşılaştırıyordu (8 formülde 15 milyon `max()` çağrısı). Bağ koşulu simetrik ve yatay boşluk < maxgap ile dikey örtüşme gerektirdiği için sonuç "koşulu sağlayan tüm çiftlerin birleşimi"; aday çiftler artık bir ızgaradan geliyor, koşul aynı ifadelerle sınanıyor. 300 rastgele düzende ve 108 gerçek sayfa çağrısında bileşenler ve sıraları birebir aynı; gerçek sayfalarda 14,6 → 0,9 sn. Carroll: `prepare_element` 25,5 → 5,3 sn, toplam 131 → 111 sn, Markdown birebir aynı.

### MinerU grup boyutu (`9a3ac39`; varsayılan 12)

| Grup | Yedek süresi | Tepe VRAM | Çıktı |
|---|---|---|---|
| 4 | 36,4 sn | 3,18 GB | — |
| 8 | 28,5 sn | 3,41 GB | 25 formülün 3'ünde tek-token farkı |
| 12 (varsayılan) | 21,4 sn | 3,68 GB | aynı 3 formül (biri 12'de daha doğru: `	ext{(2.43)}`) |

Aynı grup boyutunda belirlenimli. `VC_FORMULA_FALLBACK_BATCH` ile ayarlanır. 2026-10-16 kullanıcı kararı: varsayılan 12 (farklı 3 formülden biri 12'de daha doğru, ikisi tek-token farkı; ayrıca −15 sn).

### Birikimli (Carroll GR s. 40–69)

221 sn (stok) → 144 (CUDA grafiği) → 111 (kırpım ızgarası); MinerU 12'li grupla ~96 sn.

## Kalan fırsatlar (ölçülmedi)

- Grafikli decode adımı artık GPU sınırlı: 7,1 ms/adım (kova 128, girdi 605, grup 5); dikkat 1,5 ms, `repeat_kv` kopyası 1,5 ms, ağırlık çarpımları 2,4 ms (bellek bant genişliği tabanı ~1,4 ms), diğer ~1,5 ms. `repeat_kv`'siz GQA'lı SDPA (özel dikkat işlevi) adımı ~%20–40 kısaltabilir; çekirdek seçimi değişeceği için çıktı yeniden karşılaştırılmalı.

- İşlemci (görüntüyü 2048 kenara büyütüp 512'lik parçalara bölme) grup başına ~0,37 sn CPU; GPU decode ile örtüştürülebilir (~%15 formül süresi).
- 40'lık grubu genişliğe göre sıralayıp 5'li çözmek ~%8.
- Görüntü kodlayıcı (ön doldurma) grup başına ~0,5 sn GPU; modelin girdisini değiştirmeden küçülmez.
