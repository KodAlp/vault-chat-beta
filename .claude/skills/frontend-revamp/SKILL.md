---
name: frontend-revamp
description: >
  Phase 9 of vault-agent-toolkit: shadcn-svelte + Tailwind v4 frontend
  revamp. Use this skill whenever touching app.css tokens, installing/
  configuring Tailwind or shadcn-svelte, rewriting a page under
  src/routes/settings/, adding or copying a shadcn-svelte component under
  src/lib/components/ui/, or consolidating the generation dialogs
  (QuizDialog/CardsDialog/SlidesDialog/ReportDialog/MindMapDialog) and
  their status components. Depends on Faz 8 (vault registry) being done;
  do not start Faz 10 (MCP server) work from inside this skill.
scope: frontend
---

# Frontend Revamp — Phase 9

## Ortak kural — takılma disiplini

Aynı hata için en fazla 3 farklı çözüm denemesi yapılır. 3. deneme de
başarısızsa DUR: `docs/stuck-report.md` dosyasına (a) hatanın tam çıktısı,
(b) denenen 3 yaklaşım ve neden başarısız oldukları, (c) en güçlü hipotez
yazılır ve kullanıcıya danışılır. Aynı dosyada küçük değişiklikler
deneyerek 4., 5. tur ATILMAZ. Bir hata "çözüldü" sayılmadan önce doğrulama
komutu (test/build/çalıştırma) mutlaka koşulur; çıktısı görülmeden sonraki
adıma geçilmez. Her çalışma oturumu temiz git durumuyla başlar; 3 denemelik
döngü öncesi commit atılır ki başarısız denemeler `git checkout` ile geri
alınabilsin.

## Plan-önce kuralı (bu skill'in ilk maddesi)

Koda dokunmadan önce model `docs/UI-PLAN.md` üretir/günceller: route
haritası, ekran başına bölge krokisi (ASCII wireframe yeterli), komponent
envanteri, taşınma sırası. Kullanıcı bu planı ONAYLAMADAN implementasyon
başlamaz. Kullanıcının tasarım dokümanı planın girdisidir.

**Bu faz alt bölümlere ayrılabilir ve kısmen onaylanabilir** — ilk pratik
örneği: `docs/UI-PLAN.md`'nin 7 adımından yalnızca 1–4'ü onaylanıp
`docs/FAZ9-ADIM-1-4.md` olarak ayrı bir alt yol haritasına yazıldı
(2026-07-30), 5–7 (vault seçici, ana ekran, transkript komponentleri) ayrı
onay bekliyor. Bir sonraki alt bölüme geçmeden önce her zaman aynı
disipline uy: doğrula → planla → sor → onay al.

**Plandaki her varsayım koda karşı doğrulanmalı, doğru kabul edilmemeli.**
İlk geçişte (`UI-PLAN.md` yazılırken) token adları, "bug" iddiaları ve
"yeni üretici gerekiyor" gibi kapsam varsayımlarının hepsi tahmindi;
gerçek kodla karşılaştırıldığında token tablosu tamamen yanlış çıktı, bir
"görsel bug" (Türkçe karakter bozulması) hiç yeniden üretilemedi, ve bir
"yeni üretici" (mindmap, per-note v1) aslında Faz 7'de zaten
retrieval-driven olarak yazılmıştı — bkz. `FAZ9-ADIM-1-4.md`'nin
doğrulama tablosu. Bu düzeltmeler yapılmadan plan onaya sunulsaydı, yanlış
temel üzerine inşa edilirdi.

## Kilitlenen kararlar (yeniden tartışılmaz)

1. **shadcn-svelte (bits-ui) + Tailwind v4, lucide-svelte ikonlar.**
   Komponentler kopyalanır ve minimum modifiye edilir; özelleştirme tema
   token'larında ve sarmalayıcı komponentlerde yapılır. Skeleton/Flowbite
   gibi ikinci bir komponent framework'ü EKLENMEZ.
2. **Marka rengi indigo kalıyor** (`#4f46e5` açık / `#818cf8` koyu,
   kullanıcı onayı 2026-07-30). Token köprüsünde hue değiştirilmez —
   yalnızca doygunluk/radius/tipografi ile karakter verilir.
