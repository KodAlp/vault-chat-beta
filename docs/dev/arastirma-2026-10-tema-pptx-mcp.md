# Araştırma — kullanıcı teması, PPTX rapor motoru, MCP ile vault açma/içe aktarma/düzeltme

Tarih: 2026-10-05 · Durum: araştırma + plan, kod yok · Dal: `claude/ui-multi-language-support-c4ab0b`

Bu belge, kullanıcının "ilerisi için planlar" listesindeki üç başlığı ele alır. Her başlıkta:
bugünkü durum (koddan), önerilen yol, kapı deneyi (kod yazmadan önce ölçülecek şey), riskler
ve açık sorular. Bulgular ilgili dosya/satırlarla verildi; doğrulanmamış iddialar "doğrulanacak"
diye işaretlendi.

---

## A. Kullanıcının kendi temasını oluşturması

### Bugün
- 5 tema `src/styles/tokens.css` içinde `[data-theme="…"]` blokları: light (`:root`), dark,
  cream, sand, forest. Her tema 29 değeri ezer: `color-scheme` + 28 renk/gölge token'ı
  (`bg-canvas`, `bg-sidebar`, `bg-grouped`, `bg-elevated`, `fill-*`, `bubble-user`,
  `label*`, `separator*`, `border-control`, `accent*`, `on-accent`, `focus-ring`,
  `danger/success/warning/info`, `scrim`, `material-bar`, `shadow-*`). Yazı tipi, boşluk,
  yarıçap gibi ~50 token temalar arasında ortak.
- 2026-10-05'te eklenen `--{info,warning,danger,success}-soft/-ring` tema-bağımsız
  türetilmiş token'lar — yeni bir temada otomatik çalışır (temanın durum rengi + tuvalinden
  `color-mix` ile hesaplanır). Kullanıcı teması için iyi bir örnek: türetilebilen her şey
  türetilmeli.
- Tema adları **dört yerde sabit**:
  1. `src/lib/settings.svelte.ts:2` — TS birleşim tipi.
  2. `src/lib/server/ui-prefs-store.ts:46` — `THEMES` izin listesi (bilinmeyen değer siliniyor;
     `ui-prefs-store.test.ts:41`).
  3. `src/styles/tokens.css` blokları.
  4. "Koyu tema mı?" listeleri: `src/app.css:13` (Tailwind `dark:` varyantı dark+forest),
     `src/app.css:270-273` (shiki kod renkleri), `src/routes/study/mindmap/[id]/+page.svelte:373`.
- Slayt teması (`src/lib/server/slides-theme.ts`) uygulama temasından tamamen bağımsız.

### Önerilen yol
1. **Şema:** tema = JSON
   `{ id, name, base: "light"|"dark", tokens: { "bg-canvas": "#…", … } }`.
   Eksik token'lar `base` temadan gelir → kısmi tema geçerli.
2. **Depolama:** `DATA_DIR/themes/<id>.json` (ui-prefs ile aynı atomik yazma deseni);
   `GET/PUT/DELETE /api/themes`. Sunucu her değeri doğrular: yalnız izinli token adları,
   değer yalnız renk sözdizimi (`#rgb[a]`, `#rrggbb[aa]`, `rgb()/hsl()/oklch()`) — CSS
   enjeksiyonu (`;}` ile kaçış, `url()`) engellenir.
3. **Uygulama:** `+layout.svelte` seçili kullanıcı temasını `document.documentElement.style`
   üzerine `--token: değer` olarak basar ve `data-theme="custom"` + ayrı
   `data-scheme="light|dark"` öznitelik koyar. Dört sabit listenin "koyu mu?" kontrolü
   `data-scheme`'e taşınır (dark/forest dahil yerleşik temalar da `data-scheme` yayar) —
   böylece shiki ve zihin haritası yeni temalarda da doğru seçilir.
   `settings.theme` tipi `BuiltinTheme | \`custom:${string}\`` olur; `THEMES` doğrulaması
   `custom:<id>` desenini ve dosyanın varlığını kabul eder.
