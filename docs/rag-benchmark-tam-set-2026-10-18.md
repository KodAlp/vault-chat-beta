# RAG benchmark: tam altın set (2026-10-18)

Pilotun (`docs/rag-benchmark-pilot-2026-09-27.md`) devamı. Veri seti ve ham sonuçlar kişisel not içeriği taşıdığı için repoda değil, `data/vaults/default/bench/` altında (gitignore). Bu belge yalnız toplu sayıları içerir.

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

## Üretim, atıf, halüsinasyon (n=330)

- **Test edilen sistem:** pilotla aynı. Model qwen3:8b (Ollama), kullanıcı skill'leri kapalı, `num_ctx` 8192, çıktı tavanı uygulanmadı. 330 cevabın hepsi üretildi, hata yok.
- **Yargıç:** pilotta deepseek-v4-pro'ydu. Tam sette DeepSeek bakiyesi 76. soruda bitti, bu yüzden 330 cevabı aynı yargıç istemiyle (sha1 `262ac913…`) 15 Claude Sonnet 5.5 alt ajanı puanladı. Çıktılar `parseJudgeResponse` ile doğrulandı (330/330 geçerli) ve `bench/cache/judge.jsonl` üzerinden `run-generation.ts`'in kendi metrik hattına verildi.
- **Yargıçlar arası uyum:** DeepSeek'in bakiye bitmeden puanladığı 73 ortak cevapta karşılaştırıldı.
  - Doğruluk puanı: 55'inde birebir aynı, hepsinde fark en fazla 1. Spearman 0,88; "≥4" kararında %90 uyum.
  - Ortalamalar: Sonnet 3,78, DeepSeek 3,86. Alakada 62/73 birebir aynı.
  - Sonnet biraz daha katı. Pilotla karşılaştırırken doğrulukta yaklaşık 0,1'lik bir yargıç kayması hesaba katılmalı.

| Metrik | Tam set (Sonnet) | Pilot (DeepSeek, n=70) |
|---|---|---|
| Correctness (1–5, cevaplanabilir) | 3.67 [3.56, 3.79] | 3.84 |
| Correctness ≥4 | %61 [55, 67] | %68 |
| Relevance (1–5) | 4.37 [4.26, 4.46] | 4.57 |
| Faithfulness | 0.745 [0.715, 0.773] | 0.77 |
| Desteklenmeyen iddia oranı | %18,4 [15,5, 21,4] | %16,7 |
| Halüsinasyon oranı (cevaplanabilir) | %48 | %35 |
| **Abstention accuracy** | **0/15** | 0/3 |
| Yanlış çekimserlik (cevaplanabilir) | 0 | 0 |
| Selamlaşmada uyum | 9/10 | 4/4 |
| Yanıt dili uyumu | %99,4 (n=320) | %97 |
| Multi-hop doğruluk ≥4 | %52 (n=50) | %70 (n=10) |
| Cross-document doğruluk ≥4 | %55 (n=40) | %38 (n=8) |
| Kaynak listesi kesinliği | %48,5 | %49 |
| Citation recall | %85 | %88 |
| Bağlam alakası (parça ≥1) | %63 | %71 |

**Performans** (RTX 4050 6 GB): TTFT P50 1,7 s / P95 2,3 s · üretim P50 29 s / P95 73 s · 15,1 tok/s.

**Bulgular, önem sırasıyla:**

1. **Sistem bilmediğini hiç söylemiyor: 15 cevapsız sorunun 15'inde de uydurdu.** QUIC, OAuth PKCE, Kotlin coroutines, WebRTC, GraphQL, zk-SNARK gibi kasada hiç geçmeyen konuları kendi bilgisiyle uzun uzun anlattı. Cevapsız sorularda halüsinasyon oranı %96. Pilotta 3 soruyla görülen yön tam sette kesinleşti. Retrieval bölümündeki reranker eşiği (0,02) bu 15 sorunun hepsinde boş sonuç veriyor; asıl çare bu.
2. **Gösterilen kaynakların yarısı hâlâ gereksiz** (kesinlik %48,5, pilotla aynı).
3. **Cevaplanabilir sorularda da halüsinasyon yüksek:** cevapların %48'inde en az bir desteksiz iddia var. Doğru ama parçada olmayan bilgi de bu sayıma giriyor; yine de 8B model kaynağın dışına sık çıkıyor.
4. **Belirsiz sorularda netleştirme yok.** 15 ambiguous sorunun 13'ü doğrulukta 3 ya da altı aldı, 9'u 2 aldı. Model çoğunda tek bir yorumu sessizce seçti ("heap", "cache", "priority scheduling").
5. **Çıktı bozulmaları (%2,7):**
   - 4 cevap tekrar döngüsüne girdi. En uç örnek f4_029: aynı bölüm 61 kez, 58 bin karakter. Benchmark gerçek rotanın 4096 tokenlık tavanını uygulamıyor, ama döngü tavanla da tavanın sonuna kadar sürer.
   - 5 cevaba Çince sözcük karıştı.
   - Birkaç cevap ortada kesildi.
