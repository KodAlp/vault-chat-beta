# RAG benchmark: tam altın set, retrieval (2026-10-18)

Pilotun (`docs/rag-benchmark-pilot-2026-09-27.md`) devamı. Veri seti ve ham sonuçlar kişisel not içeriği taşıdığı için repoda değil, `data/vaults/default/bench/` altında (gitignore). Bu belge yalnız toplu sayıları içerir. Üretim/yargıç koşusu bu belgede yok.

## Veri seti

- **330 soru** = pilotun 70'i + 260 yeni. Tür dağılımı `FULL_TARGET`'la birebir: direct 50, conceptual 50, multi_hop 50, cross_document 40, comparison 30, numerical 30, long_context 20, ambiguous 15, unanswerable 15, followup 20, smalltalk 10. Sorular 228 TR, 102 EN. Zorluk dağılımı: easy 65, medium 173, hard 92.
- Yeni sorular, pilotla aynı yöntemle yazıldı. Beş Claude Sonnet alt ajanı, pilotla çakışmayan tabakalı tohumlardan (`sample-chunks.ts --batches 10 --seed 11`) sistemden bağımsız olarak çalıştı. İlgili parçalar `inspect.ts search` ile tamamlandı.
- 934 ilgililik etiketinin tamamı canlı indekse çözüldü. Doğrulayıcı 0 hata verdi. 3 uyarının kaynağı, aynı notun iki bölümünden kurulan multi_hop ve comparison soruları.
- **Etiket kuralı (pilotla aynı):** `cards/` parçaları etiketlenmedi. `wiki/` ve `wiki/*/sources/` etiketlendi. Retrieval'ın getirdiği kart parçası ilgisiz sayılıyor. Kartlar indeksin %9'u (221/2438 parça).
- Cevapsız sorularda alt ajanlar aynı konuları seçmişti (differential privacy 4 kez geçiyordu). Tekrarlanan 6 sorunun yerine kasada sıfır FTS isabeti olan konular yazıldı: QUIC, OAuth PKCE, Kotlin coroutines, LoRaWAN, WebRTC, GraphQL.
- Soru↔parça sözcük örtüşmesi ortalama 0,263 (pilot 0,250).

## Retrieval (n=305 cevaplanabilir, parça düzeyi)

| Pipeline | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | Pilot R@5 |
|---|---|---|---|---|---|
| `prod` | 0.688 [0.654, 0.721] | 0.720 | 0.837 | 0.706 | 0.741 |
| `vector-raw` | 0.697 | 0.822 | 0.839 | 0.746 | 0.753 |
| `bm25` | 0.435 | 0.569 | 0.521 | 0.464 | 0.459 |
| `hybrid` (RRF) | 0.651 | 0.797 | 0.794 | 0.702 | 0.681 |
| `vector+rerank` | 0.740 | 0.854 | 0.889 | 0.790 | 0.790 |
| **`hybrid+rerank`** | **0.748 [0.717, 0.778]** | **0.851** | **0.889** | **0.788** | **0.800** |

- Mutlak değerler pilottan 3–5 puan düşük. Yeni sorularda etiketler daha kapsamlı: yeni soruların her birine ortalama 3,2 etiket düşüyor, pilottakilere 2,4. Bu yüzden recall'ın paydası büyüdü. Sıralama ve sonuç ise aynı.
- **Reranker kazancı tam sette kesinleşti.** `hybrid+rerank` ile `prod` farkı Recall@5'te +0,06, nDCG@10'da +0,08; ikisinde de p < 0,001 (pilotta p=0,041 ve 0,009). MRR 0,837'den 0,889'a, Hit@5 0,961'den 0,990'a çıkıyor.
- `vector+rerank` ile `hybrid+rerank` arasında fark yok. Reranker varken BM25 dalı hiçbir şey eklemiyor.
- `prod+kw` `prod` ile birebir aynı: anahtar sözcük yedeği 330 soruda bir kez bile tetiklenmedi.
- Dosya düzeyinde Recall@5: `prod` 0,897, `hybrid+rerank` 0,944.
- Türe göre en büyük kazançlar şunlar:
  - direct: 0,80 → 0,92
  - numerical: 0,86 → 0,96
  - long_context: 0,49 → 0,64
  - cross_document nDCG: 0,66 → 0,79
