# Vault Chat — Adım Adım Kurulum Rehberi

Bu rehber, Vault Chat masaüstü uygulamasını **sıfırdan bir Windows
bilgisayarına** kurmak isteyenler için yazıldı. Teknik bilgi gerektirmez —
her adımı sırayla uygulaman yeterli.

> Zaten geliştirici olarak kaynak koddan çalıştıracaksan (`npm run dev`
> vb.), bunun yerine repo kökündeki **README.md** dosyasına bak — bu rehber
> paketlenmiş kurulumu anlatıyor: adımların ana akışı Windows `.exe` içindir;
> **macOS** ve **Linux** için kısa bölümler 7b'de (yeni, beta).

## 0. Kapalı beta — bağımlılık listesi (önce bunu oku)

Bu sürüm (**0.2.0, kapalı beta**) kurulum dosyası **yalnızca Vault Chat'in
kendisini** kurar. Aşağıdaki programlar bilgisayarında **ayrıca** bulunmalı;
kurulum dosyası bunları ne kurar ne de kontrol eder. Her birinin yanında
tek satırlık `winget` komutu var (Başlat → "cmd" → yapıştır → Enter).

| Bağımlılık | Durum | Sürüm | Kurulum komutu | Yoksa ne olur? |
|---|---|---|---|---|
| Windows 10/11 **x64** | Zorunlu | — | — | ARM (Snapdragon vb.) bilgisayarlarda çalışmaz |
| Microsoft Edge WebView2 | Zorunlu | güncel | Windows 11'de hazır gelir; yoksa kurulum dosyası indirir (**internet gerekir**) | Pencere açılmaz |
| **Node.js** | Zorunlu | **tam olarak 22.x** (20 ve 24 çalışmaz) | `winget install -e --id OpenJS.NodeJS.22` | Açılışta "Node.js bulunamadı"; yanlış sürümde uygulama açılışta veritabanını açamaz |
| **Ollama** (ya da başka bir yerel model sunucusu) | **Önerilen** | güncel | `winget install -e --id Ollama.Ollama` | Sohbet ve test/kart/rapor üretimi için **bir** model kaynağı gerekir: başka bir yerel sunucu (LM Studio, llama.cpp, vLLM, Jan...) ya da bir bulut sağlayıcı da olur. Hiçbiri yoksa sohbet çalışmaz ("Kurulum tamamlanmadı" uyarısı) |
| ↳ `qwen3:8b` modeli | **Önerilen** | — | `ollama pull qwen3:8b` (~5 GB) | Başka bir sohbet modeli seçebilirsin; hiç model yoksa sohbet ve üretim çalışmaz |
| ↳ `bge-m3` modeli | **Önerilen** | — | `ollama pull bge-m3` (~1,2 GB) | Anlamsal arama kapanır; notlar yine indekslenir ve **yalnızca anahtar kelimeyle** aranır (sonuçlar daha zayıf, özellikle Türkçe sorgularda). Başka bir embedding modeli de seçilebilir |
| Python 3 | İsteğe bağlı | 3.12 önerilir | `winget install -e --id Python.Python.3.12` | **Hiçbir dosya içe aktarılamaz** (PDF, Word, bağlantı, YouTube, hatta .md yükleme) — sohbet çalışır |
| ↳ Python paketleri | İsteğe bağlı | `ingest\requirements.txt`: markitdown 0.1.6, pypdf 6.14.2, yt-dlp 2026.7.4, trafilatura 2.2.0, py-asciimath 0.3.0 | Uygulamadaki "Şimdi kur" düğmesi ya da Adım 3b | Uygulama yalnız markitdown'u denetler; diğerleri eksikse web sayfası/YouTube içe aktarma hata verir |
| Pandoc | İsteğe bağlı | güncel | `winget install -e --id JohnMacFarlane.Pandoc` | Yalnız `.tex` (LaTeX) içe aktarma çalışmaz |

**Donanım:** `qwen3:8b` için en az **6 GB ekran kartı belleği** (NVIDIA
önerilir) ya da bol RAM (ekran kartı yoksa çok yavaş çalışır); modeller için
**~7 GB boş disk**. İlk model indirmesi ve bulut sağlayıcılar için internet
gerekir; sonrasında yerel sohbet internetsiz çalışır.

