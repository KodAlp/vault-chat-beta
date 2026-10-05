---
name: mcp-server
description: >
  Phase 10 of vault-agent-toolkit: expose the vault's knowledge base to
  agents (Claude Code/Desktop and other MCP clients) over a local,
  read-only MCP server. Use this skill whenever touching anything under
  mcp/, the src/lib/server/env.ts shim, library-read.ts, the level filter
  in select-chunks.ts, listSources() in retrieve.ts, MCP tool schemas or
  descriptions, data/mcp-log.jsonl, or the Claude client config block.
  Depends on Faz 8 (vault registry) and Faz 9 (frontend) being done. This
  is a read-only access layer, not a feature phase — it must not change
  how the app itself behaves.
scope: server
---

# MCP Sunucusu — Faz 10

## Takılma disiplini (ortak kural)

Aynı hata için en fazla 3 farklı çözüm denemesi yapılır. 3. deneme de
başarısızsa DUR: `docs/stuck-report.md` dosyasına (a) hatanın tam çıktısı,
(b) denenen 3 yaklaşım ve neden başarısız oldukları, (c) en güçlü hipotez
yazılır ve kullanıcıya danışılır. Aynı dosyada küçük değişiklikler
deneyerek 4., 5. tur ATILMAZ. Bir hata "çözüldü" sayılmadan önce doğrulama
komutu (test/build/çalıştırma) mutlaka koşulur; çıktısı görülmeden sonraki
adıma geçilmez. Her çalışma oturumu temiz git durumuyla başlar; 3 denemelik
döngü öncesi commit atılır ki başarısız denemeler `git checkout` ile geri
alınabilsin.

## Kilitlenen kararlar (yeniden tartışılmaz)

1. **Monorepo YOK.** ROADMAP'in Faz 10 metni `packages/core` +
   `packages/app` + `packages/mcp-server`'a geçmeyi "bu fazın ilk ve en
   büyük adımı" diye tarif ediyordu. **Bu karar iptal edildi** (kullanıcı
   onaylı). MCP sunucusu `indexer/` ile birebir aynı deseni izleyen,
   aynı paket içinde bir kardeş klasördür: `mcp/`.

   Gerekçe — monorepo, Faz 7'de belgelenmiş paketleme mayınlarını
   yeniden tetikliyor:
   - `scripts/stage-server.mjs` `package.json` + `package-lock.json`'ı
     kopyalayıp içeride `npm ci --omit=dev` çalıştırıyor; workspace
     protokolü bağımlılıkları ve kök seviyesine taşınan lockfile bunu
     doğrudan kırar.
   - `src-tauri/tauri.conf.json`'daki `"resources": ["../dist-server/**/*"]`
     ile `src-tauri/src/lib.rs`'teki `resource_dir.join("_up_").join("dist-server")`
     birbirine bağlı: Tauri her `../` seviyesini literal bir `_up_`
     segmentine çeviriyor. Klasör derinliği değişince segment sayısı
     değişir ve hata **derleme zamanında değil, yalnızca runtime'da**
     "Sunucu dosyası bulunamadı" olarak görünür. lib.rs'te bunun ne kadar
     acı verdiğini anlatan 12 satırlık bir yorum zaten var.
   - `.gitignore` (`data/*.db`), `components.json` (`tailwind.css: src/app.css`),
     `fix-adapter-node-tokens.mjs` (`process.cwd()/build`) hep path-göreli.
   - `src/lib/server/` ↔ `indexer/` arasında çift yönlü import döngüsü var.

   **Kural:** bu fazda `scripts/`, `src-tauri/`, `svelte.config.js`,
   `tsconfig.json`, `components.json` dosyalarına DOKUNULMAZ. Klasör
   derinliği değişmediği sürece `lib.rs`'teki `_up_` sayısı etkilenmez;
   bu, "paketleme deltası sıfır" iddiasının kanıtıdır.

