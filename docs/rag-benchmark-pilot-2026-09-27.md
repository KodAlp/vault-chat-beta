# RAG kalite benchmark'ı — pilot raporu (2026-09-27)

Dal: `kalite-ve-logo`. Veri seti ve ham sonuçlar kişisel not içeriği taşıdığı için repoda
değil, `data/vaults/default/bench/` altında (gitignore). Bu belge yalnızca toplu sayıları içerir.

## Kapsam ve yöntem

- **Korpus:** `default` kasası — 330 dosya, 2.438 parça, 13 alan; notlar çoğunlukla İngilizce.
- **Pilot altın set:** 70 soru (60 çekirdek + 6 takip + 4 selamlaşma), 48 TR / 22 EN, 12 alan.
  Tür dağılımı belgedeki 300'lük planın beşte biri: direct 10, conceptual 10, multi_hop 10,
  cross_document 8, comparison 6, numerical 6, long_context 4, ambiguous 3, unanswerable 3.
  Sorular iki Claude Sonnet alt ajanına, sistemden bağımsız olarak, tabakalı örneklenmiş
  parçalardan yazdırıldı. 152 ilgililik etiketinin tamamı canlı indekse çözüldü.
  Soru↔parça sözcük örtüşmesi ortalama 0,25 (en yüksek 0,59): sorular notları kopyalamıyor.
- **Kararlı çapa:** `chunks.id` her yeniden indekslemede değiştiği için etiketler
  `sha1(path | heading_path | metin)` çapasına bağlı (`bench/lib/anchor.ts`).
- **İstatistik:** her metrik bootstrap %95 güven aralığıyla; varyant farkları eşleştirilmiş
  randomizasyon testiyle (`p`). Pilot küçük: CI'lar geniş, sonuçlar yön göstericidir.
- **Test edilen sistem (SUT):** qwen3:8b (Ollama), sohbet rotasının retrieval + istem yolu.
- **Yargıç:** deepseek-v4-pro, T=0, sabit ve hash'li istem (sha1 `262ac913…`).
- **İzolasyon:** her koşuda `chats.db`, `index.db`, `study.db` boyut+mtime önce/sonra aynı.

## 1. Retrieval (n=63 cevaplanabilir, parça düzeyi)

| Pipeline | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | Ek gecikme |
|---|---|---|---|---|---|
| `prod` (bugünkü: k=6, eşik 0.6, dosya başına ≤3) | 0.741 | 0.763 | 0.846 | 0.739 | ~0,35 s (CPU embed) |
| `prod+kw` (sohbetin keyword yedeği) | 0.741 | 0.763 | 0.846 | 0.739 | — |
| `vector-raw` (eşik/üst sınır yok) | 0.753 | 0.860 | 0.850 | 0.775 | — |
| `bm25` | 0.459 | 0.591 | 0.527 | 0.486 | — |
| `hybrid` (RRF) | 0.681 | 0.800 | 0.806 | 0.718 | — |
| `vector+rerank` | 0.790 | 0.880 | 0.854 | 0.806 | +0,5 s (GPU) |
| **`hybrid+rerank`** | **0.800** | **0.877** | **0.854** | **0.807** | **+0,5 s (GPU)** |
| `hybrid+rerank+qx` | 0.749 | 0.876 | 0.818 | 0.788 | +3,9 s |

- `hybrid+rerank` prod'a göre anlamlı: p(Recall@5)=0.041, p(nDCG@10)=0.009. İngilizce sorularda
  Recall@5 0.69 → 0.79, Türkçede 0.76 → 0.80. Tür bazında en büyük kazançlar long_context
  (0.60 → 0.83), direct (0.78 → 0.92) ve cross_document nDCG (0.72 → 0.87).
- Dosya düzeyinde Recall@5: prod 0.913 → hybrid+rerank 0.947. Hit@5 prod'da 0.95: ilk sıralar
  iyi, kısıt k=6 ve dosya başına 3 parça sınırında.
- BM25 tek başına zayıf ve eşit ağırlıkla karıştırıldığında vektörü kötüleştiriyor (TR soru /
  EN not). Etiketler FTS aramasıyla tamamlandığı için ölçüm BM25 lehine yanlıydı — buna rağmen.
