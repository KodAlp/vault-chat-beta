# Embedding'siz (yalnız-FTS) mod: anahtar kelime kapısı ölçümü — 2026-10-01

## Neden
Aşama 4 ile embedding isteğe bağlı oldu; embedding yoksa arama yalnız FTS5 anahtar kelime
aramasıyla yapılıyor. O yol, F5'te **geçici** bir yedek olarak tasarlanmıştı: tüm terimler
VE'lenir, ≥2 terim gerekir (selamlaşma sızıntısını 12/24 → 0/32'ye indiren kapı, bkz.
`docs/plan-ogrenme-ajani-ve-performans.md` §F5). Yalnız-FTS modunda ana yol olunca kalitesi ölçüldü.

## Düzen
- `default` kasasının kopyası (`index.db` tutarlı yedekle, 2 438 parça; `library`), gerçek dosyalar
  yalnız okundu; koşucu yalıtım denetimi her koşuda "değişmedi" dedi.
- Altın set: `golden-pilot.jsonl` — 70 soru (63 cevaplı, 7 cevapsız). Sorular çoğunlukla Türkçe,
  notlar çoğunlukla İngilizce (çapraz dil).
- Sızıntı bataryası: 32 çok dilli selamlaşma/slang/hakaret/teşekkür mesajı (yalnız ölçüm için,
  ürün koduna girmez).
- Koşucu: `bench/run-retrieval.ts`, varyantlar `bench/lib/pipelines.ts` (`kw-*`). Terim eşleşmesi
  indeksin kendi tokenizer'ı (`porter unicode61 remove_diacritics 2`) için FTS'e sorulur.

## Sonuçlar

| Kapı | Parça R@5 | Dosya R@5 | Cevaplıda yanlış-boş | Cevapsızda boş (iyi) | Sızıntı |
|---|---|---|---|---|---|
| Bugünkü yol (VE, tüm terimler) | 0,000 | 0,000 | %100 | %100 | 0/32 |
| Yalın VEYA + BM25 | 0,459 | 0,733 | %4,8 | %28,6 | 21/32 |
| VEYA + 5 karakter önek | 0,427 | 0,733 | %0 | %28,6 | — |
| VEYA + %70 önek | 0,433 | 0,712 | %1,6 | %28,6 | — |
| VEYA + kapsama ≥%30 | 0,217 | 0,357 | %55,6 | %71,4 | — |
| **VEYA + ≥2 farklı terim aynı parçada** | **0,398** | **0,646** | **%22,2** | **%57,1** | **5/32** |
| ≥2 nadir terim (parçaların <%5'inde) | 0,298 | 0,466 | %36,5 | %57,1 | 4/32 |
| ≥2 nadir terim (<%2) | 0,220 | 0,336 | %52,4 | %100 | 0/32 |

Karşılaştırma için 2026-09-27 pilotunda vektör araması (bge-m3, eşiksiz) parça R@5 0,753.

## Bulgular
1. **Bugünkü VE yolu gerçek sorularda hiç çalışmıyor:** sorular 12 terime kadar çıkıyor; 70 sorunun
   hiçbirinde tüm terimler aynı parçada geçmiyor (VEYA 65'inde eşleşiyor).
2. **Önek kırpma yardımcı olmuyor:** bu kasada boşluk Türkçe ekler değil, dil farkı. Yalnız Türkçe
   bir kasada sonuç farklı olabilir — bu kasa onu ölçemez.
3. **Oran tabanlı kapsama eşiği** isabeti yarıya indiriyor.
4. **"≥2 farklı terim birlikte" kırılma noktası:** F5'in "tek rastlantısal sözcük kanıt değildir"
   ilkesini koruyor, isabetin çoğunu tutuyor. Kalan 5 sızıntı yaygın İngilizce kalıplar
   ("thank you so much", "how are you doing today", "you are so stupid", "hey there buddy",
   "ciao bella come stai").
5. **Nadirlik (belge sıklığı) filtresi** sızıntıyı sıfırlıyor ama cevaplı soruların yarısını boşaltıyor;
   %2 eşiği bu bataryaya göre ayarlı.

## Karar (kullanıcı, 2026-10-01)
Yalnız-FTS modunda **VEYA + ≥2 farklı terim** kapısı. Embedding'in geçici çöküşünde çalışan yedek
yol bugünkü VE kuralında kalır.

## Sınırlar
- Cevapsız soru yalnız 7 → çekimserlik oranları çok geniş güven aralıklı.
- Tek kasa, çapraz dil; Türkçe-Türkçe kasada ayrıca ölçülmeli.
- Embedding'siz modda small-talk kapısı çalışmıyor (embedding gerektiriyor); 5/32 sızıntı bu yüzden
  doğrudan kullanıcıya yansır.
