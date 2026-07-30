# Faz 9 — Alt yol haritası: Adım 1–4 (temel → ayarlar → primitifler)

## Context

Faz 8 (çoklu vault) tamamlandı ve commit'lendi (`0cbebdaf`). Sırada Faz 9
(shadcn-svelte frontend revizyonu) var; kullanıcı `docs/UI-PLAN.md`'yi
verdi ve kapsamı **yalnızca 1–4. adımlar** olarak onayladı (2026-07-30).

UI-PLAN'in 7 adımından 5–7 (vault seçici, ana ekran/kaynak ağacı/study
paneli, transkript komponentleri) bu belgenin **dışında** — en riskli ve en
çok özel komponent gerektiren kısım onlar, 1–4 bittikten sonra ayrıca
planlanacak.

### UI-PLAN'in koda karşı doğrulanması (yapıldı, düzeltmeler)

| UI-PLAN'in varsayımı | Gerçek durum |
|---|---|
| Token tablosu: `--text`, `--text-dim`, `--panel` | `src/app.css`'te bunlar **yok**. Gerçekler: `--fg`, `--muted`; `--panel` hiç yok. Ayrıca `--bubble-user/-assistant`, `--code-bg`, `--accent-fg`, `--error`, `--font-sans/-mono` var. |
| Koyu tema `.dark` sınıfı deseniyle | Uygulama `:root[data-theme='dark']` kullanıyor (`+layout.svelte` `matchMedia` ile daima somut `light`/`dark` yazıyor). Tailwind v4 `@custom-variant` ile korunur — layout mantığı yeniden yazılmaz. |
| Açık soru #3: "mindmap yeni üretici, per-note v1 ucuz yol" | **Geçersiz.** Mindmap Faz 7'de yazıldı, zaten retrieval-driven (per-topic) ve markmap ile render ediliyor (`generate-mindmap.ts:122`, `mindmap-tree.ts`, `study/mindmap/[id]`). "per-note v1" çalışan koddan geri adım olurdu. Soru kapandı. |
| Görsel bug: Türkçe karakter bozulması | **Yeniden üretilemedi.** Gerçek `chats.db`'de mojibake işareti (`Ä/Å/Ã`) **0 satır**; Türkçe içerik sorunsuz ("Dağılım", "başkenti"). Somut bir repro gelmeden iş ayrılmamalı. |
| Görsel bug: `[LOW]` etiketleri sızıyor | **Gerçek.** 43 asistan mesajının 4'ünde ham `[LOW]` var; `prompt.ts`'te veya kullanıcı skill'lerinde bunu isteyen hiçbir şey yok (modelin kendi alışkanlığı). |
| Görsel bug: kaynak çipi tekrarı | **Gerçek.** `SourceList.svelte:10` `source.path + source.heading_path` ile key'liyor, ama `retrieve()` dosya başına 3 chunk'a izin veriyor → aynı kaynak 3 çip. |

Not: son iki bug **5–7. adımlarda** (transkript) kapatılıyor, bu alt yol
haritasında değil.

### Bu turda kilitlenen kararlar

1. **Indigo kalıyor** (`#4f46e5` açık / `#818cf8` koyu). Karakter; radius
   ölçeği, tipografi ve boşluktan gelecek — hue değişmiyor. Böylece 1. adımın
   "sıfır görsel değişiklik" kabul testi geçerli kalır.
2. **Study üreticileri: panel + route birlikte.** Mevcut `/study/*` route'ları
   silinmiyor (derin bağlantı + tam ekran); sağ panel 5–6. adımda gelince
   aynı komponentleri gömer, "tam ekrana genişlet" o route'a gider.
3. **Dışa aktar** = Faz 1'de yazılmış mevcut `/api/chats/[id]/export`
   (md/json). Yeni backend işi yok.
4. "Son vault'u hatırla" varsayılanı 5. adımın konusu (vault seçici) — bu
   belgenin dışında.

---

## Adım 1 — Token köprüsü (mekanik rename, sıfır görsel değişiklik)

Tek dosya ağırlıklı: `src/app.css` + tüm `<style>` bloklarındaki `var(--x)`
kullanımları.

