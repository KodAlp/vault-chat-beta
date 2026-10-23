# vault-chat — macOS deneme listesi

Bu sürüm **deneme** sürümüdür: imzasızdır ve henüz hiçbir gerçek Mac'te açılmadı. Amaç, uygulamanın
bir Mac'te kurulup açıldığını, model sunucusuyla konuştuğunu ve API anahtarlarını Anahtar Zinciri'nde
(Keychain) sakladığını görmek. Her adımda **ne gördüğünü** yaz; beklenmeyen bir şey olursa ekran
görüntüsü al. "Çalışmadı" yerine "şu pencere çıktı, şunu yazıyordu" en faydalı cevaptır.

## 0. Hangi dosya?
- Apple menüsü → **Bu Mac Hakkında**. "Çip: Apple M1/M2/M3/M4" yazıyorsa → `vault-chat-macos-arm64`.
  "İşlemci: Intel" yazıyorsa → `vault-chat-macos-x64`.
- Zip'i aç; içinde `dmg/vault-chat_0.1.0_<mimari>.dmg` var.

**Bildir:** macOS sürümü (ör. 14.6), çip türü.

## 1. Kurulum
1. `.dmg`'yi çift tıkla; açılan pencerede `vault-chat`'i **Applications** klasörüne sürükle.
2. Applications'ta `vault-chat`'i aç. macOS büyük olasılıkla engelleyecek
   ("geliştirici doğrulanamadı" ya da "hasarlı").
3. Engellerse: Finder'da uygulamaya **sağ tık → Aç → Aç**. Yine açılmazsa Terminal'de:
   ```bash
   xattr -dr com.apple.quarantine /Applications/vault-chat.app
   ```
   sonra tekrar aç.

**Bildir:** hangi uyarı çıktı, hangi yöntemle açıldı.

## 2. Node.js
Uygulama Node.js 22 ister (pakete gömülü değil).
- Terminal'de `node --version` yaz. `v22.x` değilse https://nodejs.org adresinden **22 LTS macOS
  yükleyicisini** kur (ya da `brew install node@22`).
- Uygulama açılış ekranında "Node.js 22 gerekli" diyorsa ne yazdığını not et.

**Bildir:** `node --version` çıktısı, Node'u nasıl kurduğun (yükleyici / Homebrew / nvm), açılış ekranı
mesajı varsa metni.

## 3. İlk açılış ve kurulum sihirbazı
1. Açılış animasyonundan sonra karşılama ekranı ve **kurulum sihirbazı** gelmeli.
2. Sihirbaz bilgisayardaki yerel model sunucularını arar. En kolay deneme:
   - https://ollama.com'dan Ollama'yı kur, aç; Terminal'de `ollama pull qwen3:1.7b` (küçük model).
   - Sihirbazda Ollama'yı seç → sohbet modeli olarak `qwen3:1.7b` → arama için
     "**yalnız anahtar kelime araması**" (bge-m3 indirmek istemiyorsan).
3. Sağ üstte/üstte sarı ya da kırmızı bir bant var mı?

**Bildir:** sihirbaz hangi sunucuları buldu, hangi adımda takıldı, bant metni.

## 4. Anahtar Zinciri (Keychain) — en önemli adım
1. İlk açılışta ya da Ayarlar → Sağlayıcılar'a girdiğinde macOS
   "**vault-chat, anahtar zincirinizdeki gizli bilgileri kullanmak istiyor**" diye sorabilir.
   **Her Zaman İzin Ver**'i seç.
2. Ayarlar → Sağlayıcılar sayfasının üstünde **sarı** ("anahtarlar şifresiz saklanıyor") ya da
   **kırmızı** ("kayıtlı anahtarlar açılamıyor") bir uyarı var mı?
3. Uygulamayı tamamen kapat (Cmd+Q), tekrar aç. **Anahtar zinciri sorusu yeniden geldi mi?**
4. Terminal'de (yalnız var olduğunu görmek için; değeri gösterilmez):
   ```bash
   security find-generic-password -s app.vaultchat.desktop -a secrets-key
   ```

**Bildir:** soru kaç kez geldi (ilk açılış / her açılış), hangi düğmeye bastın, Ayarlar'daki uyarı
metni, `security` komutunun çıktısında "keychain:" satırı var mı. **Gerçek bir bulut API anahtarı
girme** — test için gerekmez.

## 5. Sohbet ve içe aktarma
1. Sohbete "Merhaba" yaz, sonra kısa bir soru sor. Cevap geliyor mu?
2. Kütüphaneye küçük bir `.md` ya da `.pdf` dosyası sürükle. Python yoksa sarı bir bant çıkmalı —
   "Şimdi kur" düğmesi varsa dene (uygulamaya ait bir Python ortamı kurar).
3. Dosyayla ilgili bir soru sor; cevabın altında kaynak görünüyor mu?

**Bildir:** cevap süresi kabaca, Python bandının metni, içe aktarma başarılı mı.

## 6. Kapanış ve arka plan süreçleri
1. Uygulamayı Cmd+Q ile kapat.
2. Terminal'de:
   ```bash
   ps aux | grep -i -E "vault-chat|node .*dist-server|ollama serve" | grep -v grep
   ```

**Bildir:** komutun çıktısı. (Ollama'yı kendin açtıysan onun kalması normal; uygulamanın açtığı
`node ... dist-server` kalmamalı.)

## 7. Günlük dosyası
Bir şey ters gittiyse şu dosyayı gönder:
`~/Library/Application Support/app.vaultchat.desktop/launch.log`
(Finder → Git → Klasöre Git → yolu yapıştır.)
