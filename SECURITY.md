# Güvenlik Politikası

## Bir güvenlik açığı bildirmek

Bir güvenlik açığı bulduysanız **lütfen genel bir GitHub Issue açmayın**. Bunun yerine bu reponun GitHub sayfasında **Security > Advisories > "Report a vulnerability"** üzerinden özel (yalnızca sizinle ve sürdürücüyle paylaşılan) bir bildirim açın. Bu, açık kalmış bir açığın herkese ilan edilmeden önce düzeltilmesine imkân verir.

Bu bireysel/açık kaynak bir proje — resmi bir SLA yok, ama ciddiyetle ele alınır.

## Kapsam

Vault Chat yerel-öncelikli çalışan bir SvelteKit uygulaması + Python ingest yan süreci. En hassas yüzeyler:

- **Dış ağdan içerik getiren yollar** (link/YouTube içe aktarma) — SSRF, DNS-rebinding.
- **Dosya sistemi erişimi** (kasa okuma/yazma, ek dosya servisi) — path traversal.
- **Kullanıcı yüklediği/getirdiği dosyaların ayrıştırılması** (PDF/DOCX/PPTX/vb.) — ayrıştırıcı zafiyetleri (üçüncü taraf kütüphanelerde).
- **API anahtarı depolama** (`secrets.json` ve şifreleme anahtarının işletim sistemi tarafındaki yeri).
- **MCP sunucusu** — yerel bir istemciye kasa içeriğini açan yol.

## Uygulanmış sertleştirmeler (kod incelemesiyle doğrulanabilir)

- **SSRF** — her dış istek (link/YouTube içe aktarma) `node:net`'in `BlockList`'iyle özel/yerel/loopback IP aralıklarını reddeder; her yönlendirme (redirect) adımında **yeniden** kontrol edilir (ilk hedef güvenli, yönlendirilen hedef güvensiz olabilir); `pinnedDispatcher` DNS çözümlemesiyle gerçek bağlantı arasındaki IP'nin aynı kalmasını zorlar (DNS-rebinding'i kapatır).
- **Path traversal** — her kasa-göreli yol (`resolveLibraryPath`) kasa köküne `path.resolve` edilip sonucun hâlâ o kök altında olduğu doğrulanmadan hiçbir dosya işlemi yapılmaz; ek dosya servisi (`/api/library/attachment`) ayrıca yalnızca `_meta/attachments/` alt klasörüyle sınırlı.
- **İçerik türü doğrulama** — ek dosya servisi uzantıya güvenmez, dosyanın gerçek baytlarını (magic bytes) uzantıyla karşılaştırır; SVG içinde `<script>`/olay-işleyici/`javascript:` tespit edilirse reddedilir.
- **API anahtarları** — `secrets.json` AES-256-GCM ile şifrelenir; şifreleme anahtarı (rastgele 32 bayt) Tauri masaüstü sürümünde işletim sisteminin kendi deposunda tutulur (`src-tauri/src/secrets_key.rs`):
  - **Windows:** DPAPI ile mühürlenmiş `secrets.key` dosyası (kullanıcı profiline bağlı).
  - **macOS:** oturum Anahtar Zinciri (Keychain) — servis `app.vaultchat.desktop`, hesap `secrets-key`.
  - **Linux:** Secret Service (GNOME Keyring / KWallet; D-Bus üzerinden).
  - **Üç durum:** *şifreli* (anahtar depoda), *düz metin* (sistemde güvenli depo hiç yoksa — örn. Secret Service çalışmayan sade bir Linux masaüstü; dosya `0600` izniyle yazılır ve Ayarlar'da uyarı bandı gösterilir) ve *kilitli* (anahtar var ama okunamıyor — Keychain kilitli/erişim reddedildi, bozuk kayıt). Kilitli durumda **yeni anahtar üretilmez** ve mevcut `secrets.json`'a dokunulmaz (sessizce yeni anahtar üretmek var olan anahtarlarınızı geri dönülmez biçimde okunamaz yapardı). Kullanıcı isterse **Ayarlar → Sağlayıcılar → "Kayıtlı API anahtarlarını sıfırla"** ile kurtarır: `secrets.json` silinmez, `secrets.json.locked-<tarih>` adıyla yedeklenir; okunamayan anahtar Windows'ta `secrets.key.locked-<tarih>` olarak yeniden adlandırılır, macOS/Linux'ta depodaki kayıt silinir; ardından uygulama yeniden başlar ve yeni anahtar yalnızca bu başlangıçta üretilir.
  - Tarayıcı/geliştirici akışında (`npm run dev`) bu işletim sistemi deposu kullanılmaz; ortamda geçerli bir `SECRETS_KEY_HEX` verilmedikçe `data/secrets.json` düz metin + `0600` olarak yazılır.
  - macOS ve Linux desteği yeni ve **henüz gerçek makinelerde denenmedi** (beta).
- **MCP** — bir kasa varsayılan olarak dışarıya kapalı (`mcpExposed: false`); yalnızca kullanıcı açıkça açtığı kasalar bir MCP istemcisine görünür/erişilebilir, id bilinse/tahmin edilse bile kapalı bir kasaya erişim reddedilir.
- **Bulut sağlayıcı onayı** — bir bulut modeline sohbet içeriği gitmeden önce ayrı, geri alınabilir bir onay kaydı gerekir (`data/provider-consent.json`).

## Bilerek dışarıda bırakılan / açık madde olarak duran riskler

Bunlar reddedilmiş öneriler değil, ölçülüp bilinçli olarak ertelenmiş kararlar (yol haritasında gerekçeleriyle kayıtlı, `docs/yol-2026-09-23.md`):

- **İndirilen dosyaların (PDF vb.) kötü amaçlı yazılım taraması** yok — yalnızca ayrıştırılıyor, çalıştırılmıyor; yine de güvenmediğiniz kaynaklardan indirdiğiniz dosyaları içe aktarmadan önce kendi virüs tarayıcınızla kontrol etmeniz önerilir.
- **TLS sertifika hatalarında işletim sistemi yedek zinciri** kullanılmıyor (bilinçli — TLS atlatma riskini açmamak için); sertifika hatası veren bir kaynak reddedilir, atlatılmaz.
- **`gitleaks` gibi bir otomatik sır tarayıcısı repoya entegre değil** — yayın öncesi elle hedefli bir tarama yapıldı (bkz. `docs/yol-2026-09-23.md` Aşama 12); katkıda bulunanlar kendi commit'lerinde `data/secrets.json`, `.env` gibi dosyaları asla commit etmemeli (`.gitignore` bunları zaten kapsıyor).

## Desteklenen sürümler

Güvenlik düzeltmeleri yalnızca en son yayımlanan sürüme (şu an 0.2.x beta) ve `main` dalına yapılır. Eski sürümler için yama çıkarılmaz; lütfen güncelleyin.
