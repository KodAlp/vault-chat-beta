# Araştırma 2026-10-13: ∝ yanlış okuması ve taranmış kod sayfaları

İki araştırma, TODO #4 ve #8'in devamı için. Ölçüm betikleri o oturumun geçici klasöründeydi (`scratchpad/arastirma-propto/`, `scratchpad/arastirma-kod/`); kalıcı olan bu belgedir.

## 1. ∝ (`\propto`) yanlış okuması — #4

### Neden kaldı
- 2026-10-10 gecesi Fizik notları `VC_FORMULA_FALLBACK=auto` ile dönüştürüldü (onarım günlüğü `onarim.jsonl`, tüm notlarda `mode: auto`). `all` koşusu Likharev QM'de başlayıp bitmedi.
- `auto` yalnız KaTeX/yapı denetimine takılan formülleri MinerU'ya gönderir (kozmolojide %13). CodeFormula'nın ∝ yerine yazdığı `\, \infty \,` geçerli LaTeX olduğu için hiç işaretlenmedi.
- `formula_fallback.apply()` kabul kuralı: kırpım var (`_CROPS`, 256 MB sınırı), CUDA var, 16'lık toplu çağrı başarılı, `normalize_mineru` boş değil, `check_latex` temiz, `_has_loop` yok, `find_fatal` (note_blocks + KaTeX) kabul. Benzerlik/uzunluk kapısı yok. `STATS["kept"]` reddedilenleri ayırmıyor.
- Tam `all` koşusu: ~13,9 bin formül × ~0,95 sn ≈ 3 GPU saati; doğru formülleri bozma riski. Önerilmez.

### Kural (seçenek a) — ölçüm
- Aday: alt/üst simge grubunda olmayan, önceki anlamlı simgesi terim sonu (harf, rakam, `}`, `)`, `]`, `\right|`, Yunan/harf benzeri komut, `\}`) ve sonraki simgesi terim başı olan `\infty`. Komşu ararken `\,` `\ ` `\;` `\quad` atlanır.
- 18 Fizik notunda 71 aday, **70'i PDF'te gerçekten ∝** (sayfa düzeyinde metin katmanıyla doğrulandı). Tek yanlış pozitif: `\infty \text {-category}` (motivik not, satır 884) → istisna.
- Dokunulmayan diğer `\infty`: 1.792 (limitler, `\to`, `=`, `\pm`, `-\infty`).
- Not başına: kozmoloji 25, optik 12, Likharev QM 11, EM 7, SM 7, Essler 5, Carroll 3.
- Ayrıca iki yanı boşluklu `\, \alpha \,`: 6 simge / 5 formül, hepsi ∝ (tek yanlı `\alpha` gerçek α, dokunma).
- Otomatikleştirilmeyecek: 7 `\circ c` (Likharev; `f \circ c` bileşkeyle karışır), 1 `\underset{X}{\, \infty}`.
- Likharev PDF'lerinin metin katmanı var: ∝ = U+F0B5, ∞ = U+F0A5 (Symbol yazı tipi özel kodları).

### MinerU ile yeniden okuma (seçenek b)
- Notlarda formül konumu yok (kırpım anahtarı yalnız dönüşüm sırasında bellekte).
- pypdfium2 `get_charbox` ile ∝ glifinin konumundan kırpım: 14 gerçek kırpımda MinerU **14/14 `\propto`**, hepsi `check_latex` temiz. Kaba tam satır kırpımı bir yerde şekil yazısını da aldı.

### Önerilen uygulama (onaylandı)
1. `ingest/postprocess.py` → `fix_latex_artifacts` içine kural + `postprocess_test.py`'de 70 gerçek bağlam ve olumsuz örnekler (`\sum_{n=1}^{\infty}`, `\int_0^\infty`, `= \infty`, `\to \infty`, `-\infty`, `(a, \infty)`, `\infty \text{-category}`).
2. İsteğe bağlı: `formula_fallback.flag_reason`'a `propto_suspect` (~70 formül MinerU'ya, kural yedek).
3. Mevcut notlar: `writeLibraryFile` yolundan bir kerelik onarım (revizyon, edit-log, yeniden indeksleme), önce yedek ve `--dry` farkı kullanıcıya.
4. **Likharev Symbol özel kodları** (aynı işte): düz metinde U+F0B5 (∝) EM 35 / QM 33 / SM 31, U+F0A5 (∞) 153; not başına ~5000 özel kod karakteri. Symbol yazı tipi → Unicode eşleme tablosu (U+F0B5→∝, U+F0A5→∞, U+F066→φ, …) içe aktarmada ve onarımda.

