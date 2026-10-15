# Büyük PDF'lerde bellek ölçümü (#83) — 2026-10-15

## Düzen

- Kaynak: *Artificial Intelligence: A Modern Approach* (1151 sayfa, formül ve görsel karışık).
- Kod: main `48b461a`, `ingest/convert.py --tool docling --pages 1-N` (uygulamanın kullandığı hat: formül/kod zenginleştirme, görsel kırpımları 2×, `generate_parsed_pages`).
- Donanım: 31,7 GB RAM, RTX 4050 6 GB.
- Ölçüm: süreç ağacının RSS'i ve `nvidia-smi` bellek, 5 sn'de bir (scratchpad `bellek/olc.py`).

## Sonuç

| Sayfa | Tepe RAM | Tepe GPU | Süre |
|---|---|---|---|
| 150 | 5,5 GB | 3,6 GB | 3,3 dk |
| 300 | 8,7 GB | 4,3 GB | 8,4 dk |
| 600 | 14,6 GB | 4,3 GB | 20,7 dk |

RAM doğrusal: yaklaşık **2,4 GB + 20 MB/sayfa**. GPU sayfa sayısından bağımsız (~4,3 GB tavan).

Kestirim: 1151 sayfa ≈ 25 GB, 1373 sayfa ≈ 30 GB, 1757 sayfa ≈ 38 GB, 5057 sayfa (Intel SDM) ≈ 100 GB. 32 GB'lık makinede ~1300 sayfanın üstü belleği tüketir; 16 GB'lık makinede sınır ~650 sayfa.

## Neden

docling 2.130 `StandardPdfPipeline`, belge bitene kadar her sayfa için şunları tutuyor:

1. Sayfa görüntüsü — `keep_images`, `generate_picture_images=True` ile açılıyor (`images_scale=2.0`).
2. PDF sayfa arka ucu — `keep_backend`, `do_formula_enrichment` / `do_code_enrichment` ile açılıyor.
3. Ayrıştırılmış sayfa hücreleri — `generate_parsed_pages=True` (`code_layout` için).

Üçü de zenginleştirme ve görsel toplama için gerekli; kapatmak çıktıyı bozar.

## Önerilen düzeltme

Uzun PDF'i sayfa aralıklarına bölüp (ör. 150 sayfa) her parçayı ayrı `conv.convert(page_range=...)` ile çevirmek ve Markdown'u birleştirmek. `convert.py` sayfa aralığını zaten destekliyor. Dikkat edilecekler: parça sınırında kesilen tablo/formül/kod bloğu, başlık seviyelerinin sürekliliği, görsel sayaçları ve `total_pages`, parçalar arasında `gc` + CUDA önbelleğini boşaltma, ilerleme bildirimi.