**Doğrulanmış eşleme** (UI-PLAN'in tahmini değil, `app.css`'in gerçeği):

| Mevcut | shadcn karşılığı | Not |
|---|---|---|
| `--bg` | `--background` | |
| `--fg` | `--foreground` | |
| `--muted` | `--muted-foreground` | mevcut kullanım *soluk metin*, arka plan değil |
| `--border` | `--border` | değişmiyor |
| `--accent` | `--primary` | **tuzak, aşağıya bak** |
| `--accent-fg` | `--primary-foreground` | |
| `--error` | `--destructive` | |
| `--code-bg` | `--muted` | shadcn'de `--muted` = soluk *arka plan* |
| `--bubble-user` / `--bubble-assistant` | (aynen kalır) | uygulamaya özgü, shadcn token'ı değil |
| `--font-sans` / `--font-mono` | `@theme` içinde aynı adla | Tailwind v4 tipografi token'ı |

> **`--accent` ad çakışması — bu adımın tek gerçek riski.** shadcn'de
> `--accent` markanın rengi DEĞİL; hover/seçili satır gibi *silik bir arka
> plan*. Mevcut `--accent` ise marka indigo'su. Olduğu gibi bırakılırsa
> kopyalanan her shadcn komponenti indigo'yu hover zemini sanıp kullanır ve
> arayüz gözle görülür biçimde bozulur. Marka rengi **`--primary`** olmalı;
> `--accent`/`--accent-foreground` ayrıca, silik nötr değerlerle tanımlanır.

Ayrıca shadcn'in beklediği ve şu an **hiç olmayan** token'lar eklenir:
`--card`, `--card-foreground`, `--popover`, `--popover-foreground`,
`--secondary`, `--secondary-foreground`, `--accent`, `--accent-foreground`,
`--destructive-foreground`, `--ring`, `--input`, `--radius`. Değerler mevcut
paletten türetilir (koyu/açık iki blokta da).

**Kabul testi:** `npm run dev` ile açık ve koyu temada tam tur — çıktı
birebir aynı görünmeli. Değişen tek şey isimler.

---

## Adım 2 — Tailwind v4 + shadcn-svelte kurulumu

- Bağımlılıklar: `tailwindcss@4`, `@tailwindcss/vite`, `clsx`,
  `tailwind-merge`, `tailwind-variants`, `bits-ui`, `lucide-svelte`.
- `vite.config.ts`'e `tailwindcss()` plugin'i; `src/app.css`'e
  `@import 'tailwindcss'` + `@theme` bloğunda 1. adımın token'ları.
- **Koyu tema:** `.dark` sınıfına geçilmez. Bunun yerine:
  ```css
  @custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
  ```
  Böylece `+layout.svelte`'in doğrulanmış `data-theme` mantığına hiç
  dokunulmaz.
- `npx shadcn-svelte@latest init` — `components.json`, `$lib/utils.ts` (`cn`),
  `$lib/components/ui/` iskeleti.

> **Bu adımın asıl riski preflight.** Tailwind'in reset'i global: buton
> stilleri, başlık boyutları, liste madde işaretleri ve margin'ler sıfırlanır.
> Uygulamanın 6.7k satırlık scoped CSS'i tarayıcı varsayılanlarına güveniyor.
> **En kırılgan yer markdown çıktısı** — `markdown.ts`'in ürettiği HTML
> scoped değil (başlıklar, listeler, tablolar, `pre`/`code`, KaTeX ve shiki
> çıktısı). UI-PLAN bunu hiç anmıyor; bu adımın somut bir teslimatı olarak
> render edilen markdown için başlık/liste/tablo stillerini geri veren
> kapsayıcı bir kural seti (`.markdown-body` benzeri) yazılacak.
> `app.css`'teki mevcut shiki dark-mode `!important` override'ı ve
> `.katex-error` kuralı korunacak.

**Kabul testi:** her iki temada tam görsel tur; özellikle matematik + kod
bloğu + liste içeren uzun bir sohbet mesajı ve `/library/view`. `npm run
build` temiz.

---

## Adım 3 — `/settings` shadcn ile yeniden yazımı

