# Formül kırpımı / döngü deneyi

`crop_experiment.py`: CodeFormulaV2'yi aynı formüller üzerinde kontrollü koşullarla çalıştırır;
görüntüden gelen bozulmayı çözme döngüsünden ayırır. Tek modül, ek bağımlılık yok (docling,
transformers, torch, pypdfium2 zaten kurulu).

Çözme yolu üretimle aynıdır: docling 2.130 `StandardPdfPipeline` formülleri `CodeFormulaVlmModel`
+ `create_vlm_engine` (Transformers, preset `codeformulav2`, bfloat16, sol dolgu, açgözlü,
`max_new_tokens=2048`, 5'erli gruplar) ile çözer; script aynı motoru doğrudan kullanır.
Erken kesme KAPALI. Gözlemci yalnız kaydeder (`--cap-after-hit N`, N>0 ise döngü tespitinden
N token sonra yalnız o satırı keser; süre içindir, `stop_reason=capped_after_loop`).

## Tam GPU deneyi

```
python -I -X utf8 bench/formula/crop_experiment.py run ^
  --dataset <veri.json> --pdf-root "C:/Users/Alp/Desktop/Notebook verileri/Fizik/kaynaklar" ^
  --out <cikti_klasoru> --device cuda
python -I -X utf8 bench/formula/crop_experiment.py summary --out <cikti_klasoru>
python -I -X utf8 bench/formula/crop_experiment.py review  --out <cikti_klasoru>
```

Kesilirse aynı komut kaldığı yerden sürer (tamamlanmış sayfa/koşul atlanır). `--pages altdizge[:sayfa]`,
`--limit-pages N`, `--conditions a,b`, `--locate-only` (modelsiz yerleşim önbelleği) yardımcıdır.
`veri.json` içinde `page=null` olan 2 satır atlanır (`matches.json` -> `_unlocated`).

## Çıktı klasörü

- `located/<anahtar>.json`: sayfa başına docling yerleşimi (öğe sırası, bbox PDF noktası sol-alt orijin),
  pdfium karakter kutuları; `located/docling_crops/`: docling'in kendi stok kırpımları (karşılaştırma için).
- `crops/<anahtar>/i<öğe>_<koşul>.png`: çözücüye giden görüntü.
- `results.jsonl`: (öğe, koşul) başına bir satır: kırpım yolu/boyutu, kutu, genişletme, grup boyutu ve
  komşuları, denklem numarası (bulundu/beyazlandı), çözme parametreleri, ham ve temiz çıktı, token
  kimlikleri, token sayısı, durma nedeni (`eos|max_tokens|capped_after_loop`), dedektör isabeti
  (periyot, token konumu), postprocess kuralı (ofset, periyot), süre.
- `matches.json`: hedef eşlemesi (skor, ikinci aday, düşük güven nedenleri).
- `summary.json`, `review.html`.

## Koşullar

| ad | genişletme | grup | denklem no |
|---|---|---|---|
| stock | 0.18 | 5 | bırak |
| exp005 | 0.05 | 5 | bırak |
| adaptive | adaptif (<=3.5 pt) | 5 | bırak |
| batch1 | 0.18 | 1 | bırak |
| noeq | 0.18 | 5 | beyazla |
| adaptive_noeq | adaptif | 5 | beyazla |
| adaptive_noeq_b1 | adaptif | 1 | beyazla |
| exp005_noeq_b1 | 0.05 | 1 | beyazla (varsayılanda yok) |
| stock_fp32 | 0.18 | 5 | bırak |
| adaptive_noeq_b1_fp32 | adaptif | 1 | beyazla |

- dtype değişkeni: her koşulun `dtype` alanı vardır; boşsa `--dtype` (varsayılan `auto` = üretimdeki
  bfloat16), `float32` ise o koşul için ayrı bir fp32 motoru tembel yüklenip önbelleğe alınır (iki motor
  birlikte bellekte durur). Üretim bf16 olduğundan döngü oranını ölçen karşılaştırma `stock` (bf16) ile
  `stock_fp32` ve `adaptive_noeq_b1` ile `adaptive_noeq_b1_fp32` çiftleridir. GPU'da çalıştırma örneği:
  `... run --device cuda --conditions stock,stock_fp32,adaptive_noeq_b1,adaptive_noeq_b1_fp32`.
  CPU'da `--dtype float32` zaten tek motordur; `_fp32` koşulları CPU'da stok ile aynıdır. Sonuç
  satırlarının `decoding.dtype` alanı gerçek dtype'ı kaydeder.

- Adaptif: formül bbox'ı + her yönde en çok `--adaptive-margin` (3.5 pt); üst/alt satırdaki ve yandaki
  komşu karaktere değmeden durur (0.5 pt pay). bbox'ın kendisi asla kesilmez, sayfa dışına çıkmaz.
- Denklem numarası: stok kırpım içinde, formül satırında, büyük boşlukla (1.5 x ortanca karakter
  yüksekliği) ayrılmış ve `^\(?\s*\d+(\.\d+)*[a-z]?\s*\)?$` ile eşleşen en sağdaki karakter grubu.
  Beyazlama yalnız o karakterlerin kutusunu boyar, kırpım boyutu değişmez. docling'in formül bbox'ı
  çoğu kez numarayı da kapsar (`inside_formula_bbox=true`); adaptif koşul bunu tek başına kaldırmaz.

## Hedef eşleme

Not'taki `head` ile sayfadaki her formülün STOK çıktısının ilk `len(head)+2` LaTeX belirteci
arasındaki difflib oranı; eşitlikte stok koşuşunda döngüye giren öğe +0.1 alır, aynı öğe iki hedefe
verilmez. Düşük güven: skor < 0.75, head < 4 belirteç, ikinci aday 0.05 içinde veya stok koşuşunda
döngü yeniden üretilmedi. Diğer formüller kontrol, kod blokları dolgu (gruplara girer, ölçülmez).

## Değerlendirme

`review` -> `review.html` (KaTeX 0.16.11, cdnjs): hedef başına stok kırpım + koşul çıktıları (aynı
çıktı veren koşullar tek karta birleşir), kart başına tam / eksik / hatalı / döngü. "Yargıları indir"
-> `judgments.json`; `summary --judgments judgments.json` koşul başına yargı sayımı ekler.

## Sınırlar

- Grup komşulukları sayfa içidir (docling tüm belgede 5'erli böler; sayfa başı/sonu kayar).
- Kırpım, pypdfium2 sayfa görüntüsünden docling ile aynı ifadeyle kesilir; docling'in kendi
  kırpımından 1 px boyut ve ~5/255 ortalama gri fark olabilir (`located/docling_crops/` ile kıyaslanabilir).
- Hata ayıklama `--only-items` grup bileşimini değiştirir; hakem koşuşta kullanmayın.
