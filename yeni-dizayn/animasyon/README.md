# ThinkingChick — bekleme animasyonu

Sohbette yanıt beklenirken üç noktanın (`ChatBubble.svelte` → `.thinking-dots`) yerine geçen "defter okuyan kuş".

| Dosya | Ne |
|---|---|
| `thinking-chick.js` | Çerçeveden bağımsız çekirdek: SVG çizimi, zaman çizelgesi, faz makinesi (`createChick`) |
| `ThinkingChick.svelte` | Svelte 5 (runes) sarmalayıcı — `phase`, `config`, `label`, `onexited` |
| `ChatBubble.onerilen.svelte` | `src/lib/components/ChatBubble.svelte`'in kuşlu önerilen hâli |
| `Message.svelte.patch` | Kuşun düşünme süresince de okuması için `Message.svelte`'deki tek satırlık değişiklik |
| `../prototipler/bekleme-animasyonu.html` | Sohbet içinde canlı demo (tema, boyut, hız, elle/otomatik yanıt) |

## Fazlar

| `phase` | Ne olur | Süre |
|---|---|---|
| `idle` | Kilit kanatta, defter kapalı | — |
| `thinking` | (Gönderimden asıl yanıtın ilk kelimesine kadar — düşünme aşaması dahil) Kilit yere iner → defter kuşa doğru açılır → beklerken sayfalar çevrilir; kısa aralar, göz kırpma | giriş ≈ 1 sn, sonra döngü |
| `done` | Defter kapanır, kanat kilidi alır (`exitMs`, 500 ms) → `onexited` | ≈ 0,5 sn |

Yanıt HTML'i **`onexited`'dan sonra** gösterilir. Akış bu ~0,5 sn boyunca da sürdüğü için yanıt ilk göründüğünde birkaç satır gelmiş olur. Daha erken göstermek istenirse `exitMs` kısaltılır.

## Uygulamaya bağlarken

1. `thinking-chick.js` ve `ThinkingChick.svelte` → `src/lib/components/`.
2. `ChatBubble.svelte`'i `ChatBubble.onerilen.svelte` ile değiştir (eski `.thinking-dots` stilleri kalkar).
3. `Message.svelte`'e `Message.svelte.patch`'i uygula: `isWaitingForFirstToken` koşulundan `!message.thinking` kalkar.
   **Karar:** kuş, modelin düşünme (reasoning) aşaması boyunca da okumaya devam eder; defteri yalnızca asıl yanıt metni akmaya başlayınca kapatır. ThinkingPanel bu sırada üstte düşünmeyi akıtabilir.

## Notlar

- Boyut kapsayıcının genişliğine uyar; sohbet balonunda 112px öneriliyor (`.chick-slot`). Kep ve defter viewBox dışına taştığı için kapsayıcıda `overflow: visible` olmalı.
- Kuşun renkleri kendi paletinde (sarı gövde, mor kep/defter); 5 temada da aynı kalır — maskot olduğu için tema token'larına bağlanmadı.
- Azaltılmış hareket (`<html data-motion="reduce">`; uygulamadaki Animasyonlar ayarı, "Sistem" ise `prefers-reduced-motion`): göz gezdirme, sayfa çevirme, nefes ve püskül animasyonu durur; fazlar arasında doğrudan geçer.
- Erişilebilirlik: kapsayıcı `role="status"` + `aria-label` ("Yanıt bekleniyor…"), ekran okuyucu animasyonu değil durumu duyar.
- Okuma pozu: `readX 414, readY 232, readTilt 17, holdAngle 130, spread 123` (defter kuşa doğru açık, beklerken sayfalar çevrilir).
- Ayarlar (`config`): kitap boyutu/açıları, kilit düşüşü, sayfa çevirme süresi (`flip`), aralar, `exitMs`. Varsayılanlar `VAULT_CHICK_DEFAULTS`.