2. **v1 salt-okunurdur — üretici araçlar yok.** ROADMAP araç listesinde
   `generate_quiz`/`generate_flashcards` vardı ama aynı bölüm
   "mcp-server DB'leri salt-okur (`mode=ro`) açar" diyordu; ikisi aynı
   anda doğru olamaz. Üreticiler ertelendi (aşağıda "Üretici araçların
   erteleme şartları").

   **Güncelleme (2026-10-05, kullanıcı kararı): yazma yüzeyi eklendi, ama
   MCP hâlâ hiçbir dosyaya kendisi yazmaz.** `create_vault`,
   `import_source`, `list_pending_imports` araçları çalışan uygulamanın
   yerel API'sini çağırır (`mcp/app-client.ts` → `DATA_DIR/mcp-endpoint.json`
   → `/api/mcp/*`, `x-vc-mcp-token`, Origin taşıyan istek reddedilir).
   Uygulama kapalıysa `APP_NOT_RUNNING`. İçe aktarmalar staging'e düşer;
   kütüphaneye yalnız kullanıcının arayüzdeki onayıyla girer — MCP'nin
   onaylama ya da not düzenleme aracı YOK. Yerel yol yalnız
   `mcp-settings.json` izinli köklerinden (MCP bu dosyayı değiştiremez).
   `mcp/no-write-import.test.ts` kilidi geçerli: `mcp/` `library.ts` /
   `library-write.ts`'i içe aktarmaz. Aşağıdaki "salt-okunur" invaryantı
   MCP SÜRECİ için aynen geçerlidir; yazmaları yapan uygulama sürecidir.
   Not düzeltme (`edit_note`, geliştirici anahtarı) ayrı aşama:
   docs/dev/arastirma-2026-10-tema-pptx-mcp.md C4.

3. **Taşınabilirlik ucuz — büyük bir "core extraction" yapılmaz.** MCP
   yolundaki tek çalışma-zamanı SvelteKit bağımlılığı
   `src/lib/server/ollama.ts`'in `$env/dynamic/private` import'udur.
   `retrieve.ts` ve `library.ts` kendileri temizdir ama ikisi de buna
   transitif bağlıdır (`library.ts` → `incrementalIndex.ts` → `./ollama`).
   `$lib/types` import'larının tamamı `import type`'tır, çalışma zamanında
   silinir, engel değildir. Çözüm: küçük bir `env.ts` shim'i, tam da
   `vaults.ts`'in `process.env` kullanma gerekçesiyle aynı sebeple.

4. **stdio birincil transport; HTTP v1'de YOK.** Opsiyonel localhost HTTP
   transport SDK'nın express/hono yüzeyini aktive ediyor ve hiçbir "bitti
   tanımı" maddesi onu gerektirmiyor.

