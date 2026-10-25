# Gizlilik

Bu belge, Vault Chat'in verilerinizle gerçekte ne yaptığını anlatır — kod incelemesiyle doğrulanmış, iddia değil.

## Özet

Vault Chat **yerel-öncelikli** çalışır: kasanız (notlarınız), sohbet geçmişiniz, arama indeksiniz ve ayarlarınız yalnızca kendi bilgisayarınızdaki veri klasöründe tutulur. Hiçbir telemetri, analitik ya da kullanım izleme kodu yoktur (kod tabanında arandı, yok). Uygulamanın kendisi hiçbir sunucuya "eve telefon etmez".

## Verileriniz nerede duruyor

Veri klasörü (aşağıda `<veri>`):

- **Masaüstü uygulaması, Windows (installer):** `%APPDATA%\app.vaultchat.desktop\`
- **Masaüstü uygulaması, macOS:** `~/Library/Application Support/app.vaultchat.desktop/`
- **Masaüstü uygulaması, Linux:** `~/.local/share/app.vaultchat.desktop/`
- **Kaynak koddan çalıştırma (`npm run dev`):** reponun `data/` klasörü

İçerik:

- **Kasa/kütüphane içeriği** — `<veri>/vaults/<kasa-id>/library/`.
- **Arama indeksi** (embedding + tam metin) — kasa başına `<veri>/vaults/<kasa-id>/index.db` (SQLite + sqlite-vec).
- **Sınav/kart/rapor/slayt gibi üretilen çalışma materyalleri** — kasa başına `<veri>/vaults/<kasa-id>/study.db`.
- **Sohbet geçmişi ve hafıza** — `<veri>/chats.db` (SQLite).
- **Ayarlar, sağlayıcı listesi, kasa kaydı, başlatıcılar** — `<veri>/*.json`.
- **API anahtarları** — `<veri>/secrets.json`, ayrı ve şifreli (AES-256-GCM). Şifreleme anahtarı veri klasöründe değil, işletim sisteminin deposunda durur: Windows'ta DPAPI ile mühürlenmiş `<veri>\secrets.key` dosyası, macOS'ta Anahtar Zinciri (Keychain), Linux'ta Secret Service (GNOME Keyring / KWallet). Sistemde güvenli depo yoksa (örn. Secret Service çalışmayan bir Linux) anahtarlar şifrelenmeden, yalnızca sahibin okuyabildiği (`0600`) bir dosyada saklanır ve Ayarlar'da bunu söyleyen bir uyarı gösterilir.
- **Hata günlükleri** — `<veri>/app-log.jsonl`, `<veri>/mcp-log.jsonl`: yalnızca metadata (hata kodu, süre, yol), not/sohbet içeriği değil.

**Şifreleme notu:** API anahtarları dışındaki veriler (notlar, sohbetler, çalışma materyalleri, indeks) diskte **düz metin** durur — bu, notlarınızı zaten düz Markdown olarak tutan yerel-öncelikli bir aracın bilinçli tercihi. Bilgisayarınızı başkalarıyla paylaşıyorsanız disk şifrelemesi (BitLocker, FileVault, LUKS) kullanmanız önerilir.

Hiçbiri bu repoya commit'lenmez (`.gitignore`), hiçbiri sizin izniniz olmadan ağ üzerinden başka bir yere gönderilmez. Uygulamanın yerel sunucusu yalnızca `127.0.0.1` adresini dinler; masaüstü sürümünde her açılışta üretilen bir oturum anahtarı olmadan isteklere yanıt vermez.

## Ağ üzerinden giden veri — tam liste

Uygulama yalnızca şu durumlarda dış ağa istek atar, başka hiçbir zaman:

1. **Ollama (yerel)** — `http://127.0.0.1:11434` (varsayılan). Sohbet/üretim istekleri buraya gider; bu kendi makinenizde çalışan bir süreç, ağa çıkmaz.
2. **Bulut model sağlayıcıları (isteğe bağlı, açıkça onaylanmadan asla)** — DeepSeek, Google AI Studio gibi bir bulut sağlayıcı seçip kullanmak istediğinizde, uygulama önce ayrı bir onay kutusu gösterir ("bu sağlayıcıya sohbet içeriği gönderilecek" uyarısı); onaylamadığınız bir sağlayıcıya hiçbir istek gitmez. Onay durumu `<veri>/provider-consent.json`'da tutulur, istediğiniz zaman geri alınabilir.

   **Embedding (arama indeksi) için bulut sağlayıcı seçerseniz** gönderilen veri çok daha geniştir: indeksleme ve yeniden indeksleme sırasında **kasanızdaki tüm notların metni** parça parça o sağlayıcıya gönderilir, her sohbet sorunuz da aranmak için gönderilir. Bu yüzden aynı onay kaydı burada da şarttır ve her embedding çağrısında yeniden denetlenir; onayı geri alırsanız istekler durur (sohbet anahtar kelime aramasıyla devam eder). Varsayılan embedding sağlayıcısı yereldir (Ollama, bge-m3).
3. **Model kataloğu (openrouter.ai, models.dev)** — bir bulut sağlayıcının model listesini açtığınızda, hangi modellerin mevcut olduğunu göstermek için bu iki kamuya açık kataloğa istek atılır (kişisel/sohbet verisi gönderilmez, yalnızca "mevcut modeller ne" sorusu; 24 saat önbelleğe alınır).
4. **Kaynak içe aktarma (link/YouTube)** — siz açıkça bir URL yapıştırıp "içe aktar" dediğinizde, o tek adrese (ve YouTube altyazı API'sine) istek gider. SSRF sertleştirmesi (özel/yerel IP aralıklarına, DNS-rebinding'e karşı engelleme) her istekte devrede. YouTube/harici link içe aktarmadan önce ayrı bir hak-beyanı onay kutusu gösterilir (İ4/İ5).
5. **MCP (Model Context Protocol) sunucusu** — yalnızca siz Claude Code/Desktop gibi bir MCP istemcisini elle bağlarsanız çalışır; bir kasa varsayılan olarak **kapalı**dır (`mcpExposed: false`), yalnızca siz Ayarlar'dan açtığınız kasalar dışarıdan görülebilir/okunabilir.
6. **Kurulum sihirbazı (winget — yalnızca Windows)** — Ayarlar'daki kurulum düğmesine basıp çıkan onay penceresini kabul ettiğinizde, Windows'un kendi paket yöneticisi `winget` izin listesindeki paketi (Ollama, Node.js, Python, Pandoc vb.) Microsoft'un winget kaynaklarından indirir. Uygulama sizin adınıza hiçbir veri göndermez; indirme winget'in kendi davranışıdır. macOS/Linux'ta uygulama kendiliğinden paket yöneticisi çalıştırmaz, yalnızca elle çalıştırmanız için kurulum ipuçları (Homebrew, dağıtımın paket yöneticisi) gösterir.
   - **Python ortamı ("Şimdi kur", tüm platformlar):** PDF/doküman içe aktarma için gereken Python paketlerini (`ingest/requirements.txt`) PyPI'dan `pip` ile indirir; macOS/Linux'ta bunlar veri klasöründeki uygulamaya ait `python-venv` ortamına kurulur. İndirme `pip`'in kendi davranışıdır, notlarınız gönderilmez.
7. **Yerel sunucu algılama** — Ollama/LM Studio gibi yerel model sunucularının çalışıp çalışmadığını anlamak için yalnızca bu bilgisayardaki `127.0.0.1` portlarına bağlanmayı dener; dış ağa çıkmaz.
8. **İsteğe bağlı dönüştürücüler (docling/marker)** — kurmayı seçerseniz, ilk çalıştırmada kendi model ağırlıklarını Hugging Face'ten indirir. Belgelerinizin içeriği gönderilmez; dönüştürme yerelde yapılır.

Bunların dışında her şey tamamen yerelde çalışır.

## Üçüncü taraf içerik ve hak sorumluluğu

Link'ten/YouTube'dan içe aktardığınız içeriğin telif durumu size aittir — uygulama yalnızca bir araçtır, içeriğin hakkını devretmez. Ayrıntı için bkz. `TERMS.md`.

## Sorularınız için

Bu bir bireysel/açık kaynak proje — resmi bir "veri koruma görevlisi" yok. Sorularınız için GitHub Issues üzerinden ulaşabilirsiniz.

---

# Privacy (EN summary)

Vault Chat is **local-first**: your vault content, chat history, search index and settings live only in the data folder on your own machine (`%APPDATA%\app.vaultchat.desktop\` on Windows, `~/Library/Application Support/app.vaultchat.desktop/` on macOS, `~/.local/share/app.vaultchat.desktop/` on Linux for the desktop app, `data/` when run from source). API keys are encrypted (AES-256-GCM; the key lives in the OS secure store: Windows DPAPI, macOS Keychain, Linux Secret Service/GNOME Keyring/KWallet — if a system has none, keys are stored unencrypted in an owner-only `0600` file and the app shows a warning); everything else — notes, chats, study material, index — is stored as plain text, so use disk encryption (BitLocker/FileVault/LUKS) on a shared computer. There is no telemetry or analytics code anywhere in the codebase. The app only ever talks to the network for: (1) your local Ollama instance, (2) a cloud model provider you explicitly opted into (with its own consent dialog, revocable) — if you also pick a cloud provider for embeddings, indexing sends the full text of every note in the vault to it, under the same consent, re-checked on every call (the default embedding provider is local), (3) the public OpenRouter/models.dev model-listing catalogs (no personal data, 24h cache) when you open a provider's model picker, (4) a URL/YouTube link you explicitly paste to import (SSRF-hardened, with its own copyright-acknowledgment checkbox), (5) an MCP client you explicitly connect, against a vault you explicitly opened for that, (6) a winget package install you confirm in the setup wizard (Windows only; macOS/Linux only show manual install hints) and the optional Python environment's `pip` install of the ingest packages, (7) probing `127.0.0.1` ports to detect local model servers (never leaves the machine), and (8) optional converters (docling/marker) downloading their own model weights from Hugging Face on first use. Nothing else ever leaves your machine.
