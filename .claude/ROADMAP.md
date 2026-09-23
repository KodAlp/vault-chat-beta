# Vault Chat → Yerel NotebookLM: Yol Haritası

Hedef: Bugünkü tek sayfalık chat uygulamasını, yerel çalışan, kaynak
kütüphaneli, test/bilgi kartı üretebilen, kullanıcı-skill destekli bir
öğrenme uygulamasına dönüştürmek. Fazlar en basitten en karmaşığa
sıralandı; her faz kendi başına teslim edilebilir ve bir sonrakine zemin
hazırlar. **Bir faz bitmeden sonrakine geçilmez.**

---

## Faz 0 — Stabilizasyon (mevcut bug'lar)

Yeni özellik eklemeden önce üç bug kapatılır. Görev tanımı:
`tasks/bugfix-brief.md` (düşük maliyetli bir modelin tek başına
uygulayabileceği kadar ayrıntılı yazıldı).

1. Stream sırasında `$$` KaTeX parse hatası
2. Scroll çubuğu bug'ı (konuşmanın başına dönülemiyor)
3. Thought-process panelinin uzun cevapta layout'u çökertmesi

Kabul ölçütü: brief'teki üç senaryo da hatasız; `markdown.ts` acid test
string'leri hâlâ geçiyor.

## Faz 1 — Kalıcılık (recent chats'in altyapısı)

- Konuşmalar `data/chats.db`'ye (better-sqlite3) kaydedilir:
  `chats(id, title, model, created_at, updated_at)` +
  `messages(id, chat_id, role, content, thinking, sources_json, created_at)`.
- Başlık: ilk sorudan modele tek satırlık özet ürettirilir (8B, düşük öncelik).
- Dışa aktarma: konuşmayı `.md` ve `.json` olarak indirme endpoint'i.
- UI değişikliği minimum: şimdilik basit bir "geçmiş" dropdown'ı yeter;
  gerçek ekran Faz 2'de gelir.

Neden önce bu: Faz 2'deki karşılama/recent-chats ekranları veri olmadan
boş kabuk olur.

## Faz 2 — Uygulama kabuğu (frontend yeniden yapılanma)

Listendeki frontend maddelerinin karşılığı:

- **Karşılama ekranı** (`/`): selamlama + son konuşmalar listesi
  (chats.db'den) + "yeni konuşma" butonu.
- **Chat ekranı** (`/chat/[id]`): üç bölge —
  sol: kaynak/klasör ağacı (daraltılıp genişletilebilir),
  orta: chat,
  sağ üst: dışa aktar + ayarlar ikonları,
  sağ orta: üretim butonları (test, bilgi kartı; ileride mindmap/rapor/slayt),
  sağ alt: profil alanı (şimdilik yer tutucu — hesap sistemi Faz 7+).
- **Ayarlar** (`/settings`): tema (açık/koyu), varsayılan model,
  "hızlı model / muhakeme modeli" ataması. Model indirme ve API
  bağlantıları bu ekranda YER TUTUCU olarak bulunur, işlevi Faz 6'da.
- Svelte 5 runes ile global store: `appState` (tema, aktif model,
  açık chat). Scroll ve reactivity dersleri (Faz 0) burada uygulanır.

## Faz 3 — Test ve Bilgi Kartları (zorunlu üreticiler)

Skill: `skills/study-artifacts/SKILL.md`. Özet:

- Sağ paneldeki butonlar seçili kaynak/domain'den veya mevcut konuşmadan
  üretim tetikler.
- Model çıktısı katı JSON şemasında alınır, zod ile doğrulanır; quiz ve
  kartlar sqlite'a kaydedilir, çözüm/tekrar ekranları eklenir.
- Her soru/kart kaynağını (`source_path`) göstermek zorundadır —
  NotebookLM'in "grounded" yaklaşımının yereli.

## Faz 4 — Kullanıcı Skill Sistemi

Skill: `skills/user-skills/SKILL.md`. Kullanıcı `data/skills/` içine
`MathSkill.md` gibi dosyalar koyar; ayarlardan aç/kapa yapılır; içerik
sistem promptuna kontrollü biçimde eklenir. Claude Code skill formatıyla
bilinçli olarak aynı (frontmatter: name, description, scope).

## Faz 5 — Kaynak Kütüphanesi (Obsidian bağımsızlığı)

Skill: `skills/source-ingest/SKILL.md`. Özet:

- Uygulama kendi `data/library/` klasörünü tutar; Obsidian vault'u
  TEK YÖNLÜ kopyalanarak içe aktarılır (senin vault'un bozulmaz,
  Obsidian kullanmayanlar da uygulamayı kullanabilir).
- PDF/DOCX/PPTX/XLSX → Markdown dönüşümü Python yardımcı scriptleriyle:
  varsayılan MarkItDown, karmaşık/matematikli PDF'te Marker veya Docling,
  LaTeX kaynağında Pandoc (araştırma raporundaki karşılaştırmaya göre).
- `pdf2md.py`'deki sha256-atlama ve OCR bayrağı desenleri korunur.
- İndeksleyici artık `VAULT_PATH` yerine `LIBRARY_PATH` üzerinde çalışır.

## Faz 6 — Model Sağlayıcı Katmanı

Mimari kararı verildi, skill yazıldı: `skills/model-provider/SKILL.md`.
Ollama yerel çalışma zamanı olarak kalıyor (llama.cpp/doğrudan GGUF yok),
`ProviderAdapter` arayüzünün altında bulut sağlayıcılarla (DeepSeek/
OpenAI/Gemini/Kimi) birlikte sarmalanıyor. API anahtarları
`data/secrets.json` (gitignored) — OS keychain Faz 7'nin Tauri paketine
bırakıldı.

- **Tamamlandı** (bkz. `SESSION-LOG.md`, 2026-07-30): `src/lib/server/providers/`
  — adapter arayüzü, sunucu taraflı single-flight, üç kademeli timeout,
  hata sınıflandırması, think-tag/reasoning_content normalizasyonu,
  fallback zinciri. Beş chat-completion çağrı noktası (chat SSE, başlık,
  notlandırma, test, bilgi kartı) katmandan geçecek şekilde taşındı.
  Ayarlar arayüzü (`/settings/providers`: sağlayıcı listesi, etkin/pasif,
  anahtar girişi/maskesi/silme, bağlantı testi, görev başına zincir
  düzenleyici), sohbet başına model/sağlayıcı override (chat başlığında
  seçici, `chats.model` üzerinden kalıcı), fallback bildirimlerinin
  transkriptte sistem notu olarak gösterilmesi. Yanlış API anahtarı UX'i:
  `chatWithFallback`'in `ProviderError.retryable` kontrolü eksikti (her
  hata zincirdeki sıradaki sağlayıcıya sessizce geçiyordu, auth hataları
  dahil) — düzeltildi, artık kalıcı hatalar (auth/bad_request/
  context_length) asla fallback denemiyor. Kesinti/single-flight canlı
  Ollama'ya karşı doğrulandı: aynı chat'e üst üste mesaj → eski flight
  temiz aborte oluyor, hiç iç içe geçme yok; istemci tarafı abort sonrası
  sunucu ~70ms içinde yeni isteğe hazır (Ollama yükü gerçekten düşüyor).

## Faz 7 — İleri Üreticiler ve Dağıtım