4. **Düzenleyici (Ayarlar → Görünüm → "Tema oluştur"):**
   - Taban seç (5 yerleşik temadan biri) → kopyası üzerinde çalış.
   - "Basit" mod: 6 çekirdek renk — tuval, kenar çubuğu, metin, vurgu, tehlike, bilgi.
     Kalanı türetilir: `bg-grouped/elevated` = tuvalin ±%3-6 açık/koyu (oklch L),
     `label-secondary/tertiary` = metnin alfa %60/%30'u, `separator` = metnin %12'si,
     `accent-hover` = vurgu ±L, `accent-soft` = vurgu %16 alfa, `on-accent` = kontrasta göre
     siyah/beyaz.
   - "Gelişmiş" mod: 28 token'ın hepsi.
   - Canlı önizleme (sohbet balonu, düğmeler, bant, kenar çubuğu küçük örneği).
   - **WCAG denetimi:** metin/tuval, metin/elevated, on-accent/accent, accent-text/tuval
     ≥ 4.5; altındaysa uyarı rozeti (kaydetmeyi engellemez).
   - JSON dışa/içe aktar (paylaşılabilir tema dosyası).
5. **Slaytlarla bağ (B ile ortak):** `PresentationTheme` renkleri isteğe bağlı olarak
   uygulama temasından türetilebilir ("sunumu uygulama temamla üret").

### Kapı deneyi
Krem temayı JSON'a çevirip `style` yoluyla uygula; 5 ana ekranın ekran görüntüsünü yerleşik
krem temayla piksel düzeyinde karşılaştır (fark ≈ 0 olmalı). Fark varsa token dışı sabit
renk kalmış demektir — önce onlar temizlenir.

### Riskler / açık sorular
- Token dışı sabit renkler (shadcn köprüsü, shiki temaları) — kapı deneyi ortaya çıkarır.
- Kullanıcının çok düşük kontrastlı tema kaydetmesi: engellemek mi uyarmak mı? Öneri: uyar.
- Tema içinde yazı tipi seçimi: kapsam dışı öneriliyor (font lisans/gömme meselesi).

---

## B. PPTX üretebilen rapor/sunum motoru

### Bugün
- Model JSON üretir: `src/lib/server/slides-schema.ts` — 6 düzen
  (`title | bullets | two-column | quote | diagram | code`), her slaytta `heading`,
  `content_markdown`, `notes?`, `diagram?` (≤8 düğüm, ≤12 kenar), `source_id`.
  zod + JSON-schema ile doğrulanır, 2 kez geri beslemeli yeniden dener
  (`generate-slides.ts:118, 252-262`).
- Görüntüleme: `slides-deck.ts` → Marp markdown → `@marp-team/marp-core` HTML/CSS
  (sunucuda bir kez render, `study.db` `slidedecks.rendered_html`).
- Diyagram SVG'yi biz çiziyoruz (`slides-diagram.ts` `renderDiagramSvg`, mermaid yok).
- **Dışa aktarma yok** (PPTX/PDF/HTML indirme yok). `pptxgenjs` bağımlılık değil.
- Kullanıcının gözlemi doğru: slayt "arka planı renklendirilmiş düz yazı" — çünkü
  `content_markdown` serbest metin, düzenler yalnız CSS sınıfı.

### Kullanıcının taslağı ve önerilen eşleme

```
PresentationTheme (colors, fonts, spacing, borders, shadows)
SlideTemplates   (Concept, Comparison, Diagram, Process, Code, Formula, Summary)
ContentRenderer  (Text, Diagram, Chart, Code, Math)
PPTXRenderer     (PptxGenJS)
```

Önerilen mimari bu taslağı korur, araya **tek bir ara model** koyar:

```
model JSON (şema v2)  →  DeckModel (yerleşimi hesaplanmış, render-bağımsız)
                              ├── HtmlRenderer  → uygulama içi önizleme (Marp'ın yerini alır)
                              └── PptxRenderer  → .pptx indirme (PptxGenJS)
```

