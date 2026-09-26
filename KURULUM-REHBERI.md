# Vault Chat — Adım Adım Kurulum Rehberi

Bu rehber, Vault Chat masaüstü uygulamasını **sıfırdan bir Windows
bilgisayarına** kurmak isteyenler için yazıldı. Teknik bilgi gerektirmez —
her adımı sırayla uygulaman yeterli.

> Zaten geliştirici olarak kaynak koddan çalıştıracaksan (`npm run dev`
> vb.), bunun yerine repo kökündeki **README.md** dosyasına bak — bu rehber
> sadece paketlenmiş `.exe` kurulumunu anlatıyor.

## 1. Neye ihtiyacın var?

Vault Chat, kasandaki notlar üzerinde çalışan yerel bir yapay zekâ sohbet
uygulaması. İnternete ihtiyaç duymadan, bilgisayarının kendi işlem gücüyle
çalışır. Bunun için bilgisayarında iki şeyin **ayrıca kurulu** olması
gerekiyor — Vault Chat'in kurulum dosyası bunları kendisi kurmaz:

1. **Node.js 22** (uygulamanın arka planda çalıştırdığı motor)
2. **Ollama** + en az iki yapay zekâ modeli (sohbet ve arama için)

Aşağıdaki adımları sırayla takip et.

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

## 3. Ollama'yı kur

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
   aramak için kullanılan model (~1,2 GB). İkisi de inmeden uygulama
   düzgün çalışmaz.

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

1. Sana verilen `vault-chat_0.1.0_x64-setup.exe` dosyasını çalıştır.
2. Kurulum yönetici izni istemez, kendi kullanıcı klasörüne kurulur —
   "İleri" diyerek ilerlemen yeterli.
3. Kurulum bitince Vault Chat otomatik açılır (ya da Başlat menüsünden
   "Vault Chat" yazarak açabilirsin).

> **Windows "Bilinmeyen yayımcı" uyarısı verirse**: bu normal, kurulum
> dosyası henüz dijital olarak imzalanmadı. "Daha fazla bilgi" → "Yine de
> çalıştır" diyerek devam edebilirsin.

## 5. İlk açılış

Uygulama ilk kez açıldığında senden bir klasör seçmeni ister — bu, notlarını
tutacağın "kasa" için bir görünen isim belirlemek amaçlıdır (Obsidian
kullanıyorsan o vault klasörünü seçebilirsin, ama içeriği oraya
**kopyalanmaz**, sadece isim olarak kullanılır). İstersen boş bir klasör
seçip devam edebilirsin; gerçek notlarını sonradan uygulama içinden
**Ayarlar → Kütüphane → "Obsidian'dan İçe Aktar"** ile ekleyeceksin.

Bu seçim sadece ilk açılışta sorulur, sonra bir daha sorulmaz.

## 6. Notlarını içeri aktar ve indeksle

1. Uygulama içinde **Ayarlar → Kütüphane → "Obsidian'dan İçe Aktar"** ile
   notlarının olduğu klasörü göster.
2. Sohbet edebilmek için notların önce aranabilir hale getirilmesi (indeks)
   gerekiyor — bu adım şu an sadece kaynak koddan çalıştırılan geliştirici
   akışında (`npm run index -- --vault <id>`, kasa kimliği Ayarlar →
   Vault'lar'da) elle tetikleniyor; paketlenmiş sürümde bu adım
   otomatikleştirilmedi. Kaynak koda erişimin yoksa, bu konuda bize
   ulaş — bu rehberin bir sonraki sürümünde bu adım da kapatılacak.

## 7. Claude'a bağlamak (isteğe bağlı, yalnızca kaynak koddan)

Kasan indekslendiyse, Claude Code veya Claude Desktop'ı kasana salt-okunur
bağlayabilirsin — Claude notlarını arayabilir ve okuyabilir, hiçbir şeyi
değiştiremez. **Bugün yalnızca kaynak koddan çalıştırınca mümkün** (paketli
masaüstü sürümüne henüz eklenmedi):

```bash
claude mcp add --scope user vault-chat -- node "<repo yolun>\mcp\launch.mjs"
```

Claude Desktop için `npm run mcp:config` çıktısını
`%APPDATA%\Claude\claude_desktop_config.json`'a ekle. Ayrıntı: `README.md`'nin
"MCP Sunucusu" bölümü.

## Sorun giderme

- **Uygulama açılırken "Node.js bulunamadı" diyor** → Adım 2'yi tekrar
  kontrol et, `node --version` komutu `v22.` ile başlamıyorsa Node.js ya
  kurulmamış ya da yanlış sürüm kurulmuş.
- **Kırmızı "Ollama çalışmıyor" uyarısı çıkıyor** → Ollama'nın görev
  çubuğunda çalıştığından emin ol; kapalıysa Başlat menüsünden "Ollama"yı
  aç, birkaç saniye bekleyip uygulamadaki "Yeniden dene" butonuna bas.
- **Turuncu "gerekli model(ler) çekili değil" uyarısı çıkıyor** → Adım
  3.4'teki iki `ollama pull` komutunu tekrar çalıştır; uyarıda hangi
  modelin eksik olduğu ve tam komutu zaten yazılı.
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