- **Mind map/rapor/slayt üreticileri tamamlandı** (bkz. `SESSION-LOG.md`,
  2026-07-30) — study-artifacts deseninin (scope → retrieve →
  şema-doğrulamalı structured output → sakla → render) markmap-lib,
  mevcut `renderMarkdown()`, ve `@marp-team/marp-core` ile genişletilmesi.
  Mind map modele düz (flat) bir `path: string[]` listesi ürettiriyor,
  ağaç istemci tarafında `buildTree()` ile kuruluyor (recursive şema
  yerine — yapısal olarak daha güvenli). Rapor'un `source_paths`
  alanı çoklu-kaynaklı bölüm sentezini destekliyor (subset + "her şeyi
  her yere ekleme" hedge kontrolüyle). Slayt Marp'ı sunucu tarafında
  tek seferde render edip `<iframe sandbox="">` ile izole ediyor; canlı
  Ollama'ya karşı test edilirken gerçek bir bug bulundu ve düzeltildi
  (marp-core'un KaTeX eklentisi `$ x $` gibi iç boşluklu inline math'i
  sessizce metin olarak bırakıyor — modelin doğal çıktısı tam olarak bu
  şekilde geliyordu).
- **Tauri masaüstü paketi tamamlandı (Windows)** (bkz. `SESSION-LOG.md`,
  2026-07-30) — sidecar deseni: Rust `src-tauri/` kabuğu `node build`'ı
  dış süreç olarak başlatıyor (kullanıcının kendi kurulu Node'una güveniyor,
  native modülleri (`better-sqlite3`/`sqlite-vec`) bir Node runtime'ı da
  paketlemeye çalışmaktan daha güvenli), boş bir portta hazır olmasını
  bekliyor, WebView penceresini `http://127.0.0.1:<port>`'a yönlendiriyor.
  İlk açılışta native klasör seçiciyle kasa yolu isteniyor, `%APPDATA%\
  Roaming\app.vaultchat.desktop\config.json`'a yazılıyor; uygulama verisi
  (DB'ler, config) `data/`'dan tamamen ayrı bir konumda. `npm run
  desktop:dev` (canlı Vite'a karşı, HMR) / `npm run desktop:build` (NSIS
  installer). Gerçek kurulmuş `.exe` üzerinde uçtan uca doğrulandı:
  sidecar spawn, health-check, `/api/*` yanıtları, DB'lerin doğru dizinde
  oluşması, graceful quit'te sidecar'ın kapanması.
  - Kurulum/paketleme sırasında bulunan dört gerçek bug (detay
    `SESSION-LOG.md`'de): (1) bu repo'nun klasör adındaki parantezler
    adapter-node'un build adımını bozuyordu — **`node build` kalıcı
    kullanım akışı Tauri'den bağımsız olarak zaten kırıktı**, düzeltildi;
    (2) `node:fs`'in `cpSync`/`rmSync`'i bu repo'nun Türkçe karakterli
    yolunda Windows'a özgü hatalar veriyor, `robocopy`/PowerShell'e
    geçildi; (3) Tauri'nin `bundle.resources` obje-eşleme biçimi
    derleme hatası veriyor, glob biçimi ise dizin yapısını sessizce
    düzleştirip sunucuyu `ERR_MODULE_NOT_FOUND` ile çöktürüyor — dizi
    biçimine geçilerek çözüldü; (4) paketlenmiş bir release build'de
    konsol olmadığından, teşhis için kalıcı dosya loglaması eklendi.
  - **Zorla kapatma/çökme durumunda sidecar artık yetim kalmıyor**
    (bkz. `SESSION-LOG.md`, aynı gün ikinci geçiş) — Windows Job Object
    (`win32job` crate), `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ile: sidecar
    process'i job'a atanıyor, `app.exe`'nin herhangi bir şekilde
    sonlanması (graceful, force-kill, çökme) job handle'ını kapatıyor,
    Windows kendisi job'a atanmış her süreci otomatik sonlandırıyor —
    hiçbir Rust kodu çalışmadan. Canlı doğrulandı: `taskkill /F` daha
    önce `node.exe`'yi yetim bırakıyordu, artık bırakmıyor.
  - **Sistem tepsisi (tray) ikonu eklendi** — "Göster" (pencereyi öne
    getir) + "Çıkış" menüsü, sol tık de aynı şekilde pencereyi öne
    getiriyor. Pencere kapatma davranışı bilinçli olarak değiştirilmedi
    (tepsiye küçültme yok) — zaten doğrulanmış graceful-quit akışını
    bozmamak için.
  - **Ertelenen** (bilinçli, gerekçeli): Mac/Linux hedefleri (bu ortamda
    doğrulanamaz); "tarayıcı / masaüstü / ikisi" kurulum seçimi arayüzü
    (aynı sunucu sarmalandığı için asıl karar hangi installer'ı
    indirdiğin, göründüğünden hafif); Ollama/Python'u pakete gömme
    (minimal-footprint duruşuna aykırı); code signing/notarization ve
    auto-update (ödemeli hesap/altyapı gerektiriyor).
- **Kişisel hesap/profil sistemi kapsam dışı bırakıldı** — roadmap'in
  kendi ifadesi ("ancak burada anlam kazanır") koşulluydu, zorunlu değil;
  uygulama halen tek kullanıcılık kişisel bir araç (kendi kasan
  üzerinde çalışan yerel NotebookLM), çoklu-kullanıcı veri ayrımı bu an
  için gerçek bir ihtiyaç değil. Gerçek bir ihtiyaç doğduğunda ayrı bir
  faz olarak ele alınmalı, önceden inşa edilmemeli.

**Faz 7 tamamlandı.**

---


# ROADMAP — Faz 8, 9, 10

Üç faz bilinçli olarak ayrıştırılmıştır: **mimari (8) → frontend (9) →
MCP (10)**. Her fazın kendi skill dosyası vardır ve model bir fazın
içindeyken diğer fazların işine GİRMEZ. Faz 8 bitmeden Faz 9 UI'ı,
Faz 9 bitmeden Faz 10 paketlemesi başlamaz.

## Ortak kural — takılma disiplini (tüm skill'lere eklenecek)

Faz 7'de yaşanan "aynı hatada uzun süre dönme" sorununa karşı her üç
skill de şu bloğu içerir:

> Aynı hata için en fazla 3 farklı çözüm denemesi yapılır. 3. deneme de
> başarısızsa DUR: `docs/stuck-report.md` dosyasına (a) hatanın tam
> çıktısı, (b) denenen 3 yaklaşım ve neden başarısız oldukları, (c) en
> güçlü hipotez yazılır ve kullanıcıya danışılır. Aynı dosyada küçük
> değişiklikler deneyerek 4., 5. tur ATILMAZ. Bir hata "çözüldü"
> sayılmadan önce doğrulama komutu (test/build/çalıştırma) mutlaka
> koşulur; çıktısı görülmeden sonraki adıma geçilmez. Her çalışma
> oturumu temiz git durumuyla başlar; 3 denemelik döngü öncesi commit
> atılır ki başarısız denemeler `git checkout` ile geri alınabilsin.

---

# Faz 8 — Çoklu Vault Mimarisi

Skill: `skills/vault-registry/SKILL.md`

## Amaç

Tek `LIBRARY_PATH` varsayımını kaldırıp çoklu vault veri modelini
kurmak. Bu bir UI özelliği DEĞİLDİR; her katmana dokunan backend
işidir ve Faz 9 (frontend) bunun üzerine kurulacaktır. Bu fazda UI
yalnızca çalışır durumda tutulur (geçici olarak "default vault" ile),
görsel iş yapılmaz.

## İş kalemleri

1. **Vault kayıt defteri.** `data/vaults.json`: `{ id, name, path,
   createdAt, lastOpenedAt }`. CRUD servis fonksiyonları + path
   doğrulama (var mı, okunabilir mi, başka vault'la çakışıyor mu).
2. **Vault başına izole depolama.** Indeks DB'si `data/vaults/<id>/
   index.db`, study-artifacts ve ingest durumu aynı klasör altında.
   Global tek DB kalmaz.
3. **Sohbetlerin vault'a bağlanması.** Chat kaydına `vaultId` alanı;
   sohbet listeleme/oluşturma API'leri vault parametresi alır. Mevcut
   sohbetler migration ile "default" vault'a taşınır.
4. **Aktif vault bağlamı.** Server tarafında istek başına vault
   çözümlemesi (route param → registry lookup); ingest kuyruğu ve
   indeksleyici aktif vault'un path'i ve DB'siyle çalışır. Faz 5'in
   path-traversal koruması vault path'ine göre uygulanır.
5. **Scoped retrieval (backend ayağı).** Retrieval fonksiyonuna
   `includedPaths?: string[]` parametresi: sqlite-vec + FTS
   sorgularına path-prefix filtresi olarak iner. Chat metadata'sına
   `included_paths` yazılır/okunur. Boş sonuç durumu ayırt edilir
   ("kapsam dar" sinyali API cevabında döner). UI ayağı Faz 9'dadır.
6. **Migration betiği.** Mevcut tek-kütüphane kurulumu tek komutla
   "default vault"a dönüştürülür; eski path'ler bozulmaz.

## Bitti tanımı

- [x] İki vault oluşturulup ikisine ayrı kaynak ingest edilebiliyor;
      arama sonuçları vault'lar arasında sızmıyor (test: aynı soru iki
      vault'ta farklı kaynak döndürür). Canlı Ollama'ya karşı doğrulandı
      (bkz. `SESSION-LOG.md`, 2026-07-30): iki vault, ayrı domain'ler,
      `/api/domains?vault=` her ikisi için de yalnızca kendi domain'ini
      döndürdü; çapraz sorguda diğer vault'un içeriği hiç görünmedi.
- [x] `includedPaths` filtresiyle yapılan sorgu yalnızca o path'lerden
      chunk döndürüyor, `narrowScope` doğru ayırt ediyor (birim test,
      `select-chunks.test.ts`, 9/9 yeşil).
- [x] Migration sonrası eski sohbetler ve indeks "default" vault
      altında aynen çalışıyor. Gerçek verinin kopyası üzerinde doğrulandı:
      33 sohbet `vault_id='default'`e backfill oldu (SQLite'ın
      `ALTER TABLE ... ADD COLUMN ... DEFAULT` semantiği), migration
      ikinci koşuda no-op.
- [x] Faz 6 provider katmanı ve Faz 5 ingest kuyruğu değişiklikten
      etkilenmeden çalışıyor (regresyon) — `retrieve()`/`study-db.ts`/
      `library.ts` imzaları değişti ama davranışları aynı; generator'lar
      (`generate-quiz.ts` vb.) ve provider zinciri dokunulmadan geçti.

Bu fazda bulunup düzeltilen üç gerçek bug (detay `SESSION-LOG.md`'de):
(1) `readRegistry()`'nin catch dalı `{...EMPTY_REGISTRY}` ile paylaşılan
tek bir `vaults: []` dizisini spread'liyordu — `createVault`'ın
`reg.vaults.push()`'u bu paylaşılan diziyi kalıcı olarak mutasyona
uğratıp sonraki her "kayıt yok" okumasına sızdırıyordu; birim testle
yakalandı, taze dizi döndürerek düzeltildi. (2) Migration betiği ilk
yazımda `VAULT_PATH`'i `LIBRARY_PATH` ile eşdeğer bir taşıma kaynağı
sayıyordu — ama `VAULT_PATH` Faz 5 öncesi mimaride kullanıcının CANLI
Obsidian vault'unu yerinde gösteren bir işaretçi (hiç kopyalanmaz),
`LIBRARY_PATH` ise app'e ait, taşınması güvenli bir klasör; bu ayrım
gözden kaçırılsaydı migration kullanıcının gerçek kişisel vault'unu
app'in veri klasörüne taşımaya çalışırdı. Gerçek `.env`'i okurken fark
edildi, düzeltildi: yalnızca `LIBRARY_PATH` taşınır, `VAULT_PATH` asla.
(3) `deleteVault()` dosyaları silmeden önce registry'yi yazıyordu ve
`retrieve.ts`/`study-db.ts`'in vault başına önbelleklediği açık
better-sqlite3 bağlantılarını hiç kapatmıyordu — Windows açık handle'lı
bir dosyayı silmeyi reddediyor (EBUSY), bu da registry'den silinmiş ama
diskte öksüz kalan bir vault'a yol açıyordu. Canlı sunucuya karşı
yakalandı (sorgulanmış bir vault silinince tekrar üretildi); iki modüle
`closeVaultIndexDb`/`closeVaultStudyDb` eklendi, DELETE route'u bunları
`deleteVault`'tan önce çağıracak şekilde düzeltildi, `deleteVault`
dosyaları ÖNCE silip registry'yi SONRA yazacak şekilde yeniden
sıralandı (bir hata artık yarım kalmış durum değil, yeniden denenebilir
durum bırakıyor).

**Faz 8 tamamlandı.**

---

# Faz 9 — Frontend Revizyonu (shadcn-svelte)

Skill: `skills/frontend-revamp/SKILL.md`

## Plan-önce kuralı (bu skill'in ilk maddesi)

Koda dokunmadan önce model `docs/UI-PLAN.md` üretir: route haritası,
ekran başına bölge krokisi (ASCII wireframe yeterli), komponent
envanteri (hangileri shadcn'den kopyalanacak, hangileri özel),
taşınma sırası. Kullanıcı bu planı ONAYLAMADAN implementasyon
başlamaz. Kullanıcının tasarım dokümanı (`docs/ui-style-notes.md`
olarak repoya eklenecek) planın girdisidir.

## Teknoloji kararları (yeniden tartışılmaz)

- shadcn-svelte (bits-ui) + Tailwind v4, ikonlar lucide-svelte.
- Komponentler kopyalanır ve minimum modifiye edilir; özelleştirme
  tema token'larında ve sarmalayıcı komponentlerde yapılır.
- Skeleton/Flowbite gibi ikinci bir komponent framework'ü EKLENMEZ.

## Taşınma stratejisi (üç adım)

1. **Token köprüsü.** Mevcut `--bg`/`--accent` değişkenleri shadcn'in
   `--background`/`--primary` şemasına rename edilir (mekanik
   find-replace). Görsel çıktı bu adımın sonunda birebir aynıdır;
   koyu/açık tema `.dark` sınıfı deseniyle aynen çalışır.
2. **Tailwind v4 kurulumu.** CSS-first config, `@theme` bloğunda token
   tanıtımı. Kural: yeni ve elden geçen komponentler Tailwind+shadcn,
   dokunulmayan komponentler eski scoped CSS'iyle kalır — zorla toplu
   çevirme YOK. Preflight sonrası tam görsel tur atılıp bozulan
   margin/reset'ler düzeltilir.
3. **Kademeli taşınma.** Sıra: ayarlar ekranı (Faz 6 provider UI'ı
   doğrudan shadcn ile) → dialog/dropdown/tooltip primitifleri →
   chat transkripti. Chat balonu, kaynak çipi, ThinkingPanel özel
   komponent kalır; altlarında shadcn primitifleri kullanılır.

- **Adım 1-4 tamamlandı** (bkz. `SESSION-LOG.md`, 2026-07-30 —
  `docs/FAZ9-ADIM-1-4.md`, kullanıcı onaylı alt kapsam): token köprüsü,
  Tailwind v4 + shadcn-svelte kurulumu (preflight regresyonu
  `.markdown-body` kural setiyle kapatıldı), `/settings` altındaki 5
  sayfanın tamamı shadcn ile yeniden yazıldı, beş üretim diyaloğu tek
  `GenerationDialog`'a indi.
- **Adım 5 tamamlandı** (bkz. `SESSION-LOG.md`, 2026-07-31): vault
  seçici (`/`, otomatik yönlendirme + `?picker=1` bypass), sohbet listesi
  (`/vault/[id]`), ana ekran `/chat/[id]`'den `/vault/[id]/chat/[chatId]`'a
  taşındı, eski bookmark'lar 308 ile yönlendiriliyor. Chat/GenerationDialog
  artık Faz 8'in `vault`/`includedPaths` API alanlarını gerçekten
  kullanıyor (o zamana kadar yazılmış ama hiç çağrılmamışlardı).
- **Adım 6 tamamlandı** (bkz. `SESSION-LOG.md`, 2026-07-31): kaynak ağacı
  (`SourceTree`/`SourceTreeNode`, tri-state, saf mantık `sourceTree.ts`'te
  10 birim testiyle), kapsam göstergesi (`ScopeIndicator` + "kapsamı
  genişlet?" önerisi), hafif `StudyPanel` (kullanıcı onaylı sadeleştirme —
  yalnızca kart bekleme sayacı + üretim kısayolları), `SourceChip`
  (`SourceList`'in yerini aldı, path bazında dedup). `ConfidenceBadge`
  ([LOW]/[HIGH] etiket ayrıştırma) **bilinçli olarak yapılmadı** —
  `prompt.ts` modele bu etiketleri hiç ürettirmiyor, üreticisi olmayan bir
  ayrıştırıcı ölü kod olurdu.
- **Adım 7 tamamlandı** (bkz. `SESSION-LOG.md`, 2026-07-31): doğrulama
  geçişi — Türkçe karakter render'ı gerçek Ollama çıktısıyla ve
  `chats.db`'deki kalıcı satırla yeniden teyit edildi (regresyon yok),
  çok-chunk'lı gerçek bir kaynakta `SourceChip`'in dedup'ı doğrulandı.
- **shadcn-svelte CLI bu ortamda interaktif** (`init` hiçbir flag
  kombinasyonuyla atlanamadı) — `components.json`/`src/lib/utils.ts`
  elle yazıldı, sonrasında `add` komutu `printf "y\n" | npx
  shadcn-svelte@latest add <bileşenler>` ile sorunsuz çalıştı. Gelecek
  bileşen eklemelerinde aynı yol izlenmeli.

## Route haritası

- `/` → vault seçici: kart grid'i + "yeni vault" kartı. Tek vault
  varsa veya "son vault'u hatırla" açıksa otomatik yönlendirme;
  seçiciye header'daki vault adından dönülür. (Ayrı karşılama/giriş
  sayfası YOK — logo/animasyon bu sayfanın başlığıdır, Tauri sonrası
  süslenebilir.)
- `/vault/[id]` → o vault'un sohbet listesi.
- `/vault/[id]/chat/[chatId]` → ana ekran (aşağıda).
- `/settings` → vault-üstü ayarlar (provider'lar, anahtarlar).

## Ana ekran düzeni

- **Orta:** sohbet, ortalanmış sütun (max-width, okunabilirlik).
- **Sol üst:** kaynak ağacı. Tri-state checkbox'lar (parent:
  hepsi/bazıları/hiçbiri); seçim sohbet başına kalıcıdır
  (`included_paths` — Faz 8'deki backend'e bağlanır). Varsayılan:
  hepsi dahil. Transkript üstünde "n/m kaynak aktif" göstergesi.
  Retrieval boş dönerse "seçili kaynaklarda bulunamadı — kapsamı
  genişlet?" önerisi gösterilir.
- **Sol alt:** tek avatar butonu → DropdownMenu (profil, ayarlar,
  export). Üç ayrı ikon değil.
- **Sağ üst:** study araçları (test, kartlar, mindmap) — ikonlu
  butonlar. Ayrı sayfa DEĞİL, sağdan açılan panel (Sheet/Resizable):
  sohbet görünür kalır, panelde "tam ekrana genişlet" düğmesi olur.
- ~~Mindmap yeni üreticidir~~ — **geçersiz, düzeltildi (2026-07-30).**
  Mindmap Faz 7'de zaten yazıldı: retrieval-driven (per-topic, per-note
  değil), markmap ile render ediliyor (`generate-mindmap.ts`,
  `mindmap-tree.ts`, `study/mindmap/[id]`). Bu fazda değiştirilmiyor.

## Görsel bug'lar

- ~~Kullanıcı mesajlarında Türkçe karakter bozulması~~ — **yeniden
  üretilemedi (2026-07-30, 2026-07-31'de ikinci kez teyit edildi).**
  Gerçek `chats.db`'de mojibake işareti (`Ä/Å/Ã`) 0 satır; Türkçe içerik
  sorunsuz saklanıyor. Somut bir repro gelmeden ayrı iş açılmayacak.
- ~~`[LOW]` benzeri güven etiketlerinin ham metin olarak sızması~~ —
  **inşa edilmedi, kapsam dışı bırakıldı (2026-07-31).** `prompt.ts`
  modelden hiçbir zaman böyle bir etiket üretmesini istemiyor
  (grep ile doğrulandı) — üreticisi olmayan bir formatı ayrıştıran bir
  bileşen hiç tetiklenmeyecek ölü kod olurdu. Gerçek bir özellik olması
  isteniyorsa önce `prompt.ts`'e bir talimat eklenmesi gerekir; bu ayrı
  bir karar/iş.
- ~~Kaynak çiplerinde chunk bazlı tekrar~~ — **kapatıldı (2026-07-31).**
  `SourceChip.svelte`, `source_path` bazında dedup + "×n bölüm" sayacı +
  hover önizleme. Gerçek çok-chunk'lı bir kaynakla doğrulandı.

## Bitti tanımı

- [x] UI-PLAN.md onaylandı, uygulama plana uygun (kullanıcı onaylı
      sadeleştirmelerle: hafif study panel, "son vault" = mevcut
      `activeVaultId`, ConfidenceBadge kapsam dışı).
- [x] Vault seçici → sohbet → study paneli akışı uçtan uca çalışıyor
      (canlı doğrulandı, bkz. `SESSION-LOG.md`).
- [x] Checkbox kapsamı retrieval'ı gerçekten filtreliyor (canlı Ollama'ya
      karşı doğrulandı: kapsamsız/daraltılmış/boş seçim üç farklı gerçek
      sonuç kümesi döndürdü).
- [x] Koyu/açık tema tüm yeni komponentlerde tutarlı (shadcn token'ları
      üzerinden, Adım 1'in token köprüsüyle aynı mekanizma).
- [x] Üç görsel bug kapandı (biri hiç üretilemedi, biri kapsam dışı
      bırakıldı gerekçesiyle, biri gerçekten düzeltildi — yukarıda).
- [x] Eski scoped-CSS sayfaları görsel regresyona uğramadı (Adım 1-4'te
      doğrulandı, Adım 5-7 onlara dokunmadı).

**Faz 9 tamamlandı.**

---

# Faz 10 — MCP Sunucusu (agent erişim katmanı)

Skill: `skills/mcp-server/SKILL.md`

## Amaç

Uygulamayı iki yüzlü hale getirmek: insanlar SvelteKit arayüzünü,
agent'lar (Claude Code/Desktop ve diğer MCP istemcileri) aynı beyni
MCP üzerinden kullanır. Proje open source olarak "yerel NotebookLM
alternatifi + agent'ının kalıcı bilgi tabanı" önerisiyle yayınlanır.

## Mimari kararlar — güncellendi, orijinal iki varsayım geçersiz kılındı (2026-07-31)

Bu fazın kendi planlaması iki gerçek varsayım hatası içeriyordu, ikisi de
uygulamaya başlamadan önce koda karşı doğrulanıp düzeltildi (bkz.
`SESSION-LOG.md` ve `skills/mcp-server/SKILL.md`):

1. ~~**Monorepo'ya geçilir: `packages/core` çıkarma bu fazın ilk ve en
   büyük adımıdır.**~~ **İptal edildi.** Taşınabilirlik varsayılandan çok
   ucuz çıktı: MCP yolundaki tek çalışma-zamanı SvelteKit bağımlılığı
   `ollama.ts`'in tek bir `$env/dynamic/private` import'uydu. Buna
   karşılık monorepo, Faz 7'de belgelenmiş paketleme mayınlarını
   (`stage-server.mjs`'in `npm ci`'ı, `tauri.conf.json`'un
   `"../dist-server"` + `lib.rs`'in hardcoded `_up_` segmenti —
   klasör derinliği değişince SESSİZCE bozulan bir bağ) yeniden
   tetikliyordu. Karar: `mcp/`, `indexer/` ile birebir aynı deseni
   izleyen bir kardeş klasör; `src-tauri/`, `scripts/`, `svelte.config.js`
   fazın hiçbir adımında dokunulmadı.
2. ~~**`generate_quiz`/`generate_flashcards` tool listesinde.**~~
   **v2'ye ertelendi.** Aynı bölümün "mcp-server DB'leri salt-okur
   açar" sözüyle doğrudan çelişiyordu (üreticiler study.db'yi
   read-write açıp `CREATE TABLE IF NOT EXISTS` çalıştırıyor) ve
   `providers/ollama.ts`'in tek-model-RAM disiplini (`sharedJobMutex`)
   süreç-içi olduğu için ikinci bir süreçten çağrılmaları gerçek bir
   yarış koşuluydu. Erteleme şartları `skills/mcp-server/SKILL.md`'de.

Kalıcı kararlar:

- **Yerel-öncelik; remote sunucu YOK.** Birincil taşıma stdio
  (Claude Desktop/Code config'ine tek satır); opsiyonel localhost HTTP
  v1'de hiç yok (Faz 10.5'e).
- **SQLite eşzamanlılığı:** WAL modu zorunlu; mcp-server hiçbir DB'ye
  yazmıyor — çağrı başına `withVault()`'un serileştirme + handle-kapatma
  deseniyle (`mcp/vault-scope.ts`).
- Model çağrısı gerektiren tool yok v1'de (üreticiler ertelendi) —
  provider katmanına hiç bağımlılık yok, bilinçli.
- Tool'lar vault-farkındadır: `vault` parametresi alır (opsiyonel,
  yoksa aktif vault) veya `list_vaults` ile keşif yapılır.

## Tool yüzeyi — v1 tamamlandı (salt-okunur 4 araç)

- `list_vaults()` → registry envanteri + indeksleme durumu +
  domain/level özeti.
- `search_library(vault?, query, domain?, level?, k?)` → **vektör-only**
  arama (roadmap'in orijinal "hibrit arama" ifadesi düzeltildi — index
  şemasında hiç FTS tablosu yok, hibrit Faz 10.5'e).
- `get_note(vault?, path)` → not içeriği + frontmatter, path-traversal
  koruması Faz 5 deseniyle (artık ayrı, test edilebilir bir modülde:
  `library-read.ts`).
- `list_sources(vault?, domain?, level?, limit?, offset?)` → kaynak
  envanteri, indeks DB'sinden (fs yürüyüşü değil).
- `generate_quiz`/`generate_flashcards` → **v2'ye ertelendi**, yukarıya
  bkz.

## Bitti tanımı

- [x] Claude Code, stdio config ile bağlanıp iki farklı vault'ta arama
      yapabiliyor; sonuçlar vault'lar arasında sızmıyor. Canlı doğrulandı
      (bkz. `SESSION-LOG.md`): iki gerçek indekslenmiş vault + gerçek
      Ollama, aynı sorgu her ikisinde de yalnızca kendi vault'unun
      içeriğini döndürdü; `claude mcp add` ile gerçek Claude Code CLI'a
      eklendi, `claude mcp list`/`get` "✔ Connected" gösterdi (gerçek
      alt süreç spawn + MCP handshake).
- [x] UI kapalıyken mcp-server tek başına çalışıyor — hiçbir aracı
      SvelteKit sürecine veya provider katmanına bağımlı değil.
- [x] App/indexer yazarken mcp-server eşzamanlı okuyabiliyor (WAL
      testi): indeksleyici bir vault'a 5 dosya yazarken 8 art arda
      `search_library` çağrısı 0 hatayla tamamlandı. mcp-server hiçbir
      yazma yapamıyor — `study-db.ts`'e hiç dokunulmuyor, `index.db`/
      `chats.db`'ye hiç yazılmıyor (yalnızca `mcp-log.jsonl`).
- [ ] `npx` ile temiz makinede tek komutla ayağa kalkıyor — **Faz 10.5'e
      ertelendi**, bilinçli: v1'de build adımı/`bin` girdisi yok,
      `npm run mcp:config`/`claude mcp add` ile yerel kurulum yeterli.
- [ ] README + örnek vault + config bloğu tamam — **Faz 10.5'e
      ertelendi** (açık kaynak hazırlığı bu fazın kapsamından ayrıldı,
      kullanıcı onaylı). `KURULUM-REHBERI.md`'ye MCP kurulum bölümü
      (2026-09-23'te eklendi — dosya adı burada da düzeltildi, dosya hiç
      `KURULUM.md` olarak var olmadı) ve
      `mcp/claude-config.example.json` bu faz kapsamında eklendi;
      LICENSE/README(TR+EN)/`examples/library/`/CHANGELOG değil.

Ayrıca doğrulanan, DoD'de olmayan ama gerçek risk noktalarıydı: rastgele
cwd + minimal env'den doğru vault'ları bulma (Claude Desktop'ın gerçek
spawn şeklini taklit eder); stdout'un yalnızca JSON-RPC taşıdığı (guard
devre dışı bırakılıp bir `console.log` probe'uyla önce BOZULDUĞU,
sonra guard geri açılınca düzeldiği kanıtlandı); tamamlanmış bir çağrıdan
sonra hiçbir SQLite handle tutulmadığı (Faz 8'in EBUSY bug'ının doğrudan
regresyon kontrolü — sunucu ayaktayken `index.db` PowerShell'den
yeniden adlandırıldı, başarılı).

**Faz 10 (v1, salt-okunur) tamamlandı.**

---

## Faz 10.5 — Açık kaynak hazırlığı + üretici araçlar (planlanmadı, notlanıyor)

Faz 10'dan kullanıcı onayıyla ayrıldı — kapsamı netleşmemiş kararlar
içeriyor (gerçekten yayınlanacak mı, hangi lisans) ve gerçek bir dağıtım
hikayesi (`npx`, `bin` girdisi, native modül sorunu — `tsx` bugün
devDependency) gerektiriyor. Planlanmadı, yalnızca kapsam listesi:

- LICENSE (MIT önerilir), README (TR+EN) — ekran görüntüleri Faz 9
  sonrası UI'dan alınır.
- `examples/library/` altında 3-5 dosyalık sahte örnek vault (kişisel
  içerik repoya asla girmez).
- `npx` ile tek komut kurulum — `bin` girdisi + gerçek bir build adımı
  gerektirir (`mcp/`'in bugünkü tsx-üzerinden-çalışma modeli devDependency
  varsayımına dayanıyor).
- CHANGELOG; README'de "issue'lara best-effort bakılır" beklentisi.
- `generate_quiz`/`generate_flashcards` — şartlar
  `skills/mcp-server/SKILL.md`'nin "Üretici araçların erteleme şartları"
  bölümünde: zorunlu açık `model` parametresi, süreçler arası dosya
  tabanlı kilit, study.db'nin yalnızca üretim çağrısı süresince
  read-write açılıp hemen kapatılması.
- Opsiyonel localhost HTTP transport (varsayılan kapalı).
- FTS5/hibrit arama — şema değişikliği + tam reindex gerektirir.
- Paketlenmiş Tauri uygulamasında MCP desteği (bugün yalnızca tarayıcı
  akışının `data/`'sını okuyor; masaüstünün `%APPDATA%` verisi ayrı).

---

## Sıralama gerekçesi

8 → 9 → 10 sırası zorunludur: (9), (8)'in vault seçici ve scoped
retrieval API'lerine kurulur; (10)'un araç yüzeyi (8)'in vault registry
API'leri oturmadan yazılırsa iki kez yazılır. (Not: (10)'un orijinal
"önce core çıkar, monorepo'ya geç" adımı iptal edildi — bkz. Faz 10'un
kendi "Mimari kararlar" bölümü — ama sıralama gerekçesi aynı kaldı:
vault registry'nin API şekli önce oturmalıydı.) Açık kaynak vitrini artık
Faz 10.5, (9)'un bitmiş UI'ına ihtiyaç duyar.

---

## Faz 11 — Backend sertleştirme (hata görünürlüğü + eşzamanlılık sözleşmesi)

Faz 10 sonrası yapılan bir denetim 15 bulgu çıkardı (bkz. `SESSION-LOG.md`).
Yeni özellik değil — iki tema kapatıldı: init hatalarının sessizce
yutulması, ve "32GB'a tek büyük model" disiplininin yalnızca chat/swap
senaryosu düşünülerek yazılmış olması (title üretimi ve embed() dışarıda
kalmıştı). Yalnızca backend; frontend/build-tooling bulguları (`#8`,
stage-server'ın her build'de `npm ci` çalıştırması) sonraki bir oturuma
bırakıldı.

- **Bucket A — Hata görünürlüğü:** `api/chat/+server.ts`'in DB çağrıları
  artık `try` içinde; bir `chats.db` hatası artık client'a `error` event'i
  olarak ulaşıyor, sessizce kopan stream yok. Erken hatada kalıcı boş
  assistant satırı yazılmıyor. Yeni `app-log.ts` (`mcp/log.ts`'in aynı
  deseni) — chat/fallback/title/db hataları artık `data/app-log.jsonl`'e
  kalıcı yazılıyor.
- **Bucket B0 — Ollama'ya tek kapı:** yeni `ollama-gate.ts` — chat, embed,
  başlık üretimi artık tek bir ref-count'lu lease üzerinden Ollama RAM'ine
  dokunuyor. Mutex artık yalnızca takas kararını değil, kiranın tamamını
  (tüm stream'i) kapsıyor; unload kararı `/api/ps` (`reconcile()`) ile
  doğrulanmadan verilmiyor; `embed()` artık nomic-embed-text'i "resident"
  deklare ederek disiplinin parçası. Başlık üretimindeki gizli model takası
  (hardcoded `qwen3:8b`) kaldırıldı.
- **Bucket C — Veri/config dayanıklılığı:** `study-db.ts`'ye `chats-db.ts`
  ile aynı ALTER-guard altyapısı (`ensureColumns()`); üç DB'nin `getDb()`'si
  artık init hatasında handle sızdırmıyor. Paketlenmiş Tauri'de
  `providers.json` artık `app_data_dir`'e yazıyor (önceden Program Files
  altına düşebiliyordu). `DATA_DIR` artık chats.db/skills/providers/secrets'ın
  hepsini aynı kökten çözüyor. Küçükler: rename çakışma kontrolü,
  `PYTHON_BIN`'in codepage-güvenli + tembel çözümü.
- **Bucket D:** SM-2 ease artık iki yönlü (`hard` −0.15, `easy` +0.15,
  tavan 3.0) — eskiden yalnızca düşüyordu, mistap'lanan bir kart bir daha
  asla toparlanamıyordu. `study-artifacts` skill spec'i güncellendi.

## Bitti tanımı

- [x] `npm test`: 81/81 yeşil (3 yeni test dosyası: `library.test.ts`,
      `sqlite-schema.test.ts`, `ollama-gate.test.ts`).
- [x] `svelte-check`: 0 hata, her bucket sonrası doğrulandı.
- [x] `cargo check` (`src-tauri`): 0 hata.
- [x] `ollama-gate.test.ts`: aynı model paralel akıyor (mutex'e hiç
      dokunmadan), farklı model yalnızca öncekinin refcount'ı sıfırlanınca
      işleniyor, resident model asla unload/takas tetiklemiyor,
      `reconcile()` resident göstermezse unload atlanıyor — dördü de testli.
- [ ] Paketlenmiş Tauri'de provider aç/kapa denemesi — kod tarafı C2'de
      düzeltildi (seed-if-missing + `app_data_dir`), ama gerçek bir
      `desktop:build` + kurulu uygulama üzerinde henüz canlı doğrulanmadı.
- [ ] Manuel senaryolar (plan dosyasının "Doğrulama" bölümü: `ollama ps`
      ile iki-sekme/başlık-takası gözlemi, `chats.db` bozma testi) henüz
      gerçek Ollama'ya karşı koşulmadı — kod tarafı testli ama canlı
      gözlem bekliyor.

**Faz 11 tamamlandı (kod + otomatik doğrulama); canlı manuel doğrulama
kullanıcıya bırakıldı.**

## Faz 11.5 — Masaüstü tanılama boşlukları ve build tuzağı

Bir sonraki oturumda paketlenmiş (`tauri build`) uygulamada "vault
değiştirince internal error" ve "Ollama bulunamıyor, retry hiç
düzelmiyor" bug'ları kovalanırken bulundu. İkisi de düzeltildi ve
paketlenmiş binary üzerinde canlı doğrulandı — ama düzeltme sürecinde
aynı binary'yi teşhis etmeyi bizzat imkânsızlaştıran bir dizi ayrı,
gerçek boşluk ortaya çıktı. Bu faz o boşlukları kapatıyor; yeni özellik
değil, Faz 11'in "hata görünürlüğü" temasının doğrudan devamı.

**Kritik ders — build tuzağı:** teşhis sürecinde iki kez düz
`cargo build --release` ile üretim binary'si, Tauri'nin `devUrl`'e
(`127.0.0.1:5173`, Vite dev sunucusu) bakan bir dev-mode binary ile
sessizce ezildi. Sonuç: pencere `ERR_CONNECTION_REFUSED` gösteriyor,
`node.exe` hiç açılmıyor (splash hiç yüklenmediği için
`check_and_start` tetiklenmiyor), `launch.log` tamamen boş kalıyor —
gerçek bir uygulama hatasıyla neredeyse ayırt edilemez bir semptom seti.
**Kural:** kullanıcının çalıştıracağı hiçbir binary artık düz
`cargo build`/`cargo build --release` ile üretilmeyecek; daima
`npm run desktop:build` (`tauri build`). `cargo check`/`cargo build`
yalnızca derleme hatası taraması için kullanılabilir, asla dağıtım için.

- **Sessiz erken dönüşler:** `spawn_sidecar()`'da `log_line` çağırmayan
  5 erken `?` dönüşü var (`resource_dir()?`, `app_data_dir()?`,
  `create_dir_all()?`, `get_free_port()?`, ve `check_and_start`'taki
  `read_config()?`). Bugün `launch.log`'un yokluğu "tam başarı" ile "5
  farklı sessiz hata"dan biri arasında ayrım yapamıyor — teşhis
  edilemezliğin asıl sebeplerinden biri buydu. Hepsi loglamalı.
- **`uncaughtException` handler'ı kendi kendini köreltiyor:**
  `hooks.server.ts`'teki yeni handler doğrudan `logAppEvent`'e gidiyor;
  Node'un varsayılan davranışı (stderr'a tam stack yazıp çıkmak)
  bastırılmış oluyor. Rust tarafındaki stdio drain thread'leri artık bu
  çıktıyı hiç göremiyor — Faz 11'in "hatalar görünür olsun" amacının tam
  tersi bir yan etki. Düzeltme: `logAppEvent`'ten önce `process.stderr`'a
  da yaz.
- **Job handle üzerine yazım riski:** `spawn_sidecar()`'ın sonunda
  `*state.job.lock().unwrap() = job;` önceki `Job`'ı (varsa)
  `KILL_ON_JOB_CLOSE` ile birlikte düşürüyor — kernel önceki sidecar'ı
  sessizce sonlandırabilir. İkinci bir `spawn_sidecar` çağrısına karşı
  guard yok (tek-instance kontrolü de yok).
- **`get_free_port()` TOCTOU:** port 0'a bind edip hemen `drop`lamak ile
  Node'un gerçekten o portu bağlaması arasında saniyeler sürebilen bir
  pencere var (better-sqlite3 native modül yükü + `runVaultMigrationIfNeeded()`
  dahil). `http_probe_ok()` bu turda eklendi (çıplak TCP connect yerine
  gerçek `GET / HTTP/1.1` + `HTTP/` prefix kontrolü) ve yarışı pratikte
  kapatıyor, ama tam çözüm `PORT=0` verip `index.js`'in kendi
  `Listening on ...` satırını drain thread'den parse etmek — hem
  TOCTOU'yu sıfırlar hem `http_probe_ok`'un zayıf noktasını (yalnızca
  5 byte'lık prefix kontrolü, yanlış bir HTTP sunucusunu da kabul
  edebilir) gerçek canlılık kanıtına yükseltir.
- **Küçükler:** `Command::new("where")` (node binary arama) hâlâ
  `CREATE_NO_WINDOW` almıyor — her açılışta kısa bir konsol parlaması;
  `stderr_tail` (`Arc<Mutex<String>>`) sınırsız büyüyor, yalnızca timeout
  dalında okunuyor, boyut sınırı yok.

## Bitti tanımı

- [x] Vault değiştirme "Internal Error"ı düzeltildi: `setActiveVault`/
      `touchVault` artık `/vault/[id]` ve `/vault/[id]/chat/[chatId]`
      `load()`'larında try/catch içinde, best-effort, `logAppEvent`'e
      yazıyor, asla sayfa yüklemesini bloklamıyor.
- [x] Ollama retry ırkı düzeltildi: `OllamaStatusBanner.svelte`'e
      request-generation guard eklendi (dört bağımsız tetikleyiciden —
      mount, visibilitychange, 15sn poll, manuel buton — eski bir
      cevabın yeni bir başarıyı ezmesi artık imkânsız); `health()`'e
      diğer tüm sağlayıcı çağrılarıyla tutarlı `AbortSignal.timeout`
      eklendi.
- [x] Konsol penceresi bug'ı düzeltildi: sidecar spawn'ında
      `CREATE_NO_WINDOW` (node.exe artık görünür bir terminal açmıyor).
- [x] `http_probe_ok()` — çıplak TCP connect yerine gerçek HTTP
      round-trip; sidecar stdout/stderr artık sadece 15sn açılış
      penceresinde değil, sürecin tüm ömrü boyunca `launch.log`'a
      akıtılıyor.
- [x] Paketlenmiş build üzerinde canlı doğrulandı (doğru
      `npm run desktop:build` ile) — `launch.log` gerçek
      `Listening on http://127.0.0.1:...` satırını gösterdi, uygulama
      hatasız açıldı.
- [x] Sessiz erken dönüşler kapatıldı: `config_path()`, `read_config()`,
      `resource_dir()`, `app_data_dir()`/`create_dir_all()` artık hepsi
      `log_line` ile loglayıp propagate ediyor.
- [x] `hooks.server.ts`'in `uncaughtException`/`unhandledRejection`
      handler'ları artık `logAppEvent`'ten önce `process.stderr.write()`
      yapıyor — Rust'ın drain thread'leri fatal crash'i görebiliyor.
- [x] Job üzerine yazım riski kapatıldı: `spawn_sidecar` artık başında
      `state.child`'ı kontrol ediyor, hâlâ çalışan bir sidecar varsa
      (`try_wait() == Ok(None)`) yeni bir process spawn etmek yerine
      kayıtlı URL'i döndürüyor — ikinci çağrı artık ilk sidecar'ı
      kernel'e sessizce öldürtemiyor.
- [x] `get_free_port()` TOCTOU tamamen kapatıldı: `PORT=0` ile Node
      kendi boş portunu atomik biçimde bağlıyor, `parse_listening_port()`
      stdout drain thread'inden gerçek `Listening on ...` satırını
      okuyor; `wait_for_sidecar_ready()` bunu `http_probe_ok` ile
      birleştirip hem port bilgisini hem canlılık kanıtını tek noktada
      topluyor.
- [x] `Command::new("where")` artık `CREATE_NO_WINDOW` alıyor;
      `stderr_tail` 8KB'a sınırlandı (yalnızca timeout dalının satır içi
      hata mesajı için tutuluyor, sınırsız büyümüyor).