- Sorgu genişletme (qwen3:8b ile EN'ye yeniden yazım) kazanç vermedi, ~3,4 s ekledi → elendi.
- Sohbetin keyword yedeği pilotta hiç tetiklenmedi (vektör araması hiç boş dönmedi).

### Retrieval düzeyinde çekimserlik

| vector-raw mesafe eşiği | cevapsız soruda boş sonuç (iyi) | cevaplı soruda yanlış-boş | Recall@5 |
|---|---|---|---|
| 0.45 | 7/7 | 1/63 | 0.709 |
| 0.50 | 4/7 | 0/63 | 0.741 |
| **0.60 (bugün)** | **0/7** | 0/63 | 0.741 |

(7 = 3 cevapsız + 4 selamlaşma.) Reranker skoru ayrımı çok daha net yapıyor: en iyi adayın
skoru cevapsızlarda p90 ≤ 0.02, cevaplıların p10'u 0.26. Ama eşik bedelsiz değil: 0.05 eşiği
cevapsızların 7/7'sini süzer, 3 cevaplanabilir soruyu da düşürür (2'si ambiguous — orada da ideal
davranış netleştirme istemek — 1'i direct). Eşik tam sette kalibre edilmeli.

Grafikler: `python bench/charts.py` → `~/Desktop/RAG-benchmark-grafikleri/` (7 PNG).

### Reranker maliyeti (bge-reranker-v2-m3, ölçüldü)

| | GPU fp16 | CPU fp32 |
|---|---|---|
| Yükleme | 4,0 s | 3,9 s |
| 30 aday | ~0,2–0,5 s | 17 s (uzun pasajlarla) |
| Bellek | 1,17 GB VRAM, 2,6 GB RAM | 3,4 GB RAM |

qwen3:8b + KV önbelleği 6 GB'ı doldurduğu için GPU'da ikisi birlikte sığmıyor; CPU fp32 sohbet
için fazla yavaş. ONNX int8 CPU yolu ölçülmedi (açık).

## 2. Üretim, atıf, halüsinasyon (n=70; yargıç: deepseek-v4-pro)

| Metrik | Değer |
|---|---|
| Answer Correctness (1–5, cevaplanabilir) | 3.84 [3.59, 4.10]; ≥4: %68 |
| Answer Relevance (1–5) | 4.57 [4.37, 4.74]; ≥4: %89 |
| Faithfulness | 0.77 [0.70, 0.84] |
| Desteklenmeyen iddia oranı | %16,7 [10,1, 24,3] |
| Halüsinasyon oranı (≥1 desteksiz iddia, cevaplanabilir) | %35 |
| **Abstention accuracy (cevapsız 3 soru)** | **0/3** |
| Yanlış çekimserlik (cevaplanabilir) | 0 |
| Selamlaşmada nota değinmeme | 4/4 |
| Yanıt dili uyumu ({tr, en} ile sınırlı tespit) | 67/69 (%97) |
| Multi-hop doğruluk (≥4) | %70 (n=10) |
| Cross-document doğruluk (≥4) | %38 (n=8) |
| Kaynak listesi kesinliği (gösterilen parça ≥1 iddiayı destekliyor) | %49 |
| Citation recall (atıf gerektiren iddia, gösterilen bir parçayla destekli) | %88 |
| Anılan başlık kesinliği | %91 (n=43) |
| Bağlam alakası (parça derecesi ≥1) | %71 |

**Performans (qwen3:8b, RTX 4050 6 GB):** TTFT P50 1,5 s / P95 2,0 s · üretim P50 24 s /
P95 70 s · 15,8 tok/s. Sohbet rotasındaki 4096 token çıktı tavanı SUT'ta uygulanmadı
(bkz. sapmalar); P95 bu yüzden gerçek uygulamadan yüksek olabilir.

**Yargıç güvenilirliği:** 10 cevabı yeniden puanlamada doğrulukta 10/10 tam uyum, ortalama
|Δ faithfulness| 0.044. Sağlama: 3 cevaba kaynaklarda olmayan makul bir cümle eklenince
faithfulness üçünde de düştü (ortalama −0.18). Maliyet ~1,30 $ (83 çağrı; DeepSeek akışta
kullanım bilgisi göndermediği için karakterden ihtiyatlı tahmin).

## 3. Bulgular — önem sırasıyla

1. **Sistem bilmediğini söylemiyor.** Cevapsız soruların hiçbirinde retrieval boş dönmüyor
   (eşik 0.6) ve model eldeki alakasız parçalardan cevap kuruyor (0/3 çekimserlik, üçünde de
   desteksiz iddia). Pilotta yalnızca 3 cevapsız soru var — yön kesin, oran değil.
2. **Gösterilen kaynakların yarısı gereksiz** (%49 kesinlik). Kullanıcı hangi kaynağın
   gerçekten kullanıldığını ayırt edemiyor.
3. **Reranker ikisine birden aday çözüm:** sıralamayı anlamlı iyileştiriyor ve skoru
   cevapsızları net ayırıyor → skor eşiği hem boş sonuç (çekimserlik) hem daha az ama ilgili
   kaynak verebilir. Engel: 6 GB VRAM'de sohbet modeliyle birlikte çalıştırma maliyeti.
4. **Cross-document sorular zayıf** (%38): iki farklı notu birleştirme hem retrieval'da
   (dosya başına sınır, k=6) hem üretimde zorlanıyor.
5. **Ucuz iyileştirme:** mesafe eşiğini 0.50'ye çekmek pilotta hiçbir şey kaybetmeden
   cevapsızların yarısından fazlasını süzüyor — ama `select-chunks.ts`'teki eski ölçüm doğru
   sonuçların 0.57'ye kadar çıkabildiğini kaydediyor; tam sette doğrulanmadan değiştirilmemeli.

## 4. Gerçek sohbetten sapmalar (sonuçları okurken hesaba katılmalı)

- **Kullanıcı skill'leri kapalıydı.** İzolasyon için boş `SKILLS_DIR` kullanıldı; gerçek
  sohbette `educational-agent` (4,1 KB, Türkçe, kapsam `chat`, "uydurma yok, eksik olanı
  söyle" kuralı dahil) açık. Çekimserlik sonucu bu skill ile farklı olabilir — ölçülmedi.
- smallTalkGate atlandı (ilk çağrıda `chats.db`'ye tohum yazabiliyor).
- Ollama'ya doğrudan istek: fallback zinciri, resume/bozulma yeniden üretimi, araç turu yok.
- `num_ctx` 8192 sabit; `num_predict` (4096) uygulanmadı.
- Hiçbir mesaj `chats.db`'ye yazılmadı.

## 5. Ölçüm sırasında bulunup düzeltilenler

- **İngilizce soruya Türkçe cevap** (`82b9b2c`): kök neden sistem istemindeki "Her zaman
  Türkçe cevap ver"; ölçümle seçilen çözüm 30 vaka × 3 tekrarda 90/90 (eski davranış ~%57).
  Birincil dil adı çözümündeki ikinci hata da düzeltildi (franc tek sözcükte "English"i
  Özbekçe, "İngilizce"yi Svahili sanıyordu).
- **Reranker UTF-8** (`303ed31`): Windows'ta Python stdin'i cp1254 okuyordu; Türkçe sorgular
  bozuk gidiyordu (aynı çift 0.004 → 0.062). Reranker sonuçlarının hepsi düzeltmeden sonra.
- **Yanıt dili metriği** (`e9e103f`): tüm-dil marj kapısı uzun teknik cevapların 69/70'ini
  eliyordu (n=1); {tr, en} ile sınırlandı.
- **Kaspersky HTTPS denetimi:** Node'un yerleşik CA listesi Kaspersky kökünü tanımadığı için
  DeepSeek'e `SELF_SIGNED_CERT_IN_CHAIN`. Yargıç koşusu `NODE_OPTIONS=--use-system-ca` ile
  (doğrulama açık, Windows deposu). Uygulamanın bulut sağlayıcı yolu aynı sorundan etkilenebilir
  — test edilmedi.

## 6. Açık maddeler

- **Sistem istemi / skill dili hipotezi (kullanıcı önerisi):** qwen3:8b'ye giden tüm
  talimatlar Türkçe (çekirdek istem + `educational-agent`). İngilizce talimat küçük modelde
  çekimserliği/sadakati iyileştirir mi? — A/B deneyi önerildi, koşulmadı.
- Tam set (330 soru; özellikle 15 cevapsız soruyla eşik kalibrasyonu) — kullanıcı kararıyla ertelendi.
- ONNX int8 reranker CPU maliyeti; korpus ölçekleme; ingestion benchmark'ı; 30 cevaplık insan
  değerlendirmesi (`bench/human-eval.ts` hazır, uygulanmadı).

## Yeniden üretmek

```bash
npm run bench:validate -- --vault default --file data/vaults/default/bench/work/golden-pilot.jsonl --targets pilot
npm run bench:retrieval -- --vault default --file data/vaults/default/bench/work/golden-pilot.jsonl --label pilot --rerank-device cuda --rerank-dtype fp16
npm run bench:generation -- --vault default --file data/vaults/default/bench/work/golden-pilot.jsonl --no-judge --label sut
NODE_OPTIONS=--use-system-ca npm run bench:generation -- --vault default --file data/vaults/default/bench/work/golden-pilot.jsonl --answers <sut koşusunun answers.jsonl> --allow-cloud deepseek-api --max-cost-usd 2.10 --rejudge 10 --sanity --label judged
```