5. **Vektör-only arama.** ROADMAP `search_library` için "hibrit arama"
   diyor, ama bu kararın alındığı sırada `indexer/db.ts` yalnızca `files`,
   `chunks`, `vec_chunks` yaratıyordu — hiçbir FTS tablosu yoktu. v1 saf
   vektör KNN'dir ve bu ROADMAP'e açıkça yazılır; sessizce "hibrit" diye
   işaretlenmez.

   **Not (2026-09-23): öncül artık geçersiz, karar hâlâ geçerli.**
   `db.ts` Faz 5'ten beri bir `chunks_fts` (FTS5) tablosu da yaratıyor —
   sohbet rotasının anahtar kelime yedeği için (vektör arama boş dönünce).
   Yani "FTS tablosu yok" artık doğru değil; ama `search_library`/
   `list_sources` bilinçli olarak hâlâ FTS'e dokunmuyor — v1 salt-okunur
   sözleşmesi vektör-only kalsın diye, karar yeniden alınmadı. FTS'i MCP'ye
   açmak istenirse bu ayrı bir tur, çünkü keyword-search.ts'in AND/≥2-terim
   kapısı sohbete özgü kalibre edilmiş (bkz. vault-rag-index skill'i).

## Neyin salt-okunur olduğunun tam tanımı

İnvaryant şudur: **`index.db`, `study.db`, `chats.db` ve kütüphane
dosyalarına asla yazılmaz.**

Bu, "hiçbir şey yazılmaz" demek DEĞİLDİR ve öyle iddia edilmemelidir:
- `vaults.ts`'in `dataDir()`'ı (ve `library.ts`'in `libraryRoot()`'u) her
  çağrıda `mkdirSync` yapıyor — yok olan `data/` dizinini yaratır. Bu
  dizin yaratmadır, veri yazma değil.
- `data/mcp-log.jsonl`'a yazılır (aşağıya bkz).

Araçların hepsi `annotations: { readOnlyHint: true, destructiveHint: false,
openWorldHint: false }` taşır — bu, fazın temel vaadinin makine-okunur
halidir ve istemciler bunu kullanıcıya gösterir.

## Mimari kurallar

### `mcp/` düzeni

```
mcp/
  launch.mjs        # MCP istemcilerinin spawn ettiği düz JS giriş (loader'sız başlar)
  create-server.ts  # McpServer + registerTool wiring (düzeltme 2026-09-23: bu satır
                     #   önceden server.ts'e atfediliyordu — yanlıştı)
  server.ts         # ince stdio giriş noktası: createServer() + connect(StdioServerTransport)
  vault-scope.ts    # vault çözümleme + serileştirme + handle kapatma
  errors.ts         # tipli araç hataları
  log.ts            # data/mcp-log.jsonl
  tools/            # araç başına bir dosya
  smoke.ts          # süreç-içi Client↔Server harness (create-server.ts'i kullanır)
  tsconfig.json
  claude-config.example.json
```

`mcp/tsconfig.json` `indexer/tsconfig.json`'ı örnek alır, ama **ek olarak**
`paths: { "$lib/*": ["../src/lib/*"] }` gerekir — `retrieve.ts` ve
`select-chunks.ts` `$lib/types` import ediyor, indexer bu duruma hiç
girmemişti. Çalışma zamanını etkilemez (`import type`, tsx siler).

### Env shim (`src/lib/server/env.ts`)

- **Her erişimci bir FONKSİYON olmalı, modül-düzeyi sabit değil.**
  `$env/dynamic/private`'ın semantiği zaten dinamiktir. Sabit olursa ESM
  hoisting yüzünden, `process.env.DATA_DIR`'ı ayarlayıp sonra
  `await import('./server.ts')` yapan bir bootstrap kaybeder. `vaults.ts`
  bunu zaten doğru yapıyor (`dataDir()` çağrı başına okunuyor) ve
  `vaults.test.ts`'in `useTmpDataDir()`'ı buna bağlı — bozma.
- Boş string tanımsız sayılır (`v && v.length ? v : undefined`). `$env`
  ile çıplak `??` bu noktada ayrışır; Tauri her değişkeni boş olmayan
  şekilde geçtiği için bu fark bugüne kadar ısırmadı.
- **`loadEnvFile()` çağrısı `env.ts`'in İÇİNE KONULMAZ.** Orada modül yan
  etkisi olur ve repo kökünden `node build` sessizce `.env` onurlandırmaya
  başlar — bugün yapmıyor. Aynı sebeple `hooks.server.ts`'e de konulmaz.
  Doğru yerler: dev için `vite.config.ts`'in en üstü, MCP için
  `launch.mjs` (mutlak path ile).

`process.loadEnvFile()`'ın mevcut değişkenleri **ezmediği** ampirik olarak
doğrulandı (Vite'ın `loadEnv` önceliğiyle aynı) — bu yüzden shim
davranış-koruyucudur ve Claude config'indeki açık `env` bloğu her zaman
kazanır.

### `launch.mjs` sözleşmesi

Sırayla:
1. `repoRoot = fileURLToPath(new URL('..', import.meta.url))` — **asla
   `process.cwd()`**. MCP istemcisi rastgele bir cwd ile spawn eder.
2. **stdout muhafızı** — her şeyden önce. `console.log/info/debug`
   `console.error`'a yönlendirilir.
3. `try { process.loadEnvFile(join(repoRoot, '.env')) } catch {}`
4. `process.env.DATA_DIR = path.resolve(repoRoot, process.env.DATA_DIR ?? 'data')`
   — `vaults.ts`/`registry.ts`/`secrets.ts`'in `path.resolve(process.cwd(), …)`
   varsayımını kaynağında etkisizleştirir.
5. `--print-config` modu: çözümlenmiş mutlak path'lerle hazır config
   bloğunu stdout'a basıp çıkar.
6. `const { register } = await import('tsx/esm/api'); register();`
   Bare specifier `launch.mjs`'in kendi konumundan çözülür. **tsx
   zorunludur** — `node file.ts` bu Node'da tip siliyor ama uzantısız
   göreli import'larda `ERR_MODULE_NOT_FOUND` veriyor.
7. Tek stderr satırı: `[vault-chat-mcp] DATA_DIR=… vaults=N`.
8. `await import('./server.ts')`.

### stdout disiplini (kritik)

stdio transport'ta **stdout JSON-RPC çerçeveleri taşır**. İçe aktarılan
herhangi bir modülden çıkan tek bir `console.log` satırı akışı bozar ve
istemcide anlaşılmaz bir parse hatası olarak görünür. `migrateVaults.ts`
ve `indexer/`'ın tamamı `console.log` doludur — muhafız bu yüzden
opsiyonel değildir. Log satırları **asla** `console.log`'a yazılmaz.

### Handle ve eşzamanlılık (Faz 8 EBUSY dersi)

- Tüm handler `mcp/vault-scope.ts`'teki tek bir `createMutex()` üzerinden
  **serileştirilir**. Çağrı-başına handle kapatmayı güvenli kılan şey
  budur; yoksa üst üste binen iki araç çağrısı
  `The database connection is not open` üretir.
- Her çağrının `finally`'sinde `closeVaultIndexDb(v.id)` çağrılır — Faz
  8'de tam da bu EBUSY gerekçesiyle eklenmiş mevcut export. Net etki: MCP
  süreci çağrılar arasında **sıfır** SQLite handle tutar, uygulamanın
  vault-silme route'u MCP yüzünden asla EBUSY yemez.
- **`study-db.ts`'e hiç dokunulmaz.** `getDb()` read-write açıyor ve her
  açılışta `CREATE TABLE IF NOT EXISTS` çalıştırıyor.
- WAL notu: temiz yazar kapanışından sonra `-shm` yoksa salt-okur açılış
  `SQLITE_CANTOPEN` verebilir. `retrieve.ts` bu deseni Faz 8'den beri
  kullanıyor ama çağrı-başına aç/kapat bunu çok daha sık zorlar.
  **Düzeltme (2026-09-23): `getDb()`'de böyle bir fallback YOK.**
  Bu satır önceden `{ readonly: false, fileMustExist: true }`'a düşen bir
  yedek açılış tarif ediyordu; gerçek kod yalnızca `new Database(path,
  { readonly: true, fileMustExist: true })` çağırıyor, başarısız olursa
  (`existsSync` zaten `null` dönüyorsa hariç) hatayı olduğu gibi fırlatıyor
  — `sqliteVec.load()` başarısız olursa handle kapatılıp hata tekrar
  fırlatılıyor (`instance.close()` + `throw`), ama `readonly: false`'a
  düşen bir ikinci deneme hiç yok. Gözlenmiş bir `SQLITE_CANTOPEN` de yok;
  eğer görülürse gerçek davranış budur, yedek açılış değil.

## Araç tasarımı kuralları

- `vault` her araçta `z.string().optional()` — yoksa registry'nin aktif
  vault'una düşer. **Her yanıt çözümlenen `vault` id'sini geri yansıtır**
  ki agent hangi vault'u okuduğundan asla şüpheye düşmesin.
- `inputSchema` SDK ≥1.10'da **ZodRawShape**'tir (düz obje), `z.object()`
  değil. Repo'daki mevcut `zod ^4.4.3` kullanılır; SDK peer'ı
  `^3.25 || ^4.0` olduğu için ikinci kopya gerekmez.
- **`outputSchema`/`structuredContent` v1'de kullanılmaz** — opsiyonel
  `@cfworker/json-schema` peer'ını çeker ve istemci uyumluluğunu daraltır.
- **Hatalar fırlatılmaz, döndürülür:** `{ isError: true, content: [...] }`,
  tipli kodlarla (`VAULT_NOT_FOUND`, `NOT_INDEXED`, `OLLAMA_UNAVAILABLE`,
  `NOTE_NOT_FOUND`, `PATH_OUTSIDE_LIBRARY`). Agent bir hata koduna göre
  davranabilir; exception ise turunu iptal ettirir. `NOT_INDEXED` uzun süre
  tanımlı ama hiç üretilmiyordu — indekssiz bir kasada `search_library`/
  `list_sources` sessizce boş sonuç dönüyordu (`isError:false`), "arandı,
  eşleşme yok" ile ayırt edilemiyordu. 2026-09-23'te `vaultIsIndexed()`
  eklenip ikisi de gerçekten `NOT_INDEXED` fırlatır oldu.
- **Enum kullanma, `z.string()` kullan** — özellikle `level` için.
  `undergrad/grad/phd` yalnızca *bu* vault'ta bulunan değerler;
  `index-vault.ts` frontmatter'daki `level`/`depth`'i olduğu gibi yazıyor.
  Enum, başkasının vault'unu sert reddederdi. Gözlenen değerler
  `.describe()`'a yazılır.
- **Token bütçesi bir tasarım kısıtıdır.** `snippet` ~600 karakterde
  kırpılır (k=8 × tam chunk 8k+ token olabilir); `list_sources`
  `limit`/`offset` alır (varsayılan 200) — 289 satır sınırsız ≈ 9k
  token/çağrı ve yüzey 5000 notluk bir vault'ta da yaşamalı.
- `distance` yerine `score = 1 - distance` döndürülür; ham cosine mesafesi
  LLM'e ters okunur.
- Her aracın açıklaması "önce `list_vaults` çağır" der. **Şema
  açıklamaları koddur** — gerçek istemci testinde asıl sınanan şey
  modelin doğru aracı seçip seçmediğidir.

### `list_sources` neden indeks DB'sinden okur

`getLibraryTree`'nin fs yürüyüşü **kullanılmaz**. `files` tablosuna tek
SQL sorgusu başlık/seviye/domain'i veriyor, 289 dosya için
`readFileSync`+`gray-matter` gerekmiyor, ve semantiği daha dürüst:
"agent'ın gerçekten getirebileceği şey". Karşılığında indekslenmemiş
dosyalar görünmez — bu, araç açıklamasında belgelenir.

## Loglama (`data/mcp-log.jsonl`)

`appendFileSync` (serileştirilmiş handler'lar, küçük yazımlar; yazım
ortasındaki bir çökme, o çökmeyi açıklayan kaydı kaybetmemeli). Path
`path.join(dataDir(), …)` — mutlak, masaüstü kullanıcısında `%APPDATA%`'yı
takip eder.

Kayıt: `{ ts, tool, vault, ok, ms, resultCount?, errorCode?, params }`.

**İçerik kuralı** (ROADMAP: *"içerik loglanmaz"*), kaymasın diye açıkça:

| Araç | Loglanan | Loglanmayan |
|---|---|---|
| `search_library` | `queryChars`, `domain`, `level`, `k` | **sorgu metni asla** |
| `get_note` | `path` | dosya gövdesi, frontmatter değerleri |
| `list_sources` | `domain`, `level`, `limit`, `offset` | — |

Asla loglanmaz: not gövdesi, chunk metni, frontmatter değerleri, sorgu
dizeleri, sonuç yükleri. 5 MB'ta `.1`'e döndürülür. **Tüm hata yolları
yutulur** — loglama bir araç çağrısını asla bozmaz. `.gitignore`'a
`data/mcp-log.jsonl*` eklenir (mevcut `data/*.db` deseni bunu kapsamıyor).

## Paketleme kuralları

- `@modelcontextprotocol/sdk` **`devDependencies`'e** girer, `~1.30.0`
  olarak pinlenir (ROADMAP: "MCP SDK sürümü sabitlenir (~)"). Gerekçe:
  SvelteKit sunucusu onu hiç import etmiyor, ve `stage-server.mjs`
  `npm ci --omit=dev` çalıştırdığı için `dist-server/` bugünküyle
  **bit-bazında aynı** kalır — express/hono/jose Tauri paketine hiç
  girmez. `tsx` zaten dev-only olduğundan paketlenmiş uygulama MCP
  sunucusunu zaten çalıştıramaz.
- Build adımı yok, `bin` girdisi yok, `npx` hikâyesi yok (Faz 10.5).
- **Claude config'inde `"command": "node"`, asla `npx`/`tsx` değil.**
  Windows'ta ikisi de `.cmd` shim'idir; shell'siz spawn eden istemci
  `ENOENT` alır — Windows'taki en yaygın MCP arıza sebebi. `node` PATH'te
  gerçek bir `.exe`'dir ve `launch.mjs` cwd'ye ihtiyaç duymaz.
- Masaüstü uygulaması `DATA_DIR`'ı `%APPDATA%`'ya işaret ettiriyor
  (`lib.rs`), repo `data/`'ya değil. `--print-config` bu ayrışmanın
  kaçış kapısıdır; kullanıcıya elle path yazdırma.

## Doğrulama

Sadece derleme/SSR yeterli değildir. Sırayla:

1. `npm test` — `select-chunks` level vakaları (eşleşme, case-insensitive,
   eşleşmeyince hepsi düşer, `undefined` = tümü) + yeni
   `library-read.test.ts` traversal testleri (`../`, `..\\` **Windows
   ayracı dahil**, mutlak path, iç içe ama meşru path).
2. `npm run dev` — env shim sonrası, **en riskli değişiklik**. Sohbet
   gönder, kaynak göstermeye devam etmeli. Sonra
   `OLLAMA_URL=http://127.0.0.1:9 npm run dev` ile kabuk env'inin `.env`'i
   hâlâ ezdiğini kanıtla.
3. `npm run mcp:smoke` — SDK'nın kendi `InMemoryTransport.createLinkedPair()`'i
   ile tek süreçte gerçek `Client` ↔ gerçek `McpServer`. Traversal ve
   bilinmeyen-vault vakaları burada assert edilir.
4. **Rastgele cwd stdio testi** — `StdioClientTransport({ command: 'node',
   args: [ABS_LAUNCH], cwd: os.tmpdir(), env: {} })`. Tüm `process.cwd()`
   bug'larını tek seferde yakalar.
5. **stdout temizliği** — JSON-RPC'yi `node mcp/launch.mjs`'e pipe et, her
   stdout satırı JSON parse etmeli. `vaults.ts`'e geçici bir
   `console.log('x')` ekleyip testin kırmızıya döndüğünü doğrula, geri al.
6. **Handle sızıntısı probu** (Windows): sunucu ayaktayken PowerShell'den
   `index.db`'yi `Rename-Item` ile yeniden adlandır ve geri al. Başarı =
   handle tutulmuyor.
7. **Gerçek istemci**: önce Claude Code (`claude mcp add`), sonra Claude
   Desktop (`%APPDATA%\Claude\logs\mcp-server-*.log` tek teşhis kaynağı).
8. **İki vault izolasyonu**, **WAL eşzamanlılığı** (indexer yazarken
   arama), **uygulama kapalıyken çalışma**, ve **yazmama iddiası**
   (üç DB'nin `mtime`+boyutu değişmemeli).

**Test fixture kuralı:** gerçek `default` vault'a dokunulmaz. İzole bir
scratch `DATA_DIR` kullanılır ve **ilgili tüm path env'leri açıkça set
edilir** — Faz 8'de eksik env izolasyonunun gerçek veriyi taşıdığı olay
SESSION-LOG'da kayıtlı.

## Üretici araçların erteleme şartları (v2)

`generate_quiz`/`generate_flashcards` şu üç sebeple v1'de yok:

1. **Salt-okur sözünü bozar.** `createQuiz`/`createDeck` → `study-db.ts`'in
   `getDb()`'si study.db'yi read-write açıp `CREATE TABLE IF NOT EXISTS`
   çalıştırır.
2. **Ollama RAM disiplini süreçler arası çalışmaz.**
   `providers/ollama.ts`'in `ensureModelLoaded()`'ı model değişiminde
   eskisini `keep_alive: 0` ile düşürüyor ve bunu `sharedJobMutex` ile
   sıraya sokuyor — ama o mutex modül düzeyinde bir JS promise zinciri,
   **tek süreç içinde**. İkinci süreç = ikinci mutex = garanti yok. Kodun
   kendi yorumu: *"32 GB fits ONE large model."*

   Salt-okunur araçlar bu riskten **muaftır**: `retrieve()` → `embed()`
   doğrudan `/api/embed`'e gider, `OllamaAdapter`'a hiç uğramaz,
   `ensureModelLoaded` çağrılmaz, model `bge-m3` (566M — düzeltme
   2026-09-23, gömme modeli `nomic-embed-text`'ten `bge-m3`'e geçti,
   bkz. vault-rag-index skill'i). v1 kapsamının en güçlü gerekçesi budur.
3. **Sunucu tarafında varsayılan model yok.** `generateQuiz` zorunlu
   `model: string` istiyor; her mevcut çağrı noktası kullanıcının UI
   seçimini iletiyor. Ayrıca ROADMAP `count?` diyor ama fonksiyon
   `composition: {mc, tf, open}` alıyor.

**v2'de gerekenler:** araca zorunlu ve açık bir `model` parametresi
(veya bir `list_models` aracı), süreçler arası dosya-tabanlı kilit, ve
study.db'nin yalnızca üretim çağrısı süresince read-write açılıp hemen
kapatılması.

## Bitti tanımı

- [ ] Claude Code ve Claude Desktop, stdio config ile bağlanıp iki farklı
      vault'ta arama yapabiliyor; sonuçlar vault'lar arasında sızmıyor.
- [ ] UI (dev sunucu ve Tauri) tamamen kapalıyken mcp-server tek başına
      çalışıyor.
- [ ] App/indexer yazarken mcp-server eşzamanlı okuyabiliyor (WAL testi);
      mcp-server üç DB'nin hiçbirine yazmıyor (mtime+boyut kanıtı).
- [ ] MCP süreci çağrılar arasında SQLite handle tutmuyor (rename probu).
- [ ] Rastgele cwd + boş env ile spawn edilince doğru vault'ları buluyor.
- [ ] stdout yalnızca JSON-RPC taşıyor (muhafız testi kırmızıya dönüp
      geri yeşile dönerek kanıtlandı).
- [ ] `npm test` / `svelte-check` / `npm run build` temiz; uygulamanın
      kendi davranışı değişmedi (sohbet + kaynak gösterimi regresyonsuz).

## Kapsam dışı (Faz 10.5'e yazılır)

LICENSE, TR+EN README, `examples/library/` örnek vault, CHANGELOG,
`npx` paketleme (`bin` + build adımı + native modül hikâyesi), üretici
araçlar (yukarıdaki v2 şartlarıyla), opsiyonel localhost HTTP transport,
FTS5/hibrit arama, paketlenmiş Tauri uygulamasında MCP desteği.