- [x] `cargo check`: 0 hata. `npm test`: 83/83 yeşil. `svelte-check`:
      0 hata. Paketlenmiş `npm run desktop:build` üzerinde canlı
      doğrulandı — `PORT=0` yolu gerçek bir portu (`56308`) doğru
      şekilde yakaladı, uygulama hatasız açıldı.

**Faz 11.5 tamamlandı.**

## Faz 12 — Üretici kapsam sözleşmesi

Beş üreticinin (`generate-quiz.ts:173`, `generate-cards.ts:168`,
`generate-report.ts:141`, `generate-mindmap.ts:142`,
`generate-slides.ts:155`) hepsi `retrieve(v, query, { domains, k: 12 })`
çağırıyor — sohbetin sol tarafındaki kaynak ağacı seçimi
(`includedPaths`) hiç geçmiyor. Kullanıcı dar bir kapsam seçse bile
üretim daima tüm vault'ta arıyor; konu o dar kapsamın dışında kalırsa
"Bu kapsamda kütüphanede yeterli kaynak yok" hatası dar kapsam yüzünden
değil, hiç uygulanmamış bir filtre yüzünden çıkıyor. Karar: üreticiler
sohbet kapsamını kullanacak.

- `includedPaths`'i beş istek tipine ekle (`QuizGenerationRequest`,
  `CardGenerationRequest`, `ReportGenerationRequest`,
  `MindMapGenerationRequest`, `SlidesGenerationRequest`) ve
  `retrieve()` çağrılarına geçir.
