# Yeni dizayn

Vault Chat'in yeni arayüz dili. Mevcut uygulamaya (`src/`) henüz bağlı değil; burada toplanıyor, eklemeler bittikten sonra uygulamaya taşınacak.

Tasarım sisteminin canlı hâli (önizlemeler, tokenlar, kapak) claude.ai'daki **Vault Chat** Design System artifact'ında. Bu klasör onun koda hazır kopyası.

## İçerik

| Yol | Ne |
|---|---|
| `DESIGN.md` | Tasarım dili: HIG ilkeleri, renk/tip/boşluk kuralları, temalar, bileşen notları (frontmatter'da 5 temanın tüm renkleri) |
| `tokens.json` | **Doğruluk kaynağı.** Renkler (5 tema), tipografi, boşluk, yarıçap, gölge, süre |
| `tokens.css` | `tokens.json`'dan üretilmiş CSS değişkenleri + `@font-face` + `.text-*` tip sınıfları. Tema: `<html data-theme="light\|dark\|cream\|sand\|forest">` |
| `components.css` | Bileşen stilleri (`vc-` önekli sınıflar), yalnızca token değişkenlerini okur |
| `shadcn-kopru.css` | `src/app.css`'teki `@theme inline` bloğunun yeni sürümü + eski token adları için geçici takma adlar |
| `fonts/` | Figtree ve Newsreader değişken fontları (woff2) ve lisansları |
| `icons/` | Material Symbols SVG'leri (`#e3e3e3` mürekkep — CSS maskesi olarak kullan) |
| `bilesenler/` | Her bileşenin bağımsız HTML önizlemesi; `index.html`'den başla. Üstten tema seçilir |
| `animasyon/` | ThinkingChick bekleme animasyonu: çekirdek JS, Svelte 5 bileşeni, önerilen ChatBubble (bkz. `animasyon/README.md`) |
| `prototipler/` | Tam ekran prototipler: vurgu rengi karşılaştırması, Krem/Orman tema önerileri, kaynak ağacı paneli, bekleme animasyonu |

## Temalar

| Tema | `data-theme` | Zemin | Vurgu |
|---|---|---|---|
| Açık | `light` | Parşömen `#fcfbf8` | Safran `#c0803c` |
| Koyu | `dark` | Boşluk `#000000` | Safran `#d49653` |
| Krem | `cream` | Krem `#f6efe0` | Safran `#bd7d38` |
| Kum | `sand` | Kum `#f1e6cf` | Terakota `#b4532a` |
| Orman | `forest` | Köknar `#0f1d1c` | Liken `#b9cf8f` |

## Uygulamaya taşırken (sonra)

1. `fonts/*.woff2` → `static/fonts/`; `tokens.css` içindeki `url('./fonts/…')` yollarını `/fonts/…` yap.
2. `src/app.css`: `@import './styles/tokens.css'` yerine yeni `tokens.css`; `@theme inline` bloğunu `shadcn-kopru.css` ile değiştir; eski Fraunces/Schibsted/Plex `@font-face`'leri kaldır.
3. Ayarlar → Tema'ya Krem, Kum, Orman seçeneklerini ekle (`+layout.svelte` zaten `data-theme` set ediyor).
4. Kaynak ağacını sol panelden alıp `SourceTrigger` + `SourcesSheet` desenine taşı (bkz. `bilesenler/SourcesSheet.html`, `prototipler/kaynak-agaci-prototip.html`).
5. Bekleme göstergesini ThinkingChick ile değiştir (bkz. `animasyon/README.md`).
6. Kök `DESIGN.md`'yi bu klasördeki `DESIGN.md` ile değiştir.

## Ekleme yaparken

- Yeni renk/ölçü → önce `tokens.json`, sonra `tokens.css`'i yeniden üret (ya da artifact'tan güncel kopyayı al).
- Yeni bileşen → `components.css`'e `vc-` önekli sınıflar + `bilesenler/<Ad>.html` önizlemesi + `DESIGN.md`'ye kısa not.
- Her metin rengi 5 temada da en az 4.5:1 (büyük metin ve kontrol kenarları 3:1).