> **Bilinen sınırlar (beta):** Ollama artık zorunlu değil, **önerilen** seçenek:
> LM Studio, llama.cpp, vLLM, Jan gibi OpenAI uyumlu bir yerel sunucu ya da
> bir bulut sağlayıcı da sohbet için yeter; embedding modeli de isteğe
> bağlı (yoksa arama yalnızca anahtar kelimeyle çalışır, anlamsal arama
> kapalı olur). Ne var ki bir model kaynağı yoksa sohbet çalışmaz. Uygulama
> yerel sunucuyu kendisi başlatmaz (kurulum sihirbazında ya da uyarıdaki
> "Başlat" düğmesiyle, ilgili sunucu uygulama içinden tanımlıysa başlatabilir);
> sunucu kapalıysa uyarı gösterir. Bir model kaynağı seçmenin ana yolu kurulum
> sihirbazıdır (Adım 5).

## 1. Neye ihtiyacın var?

Vault Chat, kasandaki notlar üzerinde çalışan yerel bir yapay zekâ sohbet
uygulaması. İnternete ihtiyaç duymadan, bilgisayarının kendi işlem gücüyle
çalışır. Bunun için bilgisayarında iki şeyin **ayrıca kurulu** olması
gerekiyor — Vault Chat'in kurulum dosyası bunları kendisi kurmaz:

1. **Node.js 22** (uygulamanın arka planda çalıştırdığı motor)
2. **Bir yapay zekâ model kaynağı** — **önerilen:** Ollama + iki model (sohbet
   ve arama için). Ollama zorunlu değil: LM Studio, llama.cpp, vLLM, Jan gibi
   başka bir yerel sunucu ya da bir bulut sağlayıcı (DeepSeek, Gemini...) da
   olur; embedding (arama) modeli ise isteğe bağlıdır — yoksa notlar yalnızca
   anahtar kelimeyle aranır.

Aşağıdaki adımları sırayla takip et. Ollama'yı kurmak istemiyorsan Adım 3'ü
atlayıp doğrudan Adım 5'teki kurulum sihirbazına geçebilirsin.

## 2. Node.js'i kur

1. https://nodejs.org adresine git.
2. **22.x** sürümünü indir (sayfada "LTS" yazan sürüm 22'den farklıysa, sitede
   "Other Downloads" / "Sürüm geçmişi" kısmından **22.x.x Windows Installer
   (.msi)** seçeneğini bul — sürüm önemli, 20 veya 24 ile bu uygulama
   çalışmaz).
3. İndirilen `.msi` dosyasını çalıştır, sihirbazı "İleri" diyerek geç
   (varsayılan ayarlar yeterli).
4. Kurulum bitince bir komut istemi (Başlat menüsünden "cmd" yaz, Enter'a
   bas) açıp şunu yaz ve Enter'a bas:
   ```
   node --version
   ```
   Ekranda `v22.` ile başlayan bir şey görmelisin (örn. `v22.23.2`). Görmüyorsan
   bilgisayarı yeniden başlatıp tekrar dene.

## 3. Ollama'yı kur (önerilen, isteğe bağlı)

Bu adım **önerilen** yoldur ama zorunlu değil: başka bir yerel sunucu ya da bir
bulut sağlayıcı kullanacaksan atlayabilirsin. Ollama'yı kurmak ve modellerini
çekmek için kurulum sihirbazı (Adım 5) da yardım eder; elle yapmak istersen:

1. https://ollama.com adresine git, **Download for Windows** butonuna bas.
2. İndirilen kurulum dosyasını çalıştır (yönetici izni istemez, normal
   kurulum gibi ilerler).
3. Kurulum bitince Ollama otomatik olarak arka planda çalışmaya başlar
   (görev çubuğunda küçük bir ikon görürsün — bu normal, uygulamayı
   kapatmana gerek yok, Vault Chat onunla bu şekilde konuşuyor).
4. Aynı komut istemi penceresinde şu iki komutu **sırayla** çalıştır (her
   biri birkaç dakika sürebilir, internet hızına göre değişir):
   ```
   ollama pull qwen3:8b
   ollama pull bge-m3
   ```
   Birincisi sohbet için kullanılan model (~5 GB), ikincisi notlarını
   aramak için kullanılan model (~1,2 GB). Sohbet modeli inmeden sohbet
   çalışmaz; arama modeli inmezse notlar yalnızca anahtar kelimeyle aranır.