- `select-chunks.ts`'in SCOPED overfetch çarpanı (10×, ≥k*10) böylece
  üreticilerde de gerçekten devreye girer — bugün hiç tetiklenmiyor
  çünkü `includedPaths` üreticilere hiç ulaşmıyor.
- `narrowScope` ayrımını üretici hata mesajlarına taşı: "kaynak yok" ile
  "kapsam dar" farklı önerilere (ör. "kapsamı genişlet" CTA'sı) yol
  açmalı, bugünkü tek düz hata mesajı yerine.

### Uygulama

`includedPaths` beş istek tipine eklendi ve `retrieve()` çağrılarına
geçirildi (SCOPED 10× çarpan artık gerçekten devreye giriyor). Yeni
paylaşılan `lib/server/generate-errors.ts`'in `NoSourcesError`'ı
`retrieve()`'in `narrowScope`'unu taşıyor; beş üretici de artık
`chunks.length === 0` olduğunda düz `Error` yerine bunu fırlatıyor, beş
API route'u da `err instanceof NoSourcesError` ise SSE `error` event'ine
`narrowScope` ekliyor. İstemci tarafında: beş `*-generation.svelte.ts`
store'u `narrowScope`'u durumuna taşıyor;
`GenerationDialog.svelte`/beş dialog bileşeni `includedPaths`'i
`+page.svelte`'in zaten sahip olduğu sohbet kapsamından alıp
`onGenerate` üzerinden gövdeye kadar taşıyor. CTA için yeni
`lib/scope-expand.svelte.ts` — kök layout'taki hata toast'ının (sohbet
sayfasının kendi `includedPaths` state'ine erişimi yok, kardeş bileşen)
global bir "kapsamı genişlet" sinyali yayınlamasını, sohbet sayfasının
bunu dinleyip kendi seçimini temizlemesini sağlıyor (SourceTree'nin
`focusSignal`'ıyla aynı nonce-counter deseni). `GenerationStatusToast.svelte`
artık `narrowScope` true olduğunda "Kapsamı genişlet?" düğmesi gösteriyor,
`Message.svelte`'in chat'teki aynı CTA'sıyla birebir aynı ifade.

## Bitti tanımı

- [x] Dar kapsam seçiliyken üretilen quiz/kart/rapor/mindmap/slayt
      yalnızca o kapsamdaki kaynaklardan geliyor — `retrieve()` artık
      beş üreticide de `includedPaths`'i alıyor.
- [x] `narrowScope` true olduğunda üretici hata toast'ı "Kapsamı
      genişlet?" düğmesi gösteriyor (tıklanınca sohbetin kapsamını
      temizliyor), `false` olduğunda düz "kaynak yok" mesajı kalıyor.
- [x] `svelte-check`: 0 hata. `npm test`: 83/83 yeşil. `vite dev` altında
      `/vault/default` canlı render edildi, konsol/sunucu hatası yok —
      yeni prop zincirinin (dialog → GenerationDialog → onGenerate →
      body) hepsi derleniyor ve çalışıyor.
- [ ] Gerçek bir model çağrısıyla uçtan uca manuel doğrulama (dar kapsam
      seç → üretim tetikle → "Kapsamı genişlet?" düğmesine tıkla →
      kapsamın gerçekten temizlendiğini gözlemle) henüz yapılmadı —
      Ollama'ya karşı canlı bir üretim gerektiriyor, koda değil.

## Faz 13 — Üretilen materyal yaşam döngüsü

İki ayrı ama ilişkili boşluk: (1) üretilen materyaller `study-db.ts`'te
vault başına kalıcı duruyor ama `routes/api/study/` altında yalnızca
`[id]/+server.ts` (tekil GET) var — quizzes/reports/mindmaps/slidedecks
için koleksiyon seviyesinde `+server.ts` hiç yok, `StudyPanel.svelte`
kodu bu boşluğu kendi yorumunda zaten itiraf ediyor. (2) Beş üretim
state modülü (`quiz-generation.svelte.ts:22`,
`card-generation.svelte.ts:19`, `report-generation.svelte.ts:12`,
`mindmap-generation.svelte.ts:9`, `slides-generation.svelte.ts:9`)
tek bir `$state` singleton'ı — yeni bir üretim öncekinin `status`'ünü
eziyor, önceki başarılı üretimin "aç" CTA'sı kayboluyor.

- `GET /api/study/{quizzes,reports,mindmaps,slidedecks}` — vault'a göre
  listeleme (veri zaten `study-db.ts`'te; yalnızca endpoint eksik).
  Kartlar için zaten `due-count`/`queue` var, ayrı bir "tüm kartlar"
  listesi de eklenebilir.
- `StudyPanel.svelte`'e (veya eşdeğerine) üretilmiş materyal listesi —
  vault açıldığında geçmiş üretimler görünür ve tıklanabilir olsun.
- Beş singleton state modülünü **id'ye göre kayıt (Map/nesne)** hâline
  getir; aynı tipten birden fazla üretim üst üste istiflenebilsin.

### Uygulama

`study-db.ts`'e paylaşılan `StudyListRow` şekli + beş `list*()` fonksiyonu
eklendi (quizzes/decks/reports/mindmaps/slidedecks — kartlar da dahil
edildi, roadmap'in "eklenebilir" notuna karşılık; `slidedecks` için
`SELECT *` değil yalnızca hafif kolonlar seçiliyor, `rendered_html`/
`rendered_css` bir liste görünümüne hiç taşınmıyor). Beş yeni
`GET /api/study/{quizzes,reports,mindmaps,slidedecks,decks}` route'u
`vaultFromUrl` + `StudySummary` (yeni paylaşılan client tipi) ile aynı
deseni izliyor. `StudyPanel.svelte` artık dört tip için (kartlar hariç —
tek bir deck'e gidecek bir `/study/cards/[deckId]` route'u yok, panelin
zaten sahip olduğu due-count rozeti kartların kalıcı durum yüzeyi) son
üretilenlerin bir listesini gösteriyor, tıklanınca ilgili `/study/*/[id]`
sayfasına gidiyor.

Beş `*-generation.svelte.ts` store'u tek `status` slotundan `items:
Status[]` dizisine çevrildi — her giriş `crypto.randomUUID()` ile
üretilen kendi `id`'sini taşıyor, `'idle'` varyantı tamamen kalktı (boşta
olan bir üretim artık dizide hiç yok). Yeni paylaşılan
`lib/distributive-omit.ts` — düz `Omit<Union, K>` bir union'ı ortak
alanlara indirgeyip her varyantın kendi alanlarını (örn. `quizId` vs
`message`) sessizce siliyor; `DistributiveOmit` bunu düzeltiyor, beş
store'un `setStatus()` yardımcısında kullanılıyor. `+layout.svelte`
artık her store'un `items` dizisini `{#each}` ile geziyor;
`stackIndex` beş tip boyunca kümülatif taban değerleriyle hesaplanıyor
(`quizBase`/`cardBase`/...) — böylece aynı anda birden fazla toast farklı
tiplerden gelse de üst üste binmiyor. Beş dialog'un `alreadyGenerating`
kontrolü `items.some(s => s.phase === 'generating')`'e taşındı — aynı
tipten paralel üretim daha önce olduğu gibi hâlâ engelleniyor, değişen
tek şey bir üretim bitince/hata verince önceki durumunun artık
kaybolmaması.

## Bitti tanımı

- [x] Bir vault'ta üretilmiş her quiz/kart/rapor/mindmap/slayt, sayfa
      yeniden yüklendikten sonra bile listede görünüyor ve açılabiliyor —
      `StudyPanel.svelte`'in son-üretilenler listesi + dört yeni
      koleksiyon endpoint'i üzerinden canlı doğrulandı (`vite dev`
      altında gerçek eski quiz kayıtları `GET /api/study/quizzes`'ten
      döndü).
- [x] Aynı tipten iki ardışık üretim artık birbirinin state'ini
      ezmiyor — store'lar id'ye göre kayıt tutan bir diziye çevrildi,
      her girişin kendi toast'ı kendi `stackIndex`'inde kalıyor.
- [x] `svelte-check`: 0 hata. `npm test`: 83/83 yeşil. `vite dev` altında
      `/vault/default` ve beş yeni `/api/study/*` endpoint'i canlı
      render/yanıt verdi, konsol/sunucu hatası yok.
- [ ] Gerçek eşzamanlı üretim senaryosu (iki quiz'i art arda, birincisi
      bitmeden ikincisini başlatıp iki ayrı toast'ın aynı anda göründüğünü
      gözlemlemek) henüz canlı Ollama'ya karşı denenmedi — koda değil,
      gerçek bir üretim çalıştırmaya ihtiyaç duyuyor.

## Faz 14 — Uygulama içi kaynak görüntüleyici

`SourceChip.svelte` ve kart sayfası zaten iki bağlantı üretiyor:
Obsidian derin bağlantısı (ana, büyük) ve uygulama içi markdown
görüntüleyici `/library/view` (ikincil, küçük ikon;
`sourceLink.ts:17`'deki `libraryViewerUrl(path)`). Karar: uygulama içi
görüntüleyici ana bağlantı olsun, Obsidian ikincil ikon olarak kalsın —
PDF gibi Obsidian'da hiç var olmayan kaynaklar için de tutarlı çalışır.
Ayrıca gerçek bir bug: `libraryViewerUrl` vault parametresi geçmiyor;
`/api/library/file` `vaultFromUrl` ile aktif vault'a düşüyor, çoklu
vault'ta yanlış dosya okuma veya 404 riski taşıyor.

- `libraryViewerUrl(path, vaultId)` — vault parametresini ekle, ilgili
  route'ları güncelle.
- `SourceChip.svelte` ve kart sayfasında bağlantı hiyerarşisini çevir:
  uygulama içi görüntüleyici ana tıklama hedefi, Obsidian ikincil ikon.

### Uygulama

`libraryViewerUrl(path, vaultId)` artık `vaultId` zorunlu parametre.
Ama gerçek düzeltme bundan daha derine indi: `/study/quiz/[id]` gibi beş
sayfanın (quiz/report/mindmap/slides/cards) **hiçbiri kendi vault'unu
bilmiyordu** — hepsi örtük biçimde "aktif vault"a düşüyordu, tam da
`libraryViewerUrl`'in eski halinin yaptığı hata. Sadece `libraryViewerUrl`'i
düzeltip bu sayfalara doğru bir `vaultId` vermeden yapmak kozmetik
kalırdı, o yüzden zincir uçtan uca kuruldu:

- Beş `*-generation.svelte.ts` store'u artık `setStatus()` içinde
  `body.vault`'u da `vaultId` olarak her status girişine yazıyor —
  `+layout.svelte`'in toast'ları artık hangi vault'a ait olduğunu
  biliyor, `goto()` çağrıları yeni `studyUrl()` yardımcısıyla `?vault=`
  taşıyor.
- `StudyPanel.svelte` ve `CardsDialog.svelte` zaten sahip oldukları
  `vaultId` prop'unu artık navigasyon URL'lerine de ekliyor.
- Beş `/study/*/+page.ts` (cards için hiç yoktu, yeni eklendi) artık
  `url.searchParams.get('vault')`'u okuyup `data.vaultId` olarak
  taşıyor; beş `+page.svelte` kendi API çağrılarına `?vault=`/`body.vault`
  ekliyor. **Dikkat edilen incelik**: `data.vaultId` tanımsızken boş bir
  `vault=` param'ı eklemek `vaultFromUrl`'in `id ?? getActiveVaultId()`
  düşüşünü bozar (boş string null/undefined değildir) — her sayfa bunu
  koşullu bir `xQuery` derived'ıyla önlüyor.
- `/library/view/+page.svelte` kendi `?vault=` parametresini okuyup
  `/api/library/file`'a taşıyor (vault yoksa parametreyi hiç eklemiyor,
  eski davranış korunuyor).
- Bağlantı hiyerarşisi altı yerde çevrildi (`SourceChip.svelte` + beş
  study sayfası): uygulama içi görüntüleyici artık ana tıklama hedefi
  (okunabilir kaynak yolu metniyle), Obsidian yeni bir `ExternalLinkIcon`
  ile ikincil ikon oldu.
- Kapsam dışı bırakılan, bilinçli: `/settings/library`'nin kendi
  `LibraryTree.svelte`'i de aynı "aktif vault'a düşme" örüntüsünü
  taşıyor ama bu ayrı bir sayfa/özellik — dokunulmadı, davranışı
  değişmedi (regresyon yok, sadece iyileştirilmedi).

## Bitti tanımı

- [x] Çoklu vault açıkken bir kaynağa tıklamak her zaman doğru vault'un
      dosyasını açıyor — `/api/study/quizzes/<gerçek-id>?vault=default`
      ve `/api/library/file?path=...&vault=default` ikisi de canlı
      doğrulandı, gerçek quiz/kaynak verisi doğru vault'tan döndü.
- [x] Obsidian'da bulunmayan bir kaynağa tıklamak uygulama içi
      görüntüleyiciyi açıyor — bu zaten `libraryViewerUrl`'in tasarımı,
      artık ana bağlantı konumunda.
- [x] `svelte-check`: 0 hata. `npm test`: 83/83 yeşil. `vite dev` altında
      chat sayfası, `/study/quiz/[id]`, `/study/cards`, `/library/view`
      hepsi `?vault=` ile canlı test edildi, konsol/sunucu hatası yok.

## Faz 15 — Ollama model yönetimi

`OllamaAdapter`, `/api/tags` ile kurulu her modeli otomatik listeliyor
ve chat header'daki model seçici bunların hepsini gösteriyor — kurulu
herhangi bir model (qwen, llama, mistral, deepseek-r1, ...) bugün de
sorunsuz çalışıyor. Eksik olan yalnızca yönetim: `OllamaAdapter.pull()`
zaten yazılmış ama hiçbir ekran çağırmıyor (Faz 6'nın kendi notu "model
indirme yer tutucu, işlev sonraya" diyordu, o işlev hâlâ eklenmedi).

- Ayarlarda model ekranı: kurulu modelleri listele, `pull()` ile indir
  (ilerleme göstergesiyle), sil.
- Hızlı model / muhakeme modeli atama arayüzü.

## Bitti tanımı

- [x] Kullanıcı ayarlardan yeni bir model indirebiliyor, ilerlemeyi
      görebiliyor, tamamlanınca model seçicide beliriyor.
- [x] Hızlı ve muhakeme modeli atamaları ayarlardan değiştirilebiliyor
      ve chat/üreticiler bu atamayı kullanıyor.

### Uygulama

`OllamaAdapter.delete()` eklendi (native `/api/delete`). `/api/models`
artık üç yöntem taşıyor: `GET` (kurulu modeller, mevcut), `POST` (model
indir — `pull()`'u SSE ilerlemesiyle saran, `/api/import` deseninde),
`DELETE` (model sil). Ayarlar → Modeller kartına "Kurulu modeller"
listesi (isim + GB + sil butonu) ve "Model indir" alanı (isim + ilerleme
durumu) eklendi; silme onayı AlertDialog ile. Model atama (varsayılan/
hızlı/muhakeme) zaten mevcuttu, dokunulmadı.

**Faz 15 tamamlandı.**

## Faz 16 — Sağlayıcı genişletme

Sağlayıcı katmanı zaten jenerik: `openai-compat` tipi + özel `baseUrl` +
`apiKey` + `reasoningDialect` (`think-tags`/`reasoning_content`/`none`).
Yani OpenAI-uyumlu herhangi bir uç nokta `data/providers.json`'a elle
eklenirse çalışıyor — eksik olan yalnızca ekleme UI'ı. Anthropic (Claude)
istisna: native API'si OpenAI-uyumlu değil (messages API + thinking
blokları), ayrı bir adapter gerektiriyor. İki parça birbirinden bağımsız.

- **16A — Jenerik OpenAI-uyumlu ekleme UI'ı:** ad + `baseUrl` + API
  anahtarı + `reasoningDialect` giren form. Yeni adapter kodu gerekmez;
  OpenAI, Groq, OpenRouter, Together, Mistral, Gemini'nin OpenAI ucu
  anında çalışır.
- **16B — Native Anthropic adapter:** messages API + thinking blokları
  için ayrı adapter (`openai-compat.ts`'in `OpenAICompatAdapter`'ından
  türetilemez, kendi istek/stream formatı gerekir). 16A'dan bağımsız,
  belirgin ölçüde daha büyük iş.

## Bitti tanımı

- [x] 16A: kullanıcı ayarlardan yeni bir OpenAI-uyumlu sağlayıcı
      ekleyebiliyor (ad+baseUrl+anahtar), chat'te seçilebiliyor.
- [x] 16B: Anthropic/Claude sağlayıcı olarak eklenebiliyor, streaming
      chat + thinking blokları diğer sağlayıcılarla aynı arayüzden
      çalışıyor.

### Uygulama

**16A — jenerik OpenAI-uyumlu ekleme UI'ı:** `config-store.ts`'e
`addProvider()` (label'dan slug id üretimi, çakışmada sayısal sonek,
varsayılan bulut timeout'ları, `enabled: false` ile başlar — anahtarı
olmayan bir sağlayıcı sessizce chat varsayılanı olamaz) ve
`deleteProvider()` (Ollama'yı korur, sağlayıcıyı tüm görev zincirlerinden
de temizler — sarkan zincir girdisi `chatWithFallback`'te "Bilinmeyen
provider" fırlatırdı) eklendi. `POST /api/providers` (ekleme) ve
`DELETE /api/providers` (silme) route'ları. Ayarlar → Sağlayıcılar
sayfasına "Sağlayıcı ekle" formu (isim + baseUrl + API türü + muhakeme
formatı) ve her sağlayıcı kartına sil butonu (Ollama hariç) eklendi.
`ProviderStatus.kind`'a `'anthropic'` eklendi; GET handler'ı artık
`needsKey`'i `kind !== 'ollama'` ile hesaplıyor (anthropic de anahtar
ister).

**16B — native Anthropic adapter:** yeni `providers/anthropic.ts` —
`OpenAICompatAdapter`'dan türetilemez (Anthropic Messages API OpenAI
formatında değil: üst düzey `system` alanı, zorunlu `max_tokens`,
`content_block_delta`/`message_stop` event'leri, `thinking` blokları).
Aynı `ProviderAdapter` arayüzünü uygular: üç kademeli timeout köprüsü,
hata sınıflandırması, `thinking_delta` → `reasoning` chunk, `text_delta`
→ `text` chunk, `req.format` → `tool_use` tabanlı JSON modu, `req.think`
→ extended thinking (temperature kaldırılır, Anthropic kuralı).
`registry.ts`'in `buildAdapter()`'ı `kind === 'anthropic'` dalını
ekledi. Sağlayıcı ekleme formunda "Anthropic (Claude)" seçeneği.

**Faz 16 tamamlandı.**

**Faz 11 tamamlandı (kod + otomatik doğrulama); canlı manuel doğrulama
kullanıcıya bırakıldı.**