3. **Koyu tema mekanizması değişmiyor.** Uygulama `:root[data-theme='dark']`
   kullanıyor (`+layout.svelte` `matchMedia` ile daima somut bir değer
   yazıyor), `.dark` sınıfı deseni DEĞİL. Tailwind v4'te
   `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`
   ile köprülenir — layout mantığına dokunulmaz.
4. **`--accent` adı shadcn'de yeniden atanır, korunmaz.** shadcn'de
   `--accent` = silik hover/seçili-satır zemini, marka rengi DEĞİL.
   Mevcut `--accent` (marka indigo'su) → `--primary` olur; `--accent`/
   `--accent-foreground` ayrıca nötr değerlerle yeniden tanımlanır. Bu
   ayrım gözden kaçırılırsa her kopyalanan komponent indigo'yu hover
   zemini sanır ve arayüz gözle görülür biçimde bozulur.
5. **Study üreticileri: panel + route birlikte, route silinmez.**
   `/study/*` route'ları (quiz/cards/mindmap/report/slides) kalıcı —
   derin bağlantı ve tam ekran için gerekli. Sağ panel (Adım 5–6) bu
   route'ları AYRI bir sayfa olarak değil, aynı komponentleri gömerek
   sunar; "tam ekrana genişlet" o route'a gider.
6. **Dışa aktarma kapsamı = sohbet, mevcut endpoint.** `ExportMenu`
   mevcut `/api/chats/[id]/export`'a (md/json) bağlanır. Study artifact
   dışa aktarımı bu fazın kapsamında değil.

## Migration order (bkz. `docs/FAZ9-ADIM-1-4.md` için ayrıntı)

1. Token köprüsü — mekanik rename, sıfır görsel değişiklik kabul testi.
2. Tailwind v4 + shadcn init — preflight regresyonları (özellikle
   `markdown.ts`'in scoped OLMAYAN çıktısı: başlık/liste/tablo/kod/KaTeX)
   bu adımda kapatılır.
3. `/settings` sıfırdan shadcn ile yazılır (çevirme değil) — Faz 6
   provider UI'ı ve Faz 8 vault paneli dahil.
4. Primitif benimseme + kopya-kod tasfiyesi (beş üretim diyaloğu → tek
   `GenerationDialog`, beş durum komponenti → tek `GenerationStatus`).
5. Vault seçici + sohbet listesi (Faz 8'in `/vault/[id]` route'larına
   bağlanır).
6. Ana ekran: kaynak ağacı → kapsam göstergesi → study paneli → transkript
   komponentleri (en riskli, en özel).
7. Görsel bug kapatma — yalnızca somut biçimde yeniden üretilebilenler.

Her adım en az bir commit; commit öncesi `git status` temiz olmalı.

## Bitti tanımı (Adım 1–4 için — 5–7 ayrı onaylanacak)

- [ ] Token köprüsü: açık/koyu temada `npm run dev` çıktısı öncesiyle
      birebir aynı.
- [ ] Tailwind v4 + shadcn kurulu; markdown/KaTeX/shiki çıktısı iki
      temada da bozulmadan render oluyor.
- [ ] `/settings/*` tüm sayfalar shadcn ile; sağlayıcı ve vault CRUD
      akışları uçtan uca çalışıyor (Faz 6/8 API'leri değişmedi).
- [ ] Beş üretim diyaloğu tek komponente indi; tümü canlı Ollama'ya karşı
      test edildi (üretim başlıyor, sonuç `/study/*`'ta açılıyor).
- [ ] `npm test` / `svelte-check` / `npm run build` her adımın sonunda
      temiz.

## Kapsam dışı (bu fazda yapılmaz)

Vault seçici/sohbet listesi/ana ekran (Adım 5–7, ayrı onay bekliyor);
`[LOW]` etiketi ve kaynak-çipi tekrarı bug'ları (transkript komponentleri
yazılmadan kapatılamaz); "son vault'u hatırla" davranışı; study artifact
dışa aktarımı; giriş logosu animasyonu (Tauri sonrasına ertelendi).
