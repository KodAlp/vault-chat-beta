# Hızlı PDF profili ve sayfa bazlı OCR ölçümü (2026-10-08)

RTX 4050 6 GB, docling 2.130.0 / docling-core 2.98.0, OCR motoru RapidOCR (OcrAutoOptions).
Örneklem: Notebook verileri'nden 12 PDF (Fizik, Matematik, Mat. Müh., Elektrik, Bilgisayar,
Almanca dijital/karma/taranmış, Rusça), her birinden en çok 12 sayfa, model yüklüyken.

## 1. Notebook taraması (702 PDF, 63.667 sayfa, 234 sn, salt okunur)

| Tür | PDF | Sayfa |
|---|---|---|
| Doğal dijital | 587 | 48.518 |
| Karma (bazı sayfalar taranmış) | 64 | 13.747 |
| Çoğu taranmış (OCR şart) | 35 | 1.004 |
| Taranmış + gömülü OCR katmanı | 16 | 398 |

OCR gereken sayfa toplamı 1.205 (1.141'i Almanca). PDF metadata'sı (Producer/Creator) OCR ihtiyacını
göstermiyor: OCR gereken 99 PDF'ten yalnız 14'ünde ipucu var. Güvenilir ölçüt sayfa bazlı
`textless_pages` (metin < 20 karakter + görsel nesne), ~3,7 ms/sayfa.

## 2. Hızlı profil (docling ayarları)

| Dosya (12 sayfa) | A tam | B formülsüz | C formül+tablo kapalı |
|---|---|---|---|
| Tong, kuantum (Fizik) | 31 sn (ilk: 77 sn, model yükleme dahil) | 1,1 sn | 1,2 sn |
| Trefethen, sayısal analiz | 98 sn | 2,5 sn | 3,3 sn |
| Formülsüz belgeler (elektronik, veritabanı, Almanca, Rusça) | 1–12 sn | aynı | aynı / daha yavaş |

- B'de formüllerin tamamı `<!-- formula-not-decoded -->` oldu (Tong 46, Trefethen 20 denklem).
  Formülsüz belgelerde kazanç sıfır. Hızlı profil bu yüzden **uygulanmadı**.
- C tablo satırlarını düşürdü (106 → 40), hız kazandırmadı.

## 3. Karma PDF'te belge boyu OCR (asıl kayıp)

12 sayfalık Almanca hikâye kitabı, yalnız kapak taranmış:

| Yol | Süre |
|---|---|
| OCR kapalı | 1,5 sn |
| OCR açık (eski davranış: tek taranmış sayfa → tüm belge) | 57 sn |
| Yalnız kapağı OCR | 9,4 sn |
| Sayfa bazlı (yeni) | 5,3 sn |
| Uçtan uca `convert.py --pages 1-12`, ayrı süreç, model yükleme dahil: eski / yeni | 64 sn / 26 sn |

Çıktı farkı: yeni yolda dijital sayfadaki bir resmin içindeki tek satır yazı yok (eskiden karma
PDF'lerde tesadüfen OCR'lanıyordu; tamamen dijital PDF'lerde hiç yapılmıyordu). Tahmini kazanç
Notebook'ta ~18 saat (13.747 karma sayfa × ~4,7 sn).

## 4. Açık kalanlar

- Toplu içe aktarmada her dosyada model yükleme (formül modeli dahil); sonraki iş.
- OCR dili: Almanca–Bengalce listede Bengalce satırlar çöp karakter. Ayrı iş.
- Formül çözme maliyeti (2,5–8 sn/sayfa) kalite için gerekli; azaltılmadı.