6. Multi-hop sonucu pilotta (%70) küçük örneklemden iyimser çıkmıştı; tam sette %52. Cross-document ise %38'den %55'e çıktı.

**Yargıç istemindeki hata (bu koşuda bulundu ve düzeltildi):** `buildJudgePrompt`, cevap ve parça metnini `String.replace`'e düz dize olarak veriyordu. Bu durumda metindeki `$'`, `` $` ``, `$&` desen sayılıp istemin parçaları veriye ekleniyordu; `$$` de `$` oluyordu. 330 istemin 13'ü bozuldu, 30'unda yalnız `$$` tek `$`'a indi. Fonksiyon değiştiriciyle düzeltildi ve teste bağlandı. Bozulan 13 istem düzeltilmiş hâlleriyle yeniden yargılandı. Yalnız `$$` farkı olan 30 istemin yargıları korundu, çünkü gösterilen matematik aynı. **Pilotun DeepSeek yargıları da bu hatayla alındı.** Etkisi küçük (~%4 istem), ama pilot sayıları bunu taşıyor.

## Yeniden üretmek

Tüm komutlar `DATA_DIR=<repo>/data` ile çalıştırılır.

```bash
npm run bench:validate -- --vault default --file data/vaults/default/bench/work/golden-full.jsonl --targets full
npm run bench:retrieval -- --vault default --file data/vaults/default/bench/work/golden-full.jsonl --variants prod,prod+kw,vector-raw,bm25,hybrid,vector+rerank,hybrid+rerank --rerank-device cuda --rerank-dtype fp16 --label full-330
```

Koşu: `results/2026-10-18T12-13-53-527Z-full-330`, git `24509c6`, veri seti sha1 `4012b154`. Koşu öncesi ve sonrasında `chats.db`, `index.db` ve `study.db` aynı kaldı.

Üretim ve rapor koşuları:

```bash
npm run bench:generation -- --vault default --file data/vaults/default/bench/work/golden-full.jsonl --no-judge --label full-sut
# yargılar bench/cache/judge.jsonl'de; hepsi önbellekteyse hiçbir bulut çağrısı yapılmaz
npm run bench:generation -- --vault default --file data/vaults/default/bench/work/golden-full.jsonl --answers <full-sut>/answers.jsonl --allow-cloud deepseek-api --judge-model claude-sonnet-5-5 --label full-judged-sonnet
```

Sonuçlar `results/2026-10-18T12-31-21-791Z-full-sut` (cevaplar) ve `results/2026-10-18T18-39-00-585Z-full-judged-sonnet` (rapor) altında. Raporun başlığındaki "(deepseek-api)" yalnız sağlayıcı alanı; yargılar Sonnet alt ajanlarından geliyor.

## Açık

- **İlk DeepSeek koşusu:** 76. soruda bakiye bittiğinde (HTTP 402) yaklaşık 1,2 $ harcanmıştı ve yargılar kayboldu. Kod artık her yargıyı anında `bench/cache/judge.jsonl`'e yazıyor ve 401/402'de duruyor.
- **Öz-tutarlılık denemeleri yapılmadı:** `--rejudge` ve `--sanity` bu yargıç yolunda çalışmadı. Yani aynı cevapları yeniden puanlatma ve bilerek desteksiz cümle eklenmiş cevapla sağlama yapılmadı.
- **`_meta` parçaları:** `default` indeksinde 6 tane duruyor. `c2f2b49`'dan beri `_meta` indekslenmiyor, ama bu kasa o tarihten sonra yeniden indekslenmedi.