## 2. Taranmış kod sayfaları (Türkçe + kod) — #8 devamı

### Durum
- #8 (ebe763e) Türkçe taramada CodeFormula'yı kapattı: Türkçe karakter doğru ama kod tek satır, girinti kayıp.
- **Kullanıcı (2026-10-13): "hem Türkçe hem kod içeren kaynaklar çöp olur, bu doğru değil."** Şimdiki hal kabul edilmedi; uygulamadan önce kullanıcıyla netleştir.

### Bulgular
- CodeFormula taranmış sayfada yalnız Türkçe karakteri değil ASCII metni de bozuyor (`memeletk`, `falcona`, set1 s.1'de ~30.000 karakter `ppppp…` döngüsü) ve el yazısı notları kod satırlarına yapıştırıyor. Sayfa başına 11–24 sn (OCR ~3,5 sn).
- docling `PdfPipelineOptions(generate_parsed_pages=True)` ile `res.pages[i].cells` korunur: metin, güven, `from_ocr`, TOPLEFT kutu.
- fonk1'de mavi el yazısı notlar gerçek PDF metin katmanı (`from_ocr=False`), kod satırları OCR hücresi → ayrılabilir.
- **RapidOCR açı sınıflandırıcısı** (`use_cls` varsayılan) uzun kod satırlarını ters çeviriyor; `RapidOcrOptions(lang=[..], use_cls=False)` düzeltti.
- PP-OCRv6 `tr` `ı`'yı `i` okuyor (ö ü ç ş ğ doğru) — her seçenekte geçerli sınır.

### Ölçüm (karakter doğruluğu / doğru girintili satır)
| Sayfa | CodeFormula | Şimdiki (kapalı) | A birleştir | C harf onar | **B OCR kutularından** | B3 (+satır yeniden okuma) |
|---|---|---|---|---|---|---|
| fonk1 s.1 (51) | 0,74 / 26 | 0,75 / 0 | 0,82 / 28 | 0,74 / 26 | 0,93 / 49 | **0,95 / 49** |
| fonk1 s.2 (52) | 0,83 / 41 | 0,90 / 0 | 0,87 / 42 | 0,81 / 41 | 0,95 / 47 | 0,95 / 47 |
| dic1 s.1 (54) | 0,89 / 51 | 0,96 / 0 | 0,94 / 51 | 0,89 / 51 | 0,96 / 52 | 0,97 / 51 |

A ve C elendi; D (başka model) indirmesiz yok, denenmedi.

### Önerilen uygulama (B)
1. Yeni `ingest/code_layout.py` (docling'siz, test edilebilir): `estimate_pitch`, `split_overlay` (OCR olmayan hücreler + geometrik yedek: satır yüksekliği > 1,6× medyan ya da karakter genişliği ±%25), `build_rows` (y kümeleme 0,6× medyan yükseklik, x0 = sol kenarların 5. yüzdeliği, sütun = round((l − x0)/pitch), boş satır = y aralığı / satır yüksekliği, en çok 3), `render`, isteğe bağlı `rerecognize_rows` (B3: satır kutusunu ölçek 3'te `use_det=False` ile yeniden oku), `rebuild_code_items` (CodeItem kutusu BOTTOMLEFT → TOPLEFT dönüşümü; overlay metni blok sonrasına paragraf).
2. `convert_with_docling`: `generate_parsed_pages = True`; her iki `RapidOcrOptions` dalına `use_cls=False`; OCR'lı segmentlerde kod çıkarımı her dilde kapalı (`_set_code_extraction(conv, not ocr)`); her OCR segmenti sonrası `rebuild_code_items` (try/except, hata olursa bugünkü davranış).
3. Testler: sentetik eşit genişlikli hücreler (girinti, tek boşluk girinti, boş satır, satırda çok hücre), overlay ayrımı, hücresiz durum, kutu dönüşümü, ~25 hücrelik altın fikstür; isteğe bağlı yavaş test (fonk1: `print(i, end=" ")` 4 boşluk girintili, `döndürülen` kod dışı paragrafta).
4. Sınırlar: eşit genişlikli yazı tipi varsayımı; overlay ayrımı metin katmanı yoksa sezgisel; `use_cls=False` yan/ters taramada döndürme düzeltmesini kaldırır (yalnız kodlu OCR sayfalarında kapatmak seçenek); `code_language` etiketi kaybolur.