Neden ara model: aynı slaytın önizlemesi ile PPTX'i farklı kodlardan çıkarsa ikisi zamanla
ayrışır. `DeckModel` kutu koordinatlarını (inç/EMU), metin parçalarını (run), şekilleri ve
görselleri tutar; iki renderer yalnız "çizer".

**Şema v2 — içerik yapılandırılır, serbest markdown azalır:**

| Şablon | Model ne üretir | Çizim |
|---|---|---|
| Concept | başlık, tanım (1-2 cümle), 2-4 madde, isteğe bağlı örnek | metin + vurgu kutusu |
| Comparison | 2-3 sütun × satır özellik tablosu | yerel PPTX tablo |
| Diagram | mevcut düğüm/kenar modeli | yerel şekil + çizgi (aşağıda) |
| Process | 3-7 sıralı adım (başlık + kısa açıklama) | numaralı kutular + oklar (yerel şekil) |
| Code | dil + kod + 1-3 açıklama | shiki token'ları → renkli metin parçaları |
| Formula | LaTeX + değişken açıklamaları | düzenlenebilir denklem (aşağıda) |
| Summary | 3-5 çıkarım + kaynaklar | madde + kaynak dipnotu |
| Chart (yeni) | `{type: bar|line|pie, labels[], series[{name, values[]}]}` | yerel PPTX grafik |

Mevcut 6 düzen v2'ye eşlenir (title→Concept başlık slaytı, bullets→Concept/Summary,
two-column→Comparison, quote→Concept, diagram→Diagram, code→Code); eski desteler v1 olarak
okunmaya devam eder.