İlk gerçek shadcn yüzeyi; eskiden çevirme değil, sıfırdan yazım (UI-PLAN'in
kendi sırası). Kapsam ~1.100 satır:

- `settings/+page.svelte` (288) — tema, model seçimleri, Tauri kasa paneli
- `settings/providers/+page.svelte` (483) — Faz 6 sağlayıcı UI'ı, en büyüğü
- `settings/vaults/+page.svelte` — **Faz 8'de bilerek süssüz bırakıldı**,
  değiştirilmek üzere yazılmıştı; en doğal ilk hedef
- `settings/skills/`, `settings/library/`

Kullanılacak primitifler: `card`, `button`, `input`, `label`, `switch`,
`select`, `separator`, `badge`, `tooltip`, `dialog`, `alert-dialog`
(vault silme onayı — şu an elle yazılmış modal).

**Kabul testi:** her ayar ekranı iki temada; sağlayıcı anahtarı ekle/sil/test
akışı ve vault oluştur/yeniden adlandır/sil akışı uçtan uca çalışır durumda
(Faz 6/8 API'leri değişmiyor, yalnızca sunum).

---

## Adım 4 — Primitif benimseme + üretim diyaloglarının birleştirilmesi

Uygulama genelinde elle yazılmış modal/menü/tooltip'ler shadcn primitiflerine
geçer. Bu adımın büyük kazancı **doğrulanmış kopya-kod tasfiyesi**:

- **5 üretim diyaloğu** — `QuizDialog` (263), `CardsDialog` (287),
  `SlidesDialog` (215), `ReportDialog` (215), `MindMapDialog` (215) = **1.195
  satır**. Doğrulandı: `MindMapDialog` ↔ `ReportDialog` farkı 215 satırda 36
  satır, anlamlı fark yalnızca **5 yerde** (buton etiketi, emoji, başlık,
  alan etiketi, placeholder). Tek bir parametreli `GenerationDialog` + tip
  başına küçük bir config nesnesine iner.
- **5 durum komponenti** — `*GenerationStatus.svelte`, 4'ü tam olarak 95
  satır = **474 satır**. Aynı şekilde tek komponente iner.
- `ExportMenu` → `DropdownMenu` (kararın gereği: mevcut md/json endpoint'i).
- `UploadDialog`, `ImportObsidianDialog` → `Dialog`.

> `src/lib/*-generation.svelte.ts` (5 dosya, 56–69 satır) yapısal olarak
> paralel ama isimlendirme her satırda farklı (report↔slides diff'i 59
> satırda 55 satır). Bunlar **UI değil durum mantığı**; birleştirme
> mekanik kalmazsa bu adımda zorlanmayacak, ayrı not düşülecek.

**Kabul testi:** beş üreticinin de (test, kart, rapor, slayt, mindmap)
diyaloğu açılıyor, canlı Ollama'ya karşı üretim başlıyor, durum komponenti
ilerlemeyi gösteriyor ve sonuç mevcut `/study/*` route'unda açılıyor —
yani Faz 3/7 davranışı korunuyor.

---

## Kapsam dışı (5–7. adımlar, ayrıca planlanacak)

Vault seçici ve sohbet listesi sayfaları; ana ekran üç bölge düzeni;
tri-state kaynak ağacı + `included_paths` bağlanması; kapsam göstergesi ve
"kapsamı genişlet" önerisi; sağ study paneli (Sheet/Resizable); transkript
komponentleri (ChatBubble, SourceChip, ThinkingPanel, FallbackNotice,
ConfidenceBadge); `[LOW]` etiketi ve kaynak çipi dedup bug'ları.

---

## Doğrulama (her adım için ortak)

1. `npm test` (40 test), `npx svelte-check` (0/0), `npm run build` — her
   adımın sonunda temiz.
2. Açık **ve** koyu temada elle görsel tur; adım 2'den sonra özellikle
   markdown/KaTeX/shiki çıktısı.
3. Her adım en az bir commit; commit öncesi temiz `git status`
   (takılma disiplini kuralı: başarısız denemeler `git checkout` ile
   geri alınabilsin).
4. Aynı hatada 3 denemeden fazla dönülmez → `docs/stuck-report.md` + kullanıcıya danış.