**Bu adımı nasıl anlarım doğru gitti mi?** Aynı pencerede `ollama list`
yazıp Enter'a bas — listede hem `qwen3:8b` hem `bge-m3` görünmeli.

## 3b. PDF/doküman içe aktarma için Python (isteğe bağlı)

Bu adım **yalnızca** notlarına PDF, Word veya YouTube transkripti içe
aktarmak istiyorsan gerekli — sohbet ve normal not aramanın çalışması için
gerekli değil, atlayıp devam edebilirsin.

1. https://python.org adresine git, **Download Python** butonuna bas
   (herhangi bir güncel Python 3 sürümü olur).
2. İndirilen kurulum dosyasını çalıştır. Sihirbazın ilk ekranında **"Add
   python.exe to PATH"** kutucuğunu işaretlemeyi unutma — işaretlemezsen
   Vault Chat Python'u bulamaz.
3. Vault Chat'i kurduktan sonra (bkz. Adım 4), ilk PDF/doküman içe aktarma
   denemende uygulama ekranın üstünde turuncu bir uyarı gösterir ve
   **"Şimdi kur"** butonuyla gereken Python paketini senin yerine kurar —
   elle bir komut çalıştırman gerekmez.

**Elle kurmak istersen** (uygulama içindeki "Şimdi kur" butonu yerine):
Vault Chat'in kurulu olduğu klasörde `ingest\requirements.txt` dosyasını
bul (genelde `%LOCALAPPDATA%\vault-chat` altında), o dosyanın bulunduğu
`ingest` klasöründe bir komut istemi açıp şunu çalıştır:
```
python -m pip install -r requirements.txt
```

## 4. Vault Chat'i kur

1. Sana verilen `vault-chat_0.2.0_x64-setup.exe` dosyasını çalıştır.
2. Kurulum yönetici izni istemez, kendi kullanıcı klasörüne kurulur —
   "İleri" diyerek ilerlemen yeterli.
3. Kurulum bitince Vault Chat otomatik açılır (ya da Başlat menüsünden
   "Vault Chat" yazarak açabilirsin).

> **Windows "Bilinmeyen yayımcı" uyarısı verirse**: bu normal, kurulum
> dosyası henüz dijital olarak imzalanmadı. "Daha fazla bilgi" → "Yine de
> çalıştır" diyerek devam edebilirsin.

## 5. İlk açılış

Uygulama ilk kez açıldığında senden bir klasör seçmeni ister — bu, notlarını
tutacağın "kasa" (vault) için bir görünen isim belirlemek amaçlıdır
(seçtiğin klasörün içeriği **kopyalanmaz**, sadece isim olarak kullanılır). İstersen boş bir klasör
seçip devam edebilirsin; gerçek notlarını sonradan uygulama içinden
**Ayarlar → Kütüphane** içindeki içe aktarma ile ekleyeceksin.

Bu seçim sadece ilk açılışta sorulur, sonra bir daha sorulmaz.

Ardından **kurulum sihirbazı** (`/setup/local-server`) açılır — model kaynağını
seçmenin ana yolu budur. Üç adımda ilerler:

1. **Sunucuyu bul / kur:** bilgisayarında kurulu yerel sunucuları (Ollama, LM
   Studio, llama.cpp, Jan, vLLM...) bulur; hiçbiri yoksa kurmana yardım eder
   (Ollama önerilir). Yalnızca bir bulut sağlayıcı kullanacaksan sihirbazı
   atlayabilirsin — ama o zaman **Ayarlar → Sağlayıcılar**'dan bir sağlayıcı
   ekleyip etkinleştirmen gerekir, yoksa sohbet yanıt veremez.
2. **Sohbet modelini seç:** sunucunun listelediği modellerden birini seçersin
   (tek model varsa kendiliğinden seçilir); o sağlayıcı ve model sohbet ile
   üretim için varsayılan olur.