- Reranker iki türde kazanç vermiyor:
  - multi_hop: 0,62 → 0,60
  - ambiguous: 0,40 → 0,37 (belirsiz soruda tek yorumu öne çekiyor)
- Dile göre Recall@5 (`prod` → `hybrid+rerank`): TR 0,689 → 0,738, EN 0,685 → 0,769.
- Reranker GPU fp16'da en fazla 1,27 GB VRAM kullandı.

## Çekimserlik eşiği (pilotun açık sorusu)

25 soru cevapsız sayılıyor: 15 unanswerable ve 10 smalltalk.

**Mesafe eşiği (`vector-raw`):**

| Eşik | Cevapsızda boş (iyi) | Cevaplıda yanlış-boş | Recall@5 |
|---|---|---|---|
| 0.45 | %84 | %2,3 | 0.644 |
| 0.50 | %36 | %0,3 | 0.684 |
| 0.55 | %12 | 0 | 0.688 |
| **0.60 (bugün)** | **0** | 0 | 0.688 |

**Reranker en iyi aday skoru (`hybrid+rerank`):**

| Eşik | Cevapsız+smalltalk süzülen (/25) | Cevaplanabilir düşen (/305) | Bunların belirsiz olanı |
|---|---|---|---|
| 0.01 | 19 | 2 | 2 |
| **0.02** | **23** (15 unanswerable'ın 15'i) | **7** | 4 |
| 0.03 | 24 | 9 | 4 |
| 0.05 | 24 | 15 | 6 |
| 0.10 | 25 | 20 | 7 |

- Unanswerable sorularda en iyi skor hiçbir zaman 0,0164'ü geçmiyor. Cevaplanabilir sorularda medyan skor 0,80.
- 0,02 eşiğinde düşen 7 sorunun 4'ü ambiguous; bunlarda da ideal davranış netleştirme istemek. Kalan 3'ü (2 multi_hop, 1 direct) gerçek kayıp.
- **Sonuç:** mesafe eşiğini düşürmek çekimserlik için kötü bir takas; 0,45 cevaplanabilir soruların %2,3'ünü kaybediyor. Reranker skoru ise 0,02'de neredeyse bedelsiz ayırıyor. Pilottaki "eşik tam sette kalibre edilmeli" maddesinin cevabı bu.

## Yeniden üretmek

Tüm komutlar `DATA_DIR=<repo>/data` ile çalıştırılır.

```bash
npm run bench:validate -- --vault default --file data/vaults/default/bench/work/golden-full.jsonl --targets full
npm run bench:retrieval -- --vault default --file data/vaults/default/bench/work/golden-full.jsonl --variants prod,prod+kw,vector-raw,bm25,hybrid,vector+rerank,hybrid+rerank --rerank-device cuda --rerank-dtype fp16 --label full-330
```

Koşu: `results/2026-10-18T12-13-53-527Z-full-330`, git `24509c6`, veri seti sha1 `4012b154`. Koşu öncesi ve sonrasında `chats.db`, `index.db` ve `study.db` aynı kaldı.

## Açık

- Üretim ve yargıç koşusu (330 cevap, qwen3:8b + deepseek-v4-pro). Pilot 70 soruda ~1,30 $ tuttu; tam sette ~6 $ bekleniyor.
- `default` indeksinde 6 `_meta` parçası duruyor. `c2f2b49`'dan beri `_meta` indekslenmiyor, ama bu kasa o tarihten sonra yeniden indekslenmedi.