### Kütüphane: PptxGenJS
- MIT, Node + tarayıcı, ESM/CJS. Son sürüm **4.0.1 (Haziran 2025)**; 4.0.0 (Mayıs 2025)
  metin yönü desteği ekledi. 2026'da yeni sürüm yok — bakım yavaş ama proje canlı
  (6k+ yıldız). Kaynak: [releases](https://github.com/gitbrent/PptxGenJS/releases),
  [npm](https://www.npmjs.com/package/pptxgenjs).
- Destekler: yerel grafik, tablo, şekil, görsel (SVG dahil), slayt ana şablonu (master),
  konuşmacı notu, biçimli metin parçaları.
- Desteklemez: **matematik (OMML)** — açık istek: [#1456](https://github.com/gitbrent/pptxgenjs/issues/1456);
  bağlayıcı (connector) şekiller (doğrulanacak).

### Açık teknik noktalar ve öneriler
1. **Formül (en riskli).** Seçenekler:
   - (a) KaTeX → SVG/PNG görsel. Kolay, her yerde görünür; **düzenlenemez**.
   - (b) KaTeX'in MathML çıktısı → [mathml2omml](https://github.com/fiduswriter/mathml2omml)
     (saf JS, XSLT yok) → OMML'yi PptxGenJS'in ürettiği slayt XML'ine JSZip ile sonradan
     enjekte et. **Düzenlenebilir**, PowerPoint'te çift tıkla denklem düzenleyicisi açılır.
     Lisans **LGPL-3.0+** → masaüstü pakete gömmek için hukuk kararı gerekir
     (bkz. birleşik durum raporundaki bekleyen lisans kararları).
   - (c) Python tarafı: [pptx-math](https://github.com/maenjh/pptx-math) (LaTeX → OMML,
     python-pptx eşlikçisi) — ingest Python ortamı zaten var; lisansı doğrulanacak.
   - Öneri: (a) ile başla (her zaman çalışan yedek), (b)'yi kapı deneyiyle değerlendir;
     LibreOffice'in OMML'yi nasıl gösterdiği de ölçülmeli.
2. **Diyagram.** Mevcut düğüm/kenar modeline yerleşim için `elkjs` (EPL-2.0) ya da
   `@dagrejs/dagre` (MIT) → koordinatlar → yerel dikdörtgen + çizgi/ok. Düzenlenebilir.
   Yedek: bugünkü SVG'yi görsel olarak göm.
3. **Kod.** shiki zaten var; token renklerini `PresentationTheme` kod paletinden al, her
   satırı renkli metin parçası olarak yaz. Uzun kod → slayt başına satır sınırı, taşanı
   bölme ya da "devamı notlarda".
4. **Yazı tipi.** PPTX font gömmez (PptxGenJS'te gömme yok). Satoshi/Gambetta kullanıcının
   bilgisayarında yoksa PowerPoint değiştirir → tema fontları yaygın olanlardan
   (Aptos/Calibri/Segoe UI; Mac'te Helvetica yedeği). Türkçe karakter denetimi kapı
   deneyinde.
5. **Metin taşması.** PPTX'te otomatik küçültme güvenilmez → `DeckModel` kurulurken
   karakter bütçesi (başlık ≤ 60, madde ≤ 110 karakter, slaytta ≤ 6 madde); aşan içerik
   şemada reddedilir ve model yeniden dener (mevcut geri besleme döngüsü).
6. **Görsel uyum.** `PresentationTheme` = uygulama token'larından türetilmiş renk seti +
   font + boşluk ölçeği + köşe/gölge. Birkaç hazır tema + "uygulama temamdan" seçeneği (A ile ortak).

### Alternatifler (neden seçilmedi)
- **Marp CLI `--pptx`**: slaytları görsel olarak gömer — düzenlenemez; varsayılan dışı
  "editable" modu LibreOffice ister. Kullanıcının istediği "gerçek PPTX" değil.
- **python-pptx**: olgun, OMML enjeksiyonu kolay; ama render iki dile bölünür (önizleme JS,
  çıktı Python) ve paketli sürümde Python bağımlılığı artar. Formül için (c) yolu olarak
  akılda tutulur.
- **Aspose.Slides**: ticari lisans.

### Kapı deneyi (kod yazmadan önce)
Elle yazılmış 7 slaytlık örnek deste (her şablondan biri, Türkçe metin, bir formül, bir
diyagram, bir grafik) → tek betikle PptxGenJS çıktısı → PowerPoint + LibreOffice Impress'te
aç. Ölç: açılıyor mu ("onarım gerekiyor" uyarısı yok), metin düzenlenebilir mi, Türkçe
karakterler, formül (a) ve (b) görünümü, diyagram okları, dosya boyutu. Sonuç raporlanır,
sonra şema v2'ye geçilir.

### Aşamalar (öneri)
1. Kapı deneyi + rapor. 2. `DeckModel` + PptxRenderer (mevcut 6 düzen, formül = görsel).
3. Şema v2 + yeni şablonlar (Process, Comparison, Chart, Formula). 4. HtmlRenderer'ın
Marp'ın yerini alması. 5. Düzenlenebilir formül (lisans kararından sonra). 6. Aynı motorla
rapor (`report-schema.ts`) → DOCX/PDF (isteğe bağlı).

---

## C. MCP: vault oluşturma, içe aktarma ve (isteğe bağlı) düzeltme

### Bugün
- `mcp/` stdio sunucusu, 4 araç, hepsi `readOnlyHint: true`: `list_vaults`, `search_library`
  (yalnız vektör), `get_note`, `list_sources`. `withVault` (mutex, `mcpExposed` denetimi,
  her çağrıdan sonra index tutamacını kapatır). `index.db` salt-okunur açılır
  (`retrieve.ts:147`).
- `library-read.ts` salt-okunur yaprak modül; MCP yalnız onu içe aktarır. 2026-10-05'te
  eklenen elle düzenleme yolu (`library-write.ts`) MCP'den içe aktarılamadığı testle
  kilitlendi.
- MCP bugün yalnız tarayıcı akışının `data/`'sını okur; paketli Tauri sürümünün
  `%APPDATA%` verisini görmez (`ROADMAP.md` Faz 10.5).
- Vault oluşturma: `createVault(name)` (`vaults.ts:192`), `mcpExposed` varsayılan `false`.
  İçe aktarma: `POST /api/import` → `convert.py` kuyruğu → `_meta/staging/<importId>` →
  kullanıcı onayı (`/api/library/import/[id]/confirm`) → `library/<domain>/<slug>.md` +
  indeksleme + `import-log.jsonl`. "Klasör yapımız" (alan klasörü, slug, frontmatter,
  `_meta`) bu onay adımında uygulanıyor.

### Kullanıcı kararları (2026-10-05)
- MCP vault **oluşturabilir** ve kaynak **içe aktarabilir**; kütüphaneye yazma kullanıcının
  uygulamadaki onayıyla.
- MCP ile var olan notları **düzeltme**: izin verilecek ama **varsayılan kapalı**; Ayarlar →
  Gelişmiş → Geliştirici bölümünden açılır, açmadan önce kullanıcıya uyarı gösterilir.

### Önerilen mimari: MCP yazmaları uygulamanın API'sinden geçer
MCP süreci dosyalara **doğrudan yazmaz**; çalışan uygulamanın yerel HTTP API'sini çağırır.
- Tek yazıcı: `vaults.json` yarışı, indeks kilidi, docling/GPU kuyruğu tek yerde kalır
  (Faz 10.5'in "süreçler arası kilit" şartı böylece gereksizleşir).
- Aynı doğrulama: içe aktarma SSRF koruması, boyut sınırları, düzenlemede geçiş koruması +
  çakışma denetimi + revizyon yedeği — hepsi zaten uygulamada.
- Keşif: uygulama başlarken `DATA_DIR/mcp-endpoint.json` yazar (`{port, token, pid}`;
  dosya izinleri yalnız kullanıcı). Tauri'de sidecar portu rastgele ve `VC_SESSION_TOKEN`
  her açılışta yeni — MCP bu dosyadan okur. Uygulama kapalıysa araç anlamlı hata döner
  ("Vault Chat açık değil"). Okuma araçları bugünkü gibi doğrudan dosyadan çalışmaya devam
  eder (uygulama kapalıyken de arama yapılabilsin).

### Araçlar
| Araç | Ne yapar | Koşul |
|---|---|---|
| `create_vault(name)` | yeni vault; `mcpExposed: true`, arayüzde "MCP ile oluşturuldu" işareti | uygulama açık |
| `import_source(vault, path \| url, domain?)` | mevcut dönüştürme hattı → staging; `importId` döner | yerel yol izin listesindeki bir kök altında olmalı |
| `list_pending_imports(vault)` | staging'de onay bekleyenler | — |
| `edit_note(vault, path, content \| {find, replace}, baseHash)` | `library-write.ts` yolundan düzeltme; revizyon + `edit-log` `by:"mcp"` | **yalnız** geliştirici anahtarı açıkken araç listede görünür |
| `search_library` v2 | FTS/hibrit, `list_domains`, not bölümü getirme | Faz 10.5 maddeleri |

Onay akışı: içe aktarılan kaynaklar uygulamada bir "bekleyen içe aktarmalar" listesinde
görünür; kullanıcı alan klasörünü/başlığı düzeltip onaylar. Toplu onay seçeneği olabilir,
ama "onaysız içe aktarma" kullanıcı tarafından seçilmedi.

### Geliştirici anahtarı (MCP düzeltme)
- `ui-prefs.json` → `mcpEditEnabled: false` (varsayılan). Ayarlar → Gelişmiş → Geliştirici.
- Açarken uyarı diyaloğu: AI'ın kaynak notlarını değiştirebileceği; içe aktarılmış bir
  belgedeki gizli talimatların (prompt injection) bir ajanı yanlış düzeltmeye yönlendirebileceği;
  her değişikliğin revizyon olarak saklandığı ve geri alınabileceği. Açık onay düğmesi;
  kapatma onaysız ve anında.
- Kapalıyken `edit_note` araç listesinde **hiç yer almaz** (yalnız reddeden bir araç değil) —
  `readOnlyHint` smoke testi bu mod için geçerli kalır; açık mod için ayrı test.
- Arayüz: MCP düzenlemeleri görüntüleyicide "MCP tarafından düzenlendi · geri al" işaretiyle.
- Uygulamanın kendi sohbet modeli yazamaz (tek aracı `read_skill_file`) — bu değişmez.

### Güvenlik
Yeni tehdit sınıfı değil, mevcut sınıflar için yeni giriş kanalları:
- **Yerel dosya okuma (yol):** MCP istemcisi diskteki her dosyayı içe aktartabilirse bu bir
  veri sızdırma kanalıdır (ör. `~/.ssh/…` → not → arama). Önlem: kullanıcının arayüzde
  onayladığı kök dizin izin listesi; symlink çözümü sonrası kontrol; izinli uzantılar
  (`library.ts` `ALLOWED_EXTENSIONS`).
- **URL içe aktarma:** mevcut SSRF koruması (özel ağ, DNS, yönlendirme denetimi), akış
  halinde boyut sınırı, alt süreç zaman aşımı aynen kullanılır.
- **Prompt injection:** içe aktarılan içerik ajan talimatı taşıyabilir → staging + insan
  onayı; düzeltme anahtarı varsayılan kapalı + uyarı; revizyonla geri alma.
- **Yerel API kimlik doğrulaması:** `mcp-endpoint.json` belirteci; yalnız `127.0.0.1`;
  belirteç her açılışta yenilenir.
- **Denetim izi:** tüm MCP çağrıları `data/mcp-log.jsonl`'a (bugünkü gibi), düzenlemeler ayrıca
  `edit-log.jsonl`'a.
- **Kapsam dışı (açık madde):** içe aktarılan dosyalar için antivirüs taraması.

### Kapı deneyi
1. Uygulama API'si üzerinden `create_vault` + `import_source(PDF)` prototipi; Claude Desktop'tan
   uçtan uca: vault oluşur, staging'e düşer, arayüzde onaylanır, `search_library` bulur.
2. Paketli Tauri sürümünde `mcp-endpoint.json` keşfi (rastgele port + belirteç).

### Aşamalar (öneri)
1. `mcp-endpoint.json` + MCP'den uygulama API istemcisi. 2. `create_vault`,
   `import_source`, `list_pending_imports` + arayüzde bekleyen içe aktarmalar. 3. Kök dizin
   izin listesi ayarı. 4. Geliştirici anahtarı + uyarı + `edit_note` + "MCP tarafından
   düzenlendi" işareti. 5. Okuma tarafı iyileştirmeleri (FTS/hibrit, `list_domains`).

---

### Durum (2026-10-05)
- **C1-C3 yapıldı** (dal `claude/devam-etme-f3ce0f`, 48e9d58 + b6a6256): `mcp-endpoint.json` keşfi (dev: Vite eklentisi; Tauri: Rust, `VC_MCP_TOKEN`), `/api/mcp/*` belirteç kapısı (Origin reddi, oturum çerezinden bağımsız), `create_vault` / `import_source` / `list_pending_imports`, staging yan dosyası `<id>.json`, `/settings/library` üstünde bekleyen içe aktarmalar paneli, Vault ayarlarında izinli klasörler, URL yolu bağlantı içe aktarıcısıyla ortak `stage-url.ts`.
- Doğrulandı: birim testler, `mcp:smoke`, `cargo check`, izole uçtan uca (stdio istemci → onay → kütüphane), yol saldırıları (kök dışı, `..`, sembolik bağlantı), belirteçsiz/Origin'li istek reddi.
- Henüz denenmedi: gerçek Claude Desktop/Code istemcisiyle deneme, paketli Tauri'de `mcp-endpoint.json` (kapı deneyi 2), gerçek PDF + gerçek genel URL ile uçtan uca.
- Kalan: C4 (`edit_note` + geliştirici anahtarı), C5 (okuma iyileştirmeleri).

## Önerilen sıra
1. **C1-C2** (MCP vault + içe aktarma) — altyapısı (onay akışı, dönüştürme) hazır, en kısa yol.
2. **B kapı deneyi** — formül ve yazı tipi belirsizliklerini erken çözer.
3. **A** (tema) — bağımsız, B'nin `PresentationTheme`'ine renk kaynağı olur.
4. **B tam motor**, ardından **C4** (MCP düzeltme anahtarı).
