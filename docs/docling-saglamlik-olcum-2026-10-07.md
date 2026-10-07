# docling sağlamlık ölçümü (2026-10-06 / 07)

Ortam: Windows 11, RTX 4050 6 GB, docling 2.130.0, docling-parse 7.21.0, pypdfium2 5.10.1, pypdf 6.14.2.
İlgili commitler (dal `claude/docling-pdf-koruma`): `9c45d73` sütun sırası, `0897534` PDF_DAMAGED, `34b348d` çökmede yeniden deneme, `75058f8` karma yedek arka uç, `e8a4810` sürüm sabitleme.

## Bizi etkileyen upstream hataları

| Kayıt | Ne | Durum | Bizdeki karşılığı |
|---|---|---|---|
| [docling-parse #357](https://github.com/docling-project/docling-parse/issues/357) | Windows'ta render iş parçacığı kapanırken yığın bozulması; süreç 0xC0000374 / 0xC0000005 ile ölür. CMYK JPEG'li PDF'lerde sık. | Açık | Çökmede bir kez yeniden deneme, ikinci deneme karma arka uçla (`34b348d`, `75058f8`) |
| [docling-parse #354](https://github.com/docling-project/docling-parse/issues/354) | Kullanıcı yolunda ASCII dışı karakter (ör. "Çağrı") → renderer açılmıyor, **hiçbir PDF dönüşmüyor** | Açık | Açılış hatasında süreç içinde karma arka uçla yeniden deneme (`75058f8`) |
| [docling-parse #374](https://github.com/docling-project/docling-parse/issues/374) | Kesik PDF eksik sayfalarla `SUCCESS` dönüyor | Açık | pypdf açılış kontrolü + sayfa sayısı karşılaştırması, `PDF_DAMAGED` (`0897534`) |
| [docling-parse #377](https://github.com/docling-project/docling-parse/issues/377) | 7.22.1'de kelimeler iç boşlukta bölünüyor | Açık | `docling-parse==7.21.0` sabit (`e8a4810`) |
| [docling #4357](https://github.com/docling-project/docling/issues/4357) | Taranmış PDF'in gömülü OCR metni kayboluyor | Açık | **Bizde çıkmadı** (aşağıda); kod değişikliği yok |
| [docling #4504](https://github.com/docling-project/docling/issues/4504) | docling-parse sayfa görüntüsü pdfium'dan farklı, modeller etkileniyor | Açık | Bizim ölçümde ters yönde: pdfium görüntüsü bazı belgelerde daha kötü (aşağıda) |

## 1. Kesik / bozuk PDF

- 8 sayfalık iki dosya baytlarının %60, %80 ve %95'inde kesildi. docling'in varsayılan ve seri arka ucu `SUCCESS` ile, hata listesi boş, 2–7 sayfa döndürdü. pypdfium arka ucu `FAILURE` verdi.
- **pypdf açılış kontrolü:** Diskteki 1784 PDF'te pypdf ve pypdfium2 birebir aynı sonucu verdi. 1753 sağlam dosyanın hepsi açıldı ve sayfa sayıları tuttu, yanlış pozitif 0. Açılamayan 31 dosyanın 29'u `__MACOSX/._` artığıydı. 6 kesik dosyanın hepsi reddedildi.
- **docling sonrası sayfa kontrolü:** 20 rastgele gerçek PDF (2–12 sayfa) `convert.py --tool docling` ile dönüştürüldü. Hepsi `done`, sayfa kontrolü hiçbirinde yanlış alarm vermedi.

## 2. Windows yerel çökmesi (#357)

`aspekte-neu-b1plus-glossar_englisch.pdf` (CMYK JPEG), sayfa 1–3, `enqueueConversion` ve gerçek `convert.py` ile:

| Sürüm | Koşu | Çökme | Kullanıcıya hata |
|---|---|---|---|
| Yeniden deneme yok | — | ölçülen oran %50–100 | her çökmede `CONVERSION_FAILED: exit 3221226356` |
| `34b348d` (yeniden deneme, aynı arka uç) | 11 | 5 | 2 (`CONVERTER_CRASHED`) |
| `75058f8` (yeniden deneme karma arka uçla) | 8 | 2 | **0** |

## 3. Türkçe kullanıcı yolu (#354)

`LOCALAPPDATA` ASCII dışı adlı bir klasöre (`Çağrı_LocalAppData`) yönlendirilince yeniden üretiliyor. Eski yolda `RuntimeError: filesystem error: Cannot convert character sequence` hatası çıkıyor, docling bunu `ConversionError: ... while opening the document` olarak bildiriyor. Yeni yolda dönüşüm `done` bitiyor ve "Yedek PDF okuyucusuyla dönüştürüldü" uyarısı çıkıyor.

## 4. Karma arka uç neden yalnız yedek

Uygulama ayarlarıyla (formül + kod tanıma açık, OCR yalnız metin katmanı yoksa) ölçüldü. Metin oranı, PDF'in kendi metin katmanındaki kelimelerin çıktıda bulunma oranı.

| Dosya | Metin oranı (varsayılan → karma) | Süre (sn) |
|---|---|---|
| Cahit Arf, 19 s. (Acrobat OCR'lı) | 0,948 → 0,937 | 55 → 106 |
| Fanny, 24 s. (Internet Archive, resimli) | 0,965 → **0,825** | 16 → 24 |
| MIT 18.01, 8 s. (matematik) | 0,917 → 0,916 | 163 → **356** |
| Trentelman, taranmış + OCR katmanı | 0,920 → 0,920 | 52 → 40 |
| DDIA, taranmış + OCR katmanı | 0,984 → 0,984 | 13 → 15 |
| Trentelman dijital | 0,913 → 0,913 | 43 → 49 |
| DDIA dijital | 0,946 → 0,946 | 14 → 11 |

- **Fanny:** karma arka uç 14 bölgeyi "resim" sayıyor (varsayılan 2), içlerindeki metin atlanıyor.
- **MIT:** formül tanıma daha uzun döngülere giriyor; formül metni 8 bin karakterden 18 bine çıkıyor.
- **Önceki 32 PDF'lik karşılaştırma (ilk 3 sayfa, zenginleştirme kapalı):** 28 dosya aynı, karma arka uçta 0 arka plan bellek hatası (varsayılanda koşuların %28'inde). Sert gerilemeler iki içindekiler sayfasıydı; varsayılanın çıktısı da orada bozuktu.
- **Kök neden sayfa görüntüsü:** docling'in kendi `PyPdfiumDocumentBackend`'i karma arka uçla birebir aynı sonucu veriyor.
- **Bilinen risk:** Varsayılan yoldaki arka plan bellek hatası (#357, çökmeden biten koşular) duruyor. Gözlenen etki, aynı dosyada çıktı uzunluğunun 6435 / 6439 karakter arasında oynamasıydı.

## 5. Taranmış PDF'te OCR katmanı kaybı (#4357): bizde çıkmadı

Gömülü OCR katmanındaki kelimelerin çıktıya girme oranı (varsayılan / seri / pypdfium): Cahit Arf %94,8 / %94,8 / %89,5; Fanny %96,5 / %96,5 / %89,1; MIT %91,7 / %91,7 / %91,3. Varsayılan ve seri arka uç her dosyada aynı sonucu verdi. Upstream'deki ABBYY örnekleri denenmedi.

## Yeniden ölçmek (docling yükseltilince)

```bash
python ingest/bench_docling_backends.py <pdf> --groundtruth <kelimeler.json> --key <ad>
```

Aynı dosyalarla (Cahit Arf, Fanny, MIT, Trentelman, DDIA; bu makinedeki kopyalar) iki arka ucu karşılaştırır. Ayrıca kontrol edilecekler:

1. `ingest/hybrid_backend.py` docling'in iç sınıflarına bağlı; `convert.py --tool docling --pdf-backend hybrid` hâlâ çalışıyor mu?
2. #357 / #354 / #377 kapandı mı? Kapandıysa yedek yol ve sabitleme gevşetilebilir.
3. `python ingest/convert_test.py` ve CMYK sözlük PDF'iyle çökme denemesi.
