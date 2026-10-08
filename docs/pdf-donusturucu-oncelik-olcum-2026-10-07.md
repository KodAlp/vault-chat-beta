# PDF dönüştürücü önceliği — ölçüm (2026-10-07)

Dal: `pdf-docling-oncelik`. Tetikleyici: Denememcp kasasında MCP `import_source`
denemesi. 2 sayfalık `exam4sol.pdf`'in 2. sayfası taranmış görüntüydü (0 karakter
metin). `auto` yolu MarkItDown'da kaldı; not yalnızca kapak sayfasıyla, **uyarısız**
"ready" oldu. Formüllü 3 sayfalık `unit2_review.pdf` ise MarkItDown'da anlamsız
boru tablolarına döndü.

## Ölçüm (RTX 4050 6 GB, aynı süreçte, kod değişikliği öncesi)

| Dosya | Tür | markitdown | docling |
|---|---|---|---|
| slides.04 | PPTX | 1,4 sn · 44 başlık | 10,2 sn · 44 başlık · metin eşdeğer |
| Gradyan İniş dersi | PPTX | 0,1 sn · 24 062 kr. | 3,5 sn · 6 562 kr. (fark: Office alt-metinleri) |
| Web Servisleri | PPTX | 0,4 sn · 175 başlık | 6,1 sn · 187 başlık |
| Doğrusal Optimizasyon | DOCX | 0,7 sn · tablo hücrelerinin %21'i boş (metin kutuları) | 1,4 sn · gerçek paragraf/liste |
| makine_ogrenmesi_ozet | DOCX | 0,6 sn | 1,3 sn · eşdeğer |
| unit2_review (3 s.) | PDF | 0,2 sn · 0 başlık · %63 boş tablo · 47 bozuk glif | 23,6 sn* · 5 başlık · 8 formül bloğu |
| exam4sol (2 s., s.2 el yazısı tarama) | PDF | 0,1 sn · yalnız kapak | 21,0 sn · OCR, formüller güvenilmez |
| exam3review (4 s.) | PDF | 0,2 sn · 0 başlık · 7 bozuk glif | 6,9 sn · 5 başlık · 5 formül |
| lec14 (5 s.) | PDF | 0,2 sn · 21 bozuk glif | 12,1 sn · 11 başlık · 13 formül |
| raft (18 s.) | PDF | 2,9 sn · 666 satır %62 boş tablo | 7,6 sn · 53 başlık · kaynakçaya kadar tam |

\* model yükleme dahil. Ayrı süreçte (uygulamanın gerçek yolu) kısa bir PDF
~40–57 sn sürüyor; bunun çoğu model yükleme.

PPTX'te konuşmacı notu içeren örnek yoktu; notlar karşılaştırılmadı.

## Karar (kullanıcı onayı, 2026-10-07)

| Tür | 1. | 2. |
|---|---|---|
| PDF, GPU (CUDA/MPS) var | docling | MarkItDown → marker (uyarıyla) |
| PDF, yalnız CPU | MarkItDown | bozuksa ya da görüntü-yalnız sayfa varsa marker → docling |
| PPTX / XLSX / DOCX | MarkItDown | — |

`VC_PDF_PRIMARY=docling|markitdown` seçimi elle zorlar.

## Uygulananlar (`ingest/convert.py`)

- `pdf_primary_tool()` / `accelerator_available()`: docling-önce yalnız GPU'da.
- `textless_pages()`: metni 20 karakterden az **ve** görsel nesnesi olan sayfalar
  (gerçekten boş ayraç sayfaları sayılmaz). pypdfium2 ile 769 sayfa 1,9 sn.
- docling OCR'ı artık görüntü-yalnız sayfa varsa da açıyor (önceden yalnız tüm
  belge metinsizse). Uyarılar: "N sayfa OCR ile okundu" / "N sayfada metin
  katmanı yok … içeriği notta eksik" / "docling çalışmadı (…); X ile dönüştürüldü".
- Hugging Face çevrimdışı-önce (`hf_offline_first`): docling her model yüklemesinde
  `snapshot_download` ile sürüm sorguluyordu. Yerel sahte uç noktayla ölçüldü:
  dönüşüm başına **3 istek → 0**. Model önbellekte yoksa bir kez çevrimiçi
  yeniden dener. Bedel: docling model güncellemeleri kendiliğinden gelmez.

## Bilinen sınırlar

- El yazısı taramada docling OCR'ı da anlamsız LaTeX üretebiliyor; uyarı bunu
  söylüyor, düzeltmiyor.
- "Çoğu metinli + birkaç taranmış sayfa" PDF'i uçtan uca denenmedi (yalnız birim testi).
- GPU'lu makinede kısa PDF artık ~0,2 sn yerine ~40 sn sürüyor (süreç başına model yükleme).
