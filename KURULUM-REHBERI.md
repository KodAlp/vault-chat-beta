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
   akışında (`npm run index`) elle tetikleniyor; paketlenmiş sürümde bu adım
   otomatikleştirilmedi. Kaynak koda erişimin yoksa, bu konuda bize
   ulaş — bu rehberin bir sonraki sürümünde bu adım da kapatılacak.

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

Bu rehberde olmayan bir sorunla karşılaşırsan, uygulamanın kendi log dosyası
`%APPDATA%\Roaming\app.vaultchat.desktop\launch.log`'da neyin yanlış
gittiğine dair bir ipucu bulunur.
