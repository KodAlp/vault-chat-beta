# Hardcoded metin envanteri (i18n'e bağlanmamış component'ler)

**Tarih:** 2026-09-18
**Amaç:** İleride her component'e statik dil değiştirme butonları eklenebilmesi için, henüz `t()` i18n sistemine (`src/lib/i18n/index.svelte.ts`) bağlanmamış — Svelte dosyasına doğrudan yazılmış ham metin içeren yerlerin listesi.

## Yöntem

1. `src/lib/components/**/*.svelte` (ui/ primitifleri hariç) ve `src/routes/**/*.svelte` altında `$lib/i18n`'den `t` import **etmeyen** dosyalar tarandı.
2. `src/lib/components/ui/**/*.svelte` (shadcn-svelte primitifleri) ayrıca kullanıcıya görünen ham metin literalleri için tarandı.
3. Her aday dosyanın template'i elle okunup gerçekten kullanıcıya görünen (data-bağımlı değil, sabit) metin içerip içermediği doğrulandı.

## Sonuç: Uygulama seviyesinde envanter neredeyse tamamlanmış

`src` altındaki 133 `.svelte` dosyasından 89'u `src/lib/components/ui/` altındaki shadcn-svelte primitifleri (Button, Card, Dialog kabuğu vb. — yapısal, genelde kendi metni yok). Geri kalan 44 "uygulama" component'inden **42'si zaten `t()`'ye bağlı**. Sadece 2 dosya bağlı değildi, ama ikisinde de gerçek hardcoded kullanıcı metni **yok**:

| Dosya | Durum | Not |
|---|---|---|
| `src/lib/components/SourceTreeNode.svelte` | i18n'e bağlı değil, ama sorun yok | Tek görünür metin `node.name` — vault dosya/klasör adı, veri kaynaklı, çevrilecek bir UI string'i değil. |
| `src/routes/chat/[id]/+page.svelte` | i18n'e bağlı değil, ama sorun yok | Dosya boş bir stub (`+page.server.ts`'nin her zaman redirect/404 attığı, SvelteKit'in route'un var olması için istediği placeholder). Render edilen içerik yok. |

**Sonuç:** Uygulama component'leri (routes + lib/components, ui/ hariç) tarafında dil değiştirme butonu eklemeye engel olacak, henüz `t()`'ye bağlanmamış gerçek bir hardcoded metin kalmamış.

## Gerçek bulgu: shadcn-svelte primitiflerinde 3 hardcoded İngilizce string

`ui/` primitifleri genelde kendi metnini taşımaz (slot/children ile çağıran component metni verir), ama 3 yerde kütüphane varsayılanı olarak sabit İngilizce metin var — bunlar hiçbir zaman `t()`'den geçmeyeceği için dil değiştirme butonu eklendiğinde **İngilizce kalacak** olan tek yerler:

| Dosya | Satır | Metin | Not |
|---|---|---|---|
| `src/lib/components/ui/dialog/dialog-footer.svelte` | 28 | `Close` | Varsayılan footer'ın kapama butonu — projede her yerde `Dialog.Footer` kendi butonlarıyla override ediliyor, bu varsayılanın gerçekten render edildiği bir yer olup olmadığı ayrıca kontrol edilmeli. |
| `src/lib/components/ui/dialog/dialog-content.svelte` | 42 | `Close` (`sr-only`) | Ekran okuyucuya özel, görsel olarak görünmüyor ama erişilebilirlik metni yine de dile göre değişmeli. |
| `src/lib/components/ui/sheet/sheet-content.svelte` | 49 | `Close` (`sr-only`) | Aynı, Sheet bileşeni için. |

**Öneri:** Dil değiştirme butonları eklenirken bu 3 yer de `t('Common.kapat')` (proje zaten `Common` namespace'inde `Kapat`/`Vazgeç`/`Sil` gibi paylaşılan anahtarlar tutuyor — `src/lib/i18n/messages/tr.json`) ile değiştirilmeli, aksi halde arayüzün geri kalanı Türkçe/İngilizce arasında geçiş yaparken bu 3 "Close" hep İngilizce kalır.

## Genel özet

- Taranan uygulama component'i: 44 (ui/ hariç)
- `t()`'ye bağlı: 42
- Bağlı değil ama sorun yok (veri/stub): 2
- **Gerçek hardcoded UI metni:** 0 uygulama component'inde, **3** shadcn-svelte primitifinde (`Close` x3).