3. **Arama (embedding) seç:** sunucuda bir embedding modeli varsa
   (Ollama'da `bge-m3` önerilir; yoksa indirme düğmesi çıkar) onu seçebilir
   ya da **"Yalnızca anahtar kelime araması"**nı seçebilirsin — bu durumda
   anlamsal arama kapalı olur, notlar anahtar kelimeyle aranır. Sonradan
   değiştirmek için **Ayarlar → Sağlayıcılar**.

Sihirbazı sonradan yeniden çalıştırmak için **Ayarlar → Sağlayıcılar**
sayfasındaki "Kurulum sihirbazını yeniden çalıştır" bağlantısını kullan.

## 6. Notlarını içeri aktar ve indeksle

1. Uygulama içinde **Ayarlar → Kütüphane** içindeki içe aktarma ile (Obsidian, Zettlr gibi
   uygulamalardan bir Markdown klasörü de olur)
   notlarının olduğu klasörü göster.
2. Sohbet edebilmek için notların önce aranabilir hale getirilmesi (indeks)
   gerekiyor — bu adım şu an sadece kaynak koddan çalıştırılan geliştirici
   akışında (`npm run index -- --vault <id>`, kasa kimliği Ayarlar →
   Vault'lar'da) elle tetikleniyor; paketlenmiş sürümde bu adım
   otomatikleştirilmedi. Kaynak koda erişimin yoksa, bu konuda bize
   ulaş — bu rehberin bir sonraki sürümünde bu adım da kapatılacak.

## 7. Claude'a bağlamak (isteğe bağlı, yalnızca kaynak koddan)

Claude Code veya Claude Desktop'ı kasana bağlayabilirsin. Claude notlarını
arayabilir, okuyabilir, kasa oluşturabilir ve kaynak içe aktarmak üzere
bekleyenlere ekleyebilir. İçe aktarılan kaynak, sen uygulamada onaylayana kadar
kütüphaneye girmez; Claude bunu kendisi onaylayamaz. Yazma araçları uygulama
açıkken çalışır. **Bugün MCP sunucusu paketli masaüstü uygulamasının içinde
değil**; kaynak kod deposundan `node` ile çalışır:

```bash
claude mcp add --scope user vault-chat -- node "<repo yolun>\mcp\launch.mjs"
```

Claude Desktop için `npm run mcp:config` çıktısını
`%APPDATA%\Claude\claude_desktop_config.json`'a ekle. Kurulu uygulamanın
verisini kullanmak için `DATA_DIR` o klasörü göstermelidir.

Araçların listesi, otomatik onay ayarı (`off` / `clean` / `all`) ve güvenlik
notları için `README.md`'nin "MCP Sunucusu" bölümüne bak.

## 7b. macOS ve Linux (yeni, beta)

> **Beta uyarısı:** macOS ve Linux paketleri yeni. CI'da derleniyor ama
> **henüz gerçek bir Mac'te ya da Linux makinesinde denenmedi**; Windows kadar
> olgun değil. macOS paketi **imzasız** ve Apple noter onayından geçmedi.
> macOS için adım adım deneme listesi: `docs/macos-deneme-listesi.md`.

Ortak noktalar (Windows'taki gibi): Node.js 22 ayrıca kurulu olmalı, bir model
kaynağı gerekir (Ollama önerilir — https://ollama.com), kurulum sihirbazı (Adım 5)
aynı şekilde açılır. Fark: sihirbaz macOS/Linux'ta `winget` gibi bir komutu
senin yerine çalıştırmaz; yalnızca hangi komutu çalıştıracağını gösterir.

### macOS

1. Hangi dosya? Apple menüsü → **Bu Mac Hakkında**: "Çip: Apple M…" ise
   `vault-chat-macos-arm64`, "İşlemci: Intel" ise `vault-chat-macos-x64`.
   macOS 11 ya da daha yenisi gerekir.
2. `.dmg` dosyasını aç, `vault-chat`'i **Applications** klasörüne sürükle.
3. **Gatekeeper:** uygulama imzasız olduğu için ilk açılışta macOS engelleyebilir
   ("geliştirici doğrulanamadı" / "hasarlı"). Finder'da uygulamaya **sağ tık →
   Aç → Aç** de. Yine açılmazsa Terminal'de:
   ```
   xattr -dr com.apple.quarantine /Applications/vault-chat.app
   ```
   sonra tekrar aç.
4. **Node.js 22:** Terminal'de `node --version` yaz; `v22.` ile başlamıyorsa
   https://nodejs.org'dan 22 yükleyicisini kur ya da `brew install node@22`
   (nvm/fnm/Volta ile kurulu Node da bulunur).
5. **Anahtar Zinciri (Keychain) sorusu:** ilk açılışta ya da Ayarlar →
   Sağlayıcılar'da macOS "vault-chat, anahtar zincirinizdeki gizli bilgileri
   kullanmak istiyor" diye sorabilir — **Her Zaman İzin Ver**'i seç. API
   anahtarlarının şifreleme anahtarı Anahtar Zinciri'nde (`app.vaultchat.desktop`
   / `secrets-key`) saklanır.
6. **Python (isteğe bağlı):** PDF/doküman içe aktarma için Python 3.10+ gerekir
   (`brew install python@3.12`). Uygulamadaki **"Şimdi kur"** düğmesi sistem
   Python'una dokunmaz; veri klasöründe uygulamaya ait bir ortam (`python-venv`)
   kurup paketleri oraya yükler. Pandoc (yalnız `.tex` için) isteğe bağlıdır
   (`brew install pandoc`).

### Linux

1. Paketi seç: **`.deb`** (Debian/Ubuntu) ya da **`.AppImage`** (diğer
   dağıtımlar).
   - `.deb`: `sudo apt install ./<indirdiğin-dosya>.deb` — `libwebkit2gtk-4.1-0`,
     `libgtk-3-0`, `libayatana-appindicator3-1` ve `libsecret-1-0` bağımlılıkları
     kendiliğinden çekilir.
   - `.AppImage`: `chmod +x <dosya>.AppImage` ile çalıştırılabilir yap, çift
     tıkla ya da `./<dosya>.AppImage` ile aç.
2. **Node.js 22:** `node --version` `v22.` ile başlamalı. https://nodejs.org,
   nvm/fnm/Volta ya da dağıtımının paket yöneticisiyle kur. (Uygulama GUI'den
   açıldığında kabuğunun PATH'ini devralmaz; Node'u oturum kabuğunun PATH'inde,
   `/usr/local/bin`'de, `/usr/bin`'de, nvm/fnm/Volta klasörlerinde arar.)
3. **API anahtarları:** şifreleme anahtarı Secret Service'te (GNOME Keyring ya da
   KWallet) saklanır; masaüstü oturumunda anahtarlığın kilidini açman istenebilir.
   Sistemde böyle bir servis yoksa anahtarlar şifrelenmeden (yalnızca senin
   okuyabileceğin bir dosyada) saklanır ve Ayarlar → Sağlayıcılar'da sarı bir
   uyarı görürsün — GNOME Keyring/KWallet kurup uygulamayı yeniden başlatırsan
   şifrelenir.
4. **Python (isteğe bağlı):** Python 3.10+ gerekir. Debian/Ubuntu'da
   `sudo apt install python3 python3-venv` — **`python3-venv` olmadan** "Şimdi
   kur" düğmesi ortamı oluşturamaz. Düğme, macOS'taki gibi veri klasöründe
   uygulamaya ait bir ortam (`python-venv`) kurar.

### Verilerin ve günlüğün yeri

| | Veri klasörü |
|---|---|
| Windows | `%APPDATA%\app.vaultchat.desktop\` |
| macOS | `~/Library/Application Support/app.vaultchat.desktop/` |
| Linux | `~/.local/share/app.vaultchat.desktop/` |

Bir şey ters giderse bu klasördeki `launch.log` dosyası ipucu verir.

**Anahtar zinciri kilitliyse (kırmızı uyarı):** Ayarlar → Sağlayıcılar'da "kayıtlı
API anahtarlarının kilidi açılamıyor" uyarısı çıkarsa önce anahtar zincirinin
kilidini açıp uygulamayı yeniden başlat. Olmazsa **"Kayıtlı API anahtarlarını
sıfırla"** düğmesi eski dosyayı silmeden `secrets.json.locked-<tarih>` adıyla
yedekler ve uygulamayı yeniden başlatır; API anahtarlarını yeniden girmen gerekir.

**Kapanış (macOS):** uygulamayı Cmd+Q ile kapat. macOS'ta uygulama çökerse ya da
zorla sonlandırılırsa arka plandaki `node` süreci kalabilir (Linux'ta çekirdek bunu
temizler); Etkinlik Monitörü'nden `node`'u sonlandırabilirsin.

## Sorun giderme

- **Uygulama açılırken "Node.js bulunamadı" diyor** → Adım 2'yi tekrar
  kontrol et, `node --version` komutu `v22.` ile başlamıyorsa Node.js ya
  kurulmamış ya da yanlış sürüm kurulmuş.
- **Kırmızı "Yerel sunucu … çalışmıyor" uyarısı çıkıyor** → Sohbetin
  kullandığı yerel sunucu (Ollama, LM Studio, llama.cpp... — uyarıda adı
  yazar) kapalı demektir. Sunucuyu aç (Ollama için görev çubuğunda
  çalıştığından emin ol, kapalıysa Başlat menüsünden aç); uyarıda
  "Başlat" düğmesi varsa onu da kullanabilirsin. Birkaç saniye bekleyip
  "Tekrar dene"ye bas. Bulut sağlayıcı kullanıyorsan bu uyarı çıkmaz.
- **Turuncu "Kurulum tamamlanmadı" uyarısı çıkıyor** → Henüz bir sohbet
  modeli ayarlanmamış (sohbet zinciri boş). Uyarıdaki **"Kurulum sihirbazını
  aç"** bağlantısına tıkla ya da **Ayarlar → Sağlayıcılar**'dan bir
  sağlayıcı ekleyip etkinleştir ve varsayılan modelini seç.
- **Turuncu "gerekli model(ler) indirilmemiş" uyarısı çıkıyor** (yalnızca
  Ollama kullanıyorsan) → Adım 3.4'teki iki `ollama pull` komutunu tekrar
  çalıştır; uyarıda hangi modelin eksik olduğu ve tam komutu zaten yazılı.
- **Kurulum sonrası hiçbir kaynak bulunamıyor** → 6. adımdaki indeksleme
  henüz yapılmamış olabilir.
- **Cevaplar çok yavaş geliyor** → küçük bir ekran kartın varsa (6-8 GB) `README.md`'deki
  "Küçük GPU'lar için performans ayarları" bölümüne bak; birkaç ortam değişkeniyle
  belirgin hızlanma sağlanabilir.
- **PDF/doküman içe aktarma çalışmıyor, turuncu uyarı çıkıyor** → bkz. "3b.
  PDF/doküman içe aktarma için Python" — Python kurulu değil ya da gereken
  paket henüz kurulmamış; uyarıdaki "Şimdi kur" butonu bunu senin yerine
  halleder.
- **Ayarlar → Sağlayıcılar'da bulut sağlayıcıların (DeepSeek, OpenRouter,
  Groq, Google AI Studio...) model listesi gelmiyor veya bağlantı testi
  rastgele başarısız oluyor, ama o adresi tarayıcıda açtığında sorun
  yok** → antivirüs programın (Kaspersky, ESET, Avast/AVG, Bitdefender,
  Norton — hepsinde bu özellik var) muhtemelen "şifrelenmiş bağlantıları
  tara" özelliğini açık tutuyor ve giden bağlantıları kendi sertifikasıyla
  inceliyor; tarayıcın buna güveniyor ama uygulamanın arka planda kullandığı
  Node.js güvenmiyor. Çözüm: `certmgr.msc`'yi aç → *Trusted Root
  Certification Authorities* altında antivirüsünün sertifikasını bul →
  sağ tık → *All Tasks → Export* → "Base-64 encoded X.509 (.CER)" olarak
  kaydet. Sonra PowerShell'de uygulamayı başlatmadan önce
  `$env:NODE_EXTRA_CA_CERTS = "kaydettiğin-dosya-yolu"` yaz (kalıcı olması
  için Sistem Özellikleri → Ortam Değişkenleri'ne de aynı isimle ekleyebilirsin).

Bu rehberde olmayan bir sorunla karşılaşırsan, uygulamanın kendi log dosyası
`%APPDATA%\Roaming\app.vaultchat.desktop\launch.log`'da neyin yanlış
gittiğine dair bir ipucu bulunur.
