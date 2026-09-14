# Vault Chat — Kurulum

Yerel, Docker'sız bir SvelteKit sohbet uygulaması. Kasandaki notlar üzerinde
RAG yapar, Ollama'daki modellerle konuşur. Tek Node süreci, `localhost`'a bağlı.

## Ön koşullar

1. **Node.js 22+** (zaten kurulu: `node --version`).
2. **Ollama** kurulu ve çalışıyor olmalı: https://ollama.com
   ```bash
   ollama serve
   ```
3. Gerekli modelleri çek:
   ```bash
   ollama pull qwen3:8b
   ollama pull bge-m3
   # isteğe bağlı, derin oturumlar için:
   ollama pull qwen3:30b-a3b
   ```
   `bge-m3` embedding modeli — `nomic-embed-text` DEĞİL (`src/lib/server/embed-config.ts`'teki
   `EMBED_MODEL`). Türkçe sorgularda bge-m3 ölçülebilir şekilde daha iyi sonuç veriyor
   (gerekçe embed-config.ts'in kendi yorumunda). Yanlış modeli çekersen `npm run index`
   "model not found" ile patlar ve hiçbir kaynak bulunamaz.

Bu üç maddeyi elle kontrol etmek yerine tek komutla doğrulamak için:
```bash
npm run doctor
```

## Kurulum

```bash
cd vault-chat
npm install
```

`.env` dosyası zaten `.env.example`'dan oluşturuldu. Gerekirse aç ve kontrol et:

```
OLLAMA_URL=http://127.0.0.1:11434
CHATS_DB_PATH=./data/chats.db
PUBLIC_VAULT_NAME=First brain(Software based)   # "default" vault'un ilk açılıştaki görünen adı
```

`PUBLIC_VAULT_NAME` yalnızca "default" vault ilk oluşturulurken (bkz.
`migrateVaults.ts`) varsayılan görünen ad olarak okunur — sonraki
çalıştırmalarda etkisi yok. Kaynaklar her zaman uygulamanın kendi
görüntüleyicisinde açılır; Obsidian yalnızca **Ayarlar → Kütüphane →
Obsidian'dan İçe Aktar** sırasında devreye girer.

## Vault'lar (Faz 8)

Uygulama tek bir kütüphane yerine **birden fazla vault** tutabilir — her biri
kendi kaynak klasörü ve arama indeksiyle, birbirinden tamamen izole
(`data/vaults/<id>/library/`, `data/vaults/<id>/index.db`). Sohbet geçmişi tek
bir global DB'de kalır (`data/chats.db`), her sohbet hangi vault'a ait olduğunu
kaydeder.

- Vault oluşturmak/silmek/yeniden adlandırmak için **Ayarlar → Vault'lar**.
- Bir defada tek bir vault "aktif" — sohbet ekranı ve indeksleyici hep aktif
  vault üzerinde çalışır.
- **Eski (Faz 8 öncesi) bir kurulumdan geliyorsan** hiçbir şey yapmana gerek
  yok — sunucu ilk açılışta `data/vaults.json` bulunmadığını görüp
  `LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH` içeriğini otomatik olarak
  `data/vaults/default/` altına taşır ve "default" adında bir vault kaydeder;
  eski sohbetlerin hepsi bu vault'a bağlanır. **`VAULT_PATH` bilerek
  taşınmaz** — Faz 5 öncesi mimaride bu, canlı Obsidian vault'unu yerinde
  gösteren bir işaretçiydi (hiç kopyalanmazdı), app'e ait bir klasör değil.
  Sadece `VAULT_PATH` ayarlıysa (bu repodaki gibi — `data/library` boş,
  gerçek içerik `VAULT_PATH=..`'den yerinde indeksleniyor) "default" vault
  **boş** başlar; içeriği Ayarlar → Kütüphane → "Obsidian'dan İçe Aktar" ile
  elle (yeniden) içe aktarman gerekir. Bunu elle, önizlemeli çalıştırmak
  istersen:
  ```bash
  npm run vault:migrate -- --dry-run   # ne taşınacağını raporlar, hiçbir şey yazmaz
  npm run vault:migrate                # gerçekten taşır
  ```

## İlk indeksleme

Sohbet edebilmek için önce aktif vault'un içeriği vektör indeksine dönüşmeli:

```bash
npm run index
```

Bu, aktif vault'un kütüphanesindeki tüm `.md` dosyalarını tarar,
frontmatter'ı olmayanları uyarı ile atlar, geri kalanını parçalayıp
`bge-m3` ile gömer ve o vault'un `index.db`'sine yazar. sha256
tabanlı artımlı çalışır — değişmeyen dosyaları atlar, `pdf2md.py` ile aynı mantık.

Bayraklar:
- `npm run index -- --vault <id>` — aktif vault yerine belirli bir vault'u
  indeksler (id, Ayarlar → Vault'lar'da görünen kimlik).
- `npm run index -- --full` — hepsini sıfırdan yeniden indeksler (embed modeli
  değiştiyse bunu kullan).
- `npm run index -- --dry-run` — hiçbir şey yazmadan neyin değişeceğini raporlar.

## Günlük kullanım

```bash
npm run dev
```

`http://localhost:5173` açılır. Ders çalışıp not güncelledikten sonra, istediğin
an `npm run index` çalıştır — uygulama açıkken bile çakışma olmaz (WAL modu).

Otomatik izleme istersen (opsiyonel, varsayılan değil):

```bash
npm run index:watch
```

## Kalıcı kullanım (geliştirme sunucusu olmadan)

```bash
npm run build
node build
```

## Masaüstü (Tauri)

Aynı sunucuyu tarayıcı yerine yerel bir pencerede çalıştıran, Electron
kullanmayan bir paket. Ön koşullar tarayıcı akışıyla birebir aynı — **Node.js
22+ ve Ollama kurulu ve çalışıyor olmalı**, hiçbiri pakete gömülmez.

```bash
npm run desktop:dev      # canlı Vite dev sunucusuna karşı native pencere, HMR çalışır
npm run desktop:build    # gerçek NSIS kurulum dosyası üretir
```

`desktop:build` çıktısı: `src-tauri/target/release/bundle/nsis/vault-chat_<sürüm>_x64-setup.exe`.
Kurulum kullanıcı bazlı (yönetici gerektirmez), `%LOCALAPPDATA%\vault-chat\`
altına gider. Uygulama verisi (sohbet geçmişi, vault registry, her vault'un
kütüphanesi/indeksi, `config.json`) `%APPDATA%\Roaming\app.vaultchat.desktop\`
altında tutulur — `data/` klasöründen tamamen ayrı, tarayıcı akışıyla
paylaşılmaz. Vault registry buradaki `DATA_DIR`'e göre çözülür (sidecar'ın
kendi ortam değişkeni, kullanıcının görmediği); `config.json`'daki tek
`vault_path`/`vault_name` çifti ise ayrı bir şey — ilk kurulan **"default"**
vault'un adını belirler, ek vault'lar sonradan uygulama içi Ayarlar → Vault'lar'dan
oluşturulur.

İlk açılışta bir klasör seçmen istenir (native klasör seçici) — bu, "default"
vault'un görünen adı için Obsidian tarafındaki isimle eşleşsin diye sorulur,
kütüphane içeriği oraya BAĞLANMAZ (kütüphane her zaman uygulamaya ait bir
klasördür, bkz. yukarıdaki "Vault'lar" bölümü). Seçim `config.json`'a yazılır
ve sonraki açılışlarda tekrar sorulmaz. Bu adı sonradan değiştirmek için
**Ayarlar → Masaüstü — Kasa Konumu** kullan (değişiklik bir sonraki
başlatmada etkili olur, çalışan sunucuyu yeniden başlatmaz).

`node build/index.js`'i doğrudan çağırdığından, kalıcı kullanım akışının
gerektirdiği her şey (Node 22+, `.env` değil ortam değişkenleri) burada da
geçerli — bkz. yukarıdaki not.

## Başka bir Windows makinesinde çalıştırma

Ne installer ne de geliştirici kurulumu Node'u veya Ollama'yı pakete gömüyor —
her ikisi de hedef makinede **elle** kurulu ve çalışır olmalı. Hedef makinede
kurulduktan sonra `npm run doctor` (geliştirici akışı) ya da uygulamanın
kendi "Ollama çalışmıyor" banner'ı (masaüstü paketi) eksik olanı söyler.

| Bileşen | Zorunlu mu | Kim kuruyor |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Evet, masaüstü paketinde de | Elle — https://nodejs.org |
| Ollama + `qwen3:8b` + `bge-m3` | Evet | Elle — https://ollama.com |
| WebView2 Runtime | Evet (yalnızca masaüstü paketi) | Otomatik — NSIS installer yoksa internetten indirip kurar |
| Visual C++ Redistributable | Teknik olarak evet | Genelde Windows 10/11'de zaten var; eksikse elle |
| Python 3 + `pip install -r ingest/requirements.txt` | Hayır — yalnızca PDF/doküman/YouTube içe aktarma için | Elle |
| pandoc | Hayır — yalnızca `.tex` dönüştürme için | Elle |

Dikkat edilecek noktalar:
- **ARM64 Windows desteklenmiyor.** `sqlite-vec`'in Windows için yalnızca
  `win32-x64` prebuilt paketi var — ARM tabanlı bir Windows makinesinde
  (Snapdragon vb.) `npm install` sqlite-vec için başarısız olur.
- **Yanlış Node sürümü sessizce kurulur, çalışma anında patlar.** `engine-strict`
  kapalı olduğu için `npm install` Node 20/24 ile de tamamlanır, ama
  `better-sqlite3`'ün native binary'si Node 22'nin ABI'sine derli — hata ancak
  ilk veritabanı erişiminde çıkar. `npm run doctor` bunu kurulumdan hemen
  sonra yakalar.
- **`data/secrets.json` taşınmaz.** Masaüstü paketinde Windows DPAPI ile
  şifrelenir, DPAPI anahtarı kullanıcı/makine profiline bağlıdır — başka bir
  makineye/kullanıcıya kopyalanan bir `secrets.json` sessizce "anahtar yok"
  gibi davranır. Bulut sağlayıcı (DeepSeek/Gemini/Groq/...) API anahtarlarını
  hedef makinede Ayarlar → Sağlayıcılar'dan yeniden gir.
- **Vault içerikleri elle taşınır.** `data/vaults.json` kendi yollarını her
  okumada yeniden türettiği için taşınabilir, ama her vault'un asıl içeriği
  (`data/vaults/<id>/library/`, `index.db`, `study.db`) ayrıca kopyalanmalı —
  ya da hedef makinede "Obsidian'dan İçe Aktar" + `npm run index` ile
  yeniden oluşturulmalı.
- **Masaüstü paketinde PDF/doküman/YouTube içe aktarma çalışmaz** — `ingest/`
  klasörü kurulum paketine dahil değil (bkz. `scripts/stage-server.mjs`).
  Bu özellikler yalnızca `npm run dev` / `node build` akışında, Python
  kuruluysa çalışır.

## MCP Sunucusu (Faz 10)

Kasandaki notları Claude Code/Desktop gibi MCP istemcilerine salt-okunur
olarak açan yerel bir sunucu — ayrı bir paket veya kurulum gerektirmez,
`mcp/` bu repo'nun içinde `indexer/` ile aynı desende yaşar.

**v1 kapsamı:** `list_vaults`, `search_library`, `get_note`,
`list_sources`. Hiçbir aracın DB'ye yazma izni yok; `generate_quiz`/
`generate_flashcards` gibi üretici araçlar bilinçli olarak ertelendi —
gerekçe `.claude/skills/mcp-server/SKILL.md`'de.

Claude Code'a eklemek için (en hızlı yol):

```bash
claude mcp add vault-chat -- node "<bu repo>\vault-chat\mcp\launch.mjs"
```

Claude Desktop için, `%APPDATA%\Claude\claude_desktop_config.json`'a
eklenecek hazır bloğu üretmek üzere:

```bash
npm run mcp:config
```

Bu komut, çözümlenmiş **mutlak** `DATA_DIR` yolunu içeren bir JSON bloğu
yazdırır — elle path yazmaya gerek yok. Masaüstü (Tauri) uygulamasını
kullanıyorsan `DATA_DIR`'ın `%APPDATA%\Roaming\app.vaultchat.desktop\`'ı
değil, bu repo'nun `data/` klasörünü gösterdiğine dikkat et; ikisi ayrı
veri kümeleridir (bkz. yukarıdaki "Masaüstü (Tauri)" bölümü) — MCP
sunucusu şu an yalnızca tarayıcı akışının `data/`'sını okuyabiliyor,
paketlenmiş uygulamanın verisini okuma Faz 10.5'e bırakıldı.

`claude_desktop_config.json`'da `"command"` her zaman `"node"` olmalı,
`"npx"`/`"tsx"` değil — Windows'ta ikisi de `.cmd` shim'i ve shell'siz
spawn eden istemcilerde `ENOENT` verir.

Doğrulama:

```bash
npm run mcp:smoke   # 4 aracı tek süreçte, gerçek Ollama'ya dokunmadan test eder
```

Sunucu ayaktayken tanı için tek stderr satırı yeterli: `DATA_DIR=... vaults=N`.
Claude Desktop'ta bu satır `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`'a düşer.

## Sorun giderme

- **"Ollama sunucusuna ulaşılamadı"** → `ollama serve` çalışıyor mu, `OLLAMA_URL` doğru mu kontrol et.
- **Model listesi boş / ModelPicker hata veriyor** → `ollama pull qwen3:8b` çalıştırıldı mı?
- **Kaynak bulunamıyor / cevaplar alakasız** → `npm run index` çalıştırıldı mı, index güncel mi?
  Ayrıntılı teşhis sırası için `.claude/skills/vault-rag-index/SKILL.md` içindeki
  "Quality debugging checklist" bölümüne bak. Birden fazla vault kullanıyorsan
  ayrıca kontrol et: doğru vault aktif mi (Ayarlar → Vault'lar), `npm run index`
  aktif vault'u mu indeksledi yoksa başka bir vault'u mu (`--vault <id>` ile
  yanlış vault verilmiş olabilir)?
- **Matematik render olmuyor / `f(x)` gibi çıplak kod görünüyor** →
  `.claude/skills/svelte-vault-chat/SKILL.md` içindeki acid-test string'leriyle
  `src/lib/markdown.ts` pipeline'ını doğrula.
- **MCP istemcisi "connected" göstermiyor / hemen kapanıyor** → `"command"`
  değeri gerçekten `"node"` mu (bkz. yukarıdaki not)? `npm run mcp:smoke`
  temiz geçiyor mu? Claude Desktop'ta `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`'daki
  tek stderr satırını kontrol et — `DATA_DIR` beklediğin yeri mi gösteriyor?
- **MCP `search_library` sonuç döndürmüyor ama uygulamanın kendi sohbeti
  buluyor** → muhtemelen farklı bir `DATA_DIR`/vault okuyorlar; `list_vaults`
  aracının döndürdüğü `indexed`/`noteCount` alanlarına bak.
