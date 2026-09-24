# Katkıda Bulunma

Katkılarınız için teşekkürler. Bu proje küçük, bireysel bir açık kaynak proje — süreç de buna göre hafif.

## Yerel kurulum

`README.md`'deki kurulum adımlarını izleyin. Testler (`npm test`) ve tip kontrolü (`npx svelte-check`) katkınızı göndermeden önce yeşil olmalı.

## Davranış kuralları

Bu projeye katkıda bulunarak `CODE_OF_CONDUCT.md`'yi kabul etmiş olursunuz.

## Developer Certificate of Origin (DCO)

Bu proje CLA (Katkıda Bulunan Lisans Sözleşmesi) yerine **DCO** kullanır — daha hafif bir süreç: her commit'inizin altına, o kodu yazmaya/göndermeye hakkınız olduğunu beyan eden bir satır eklersiniz.

`git commit -s` (`--signoff`) kullanmanız yeterli; bu, commit mesajınızın sonuna otomatik olarak şu satırı ekler:

```
Signed-off-by: Adınız Soyadınız <email@example.com>
```

Bu satır, [Developer Certificate of Origin 1.1](https://developercertificate.org/) metnini kabul ettiğinizi belirtir — özetle: bu katkıyı siz yazdınız (ya da yazma hakkınız var) ve açık kaynak olarak göndermeye yetkilisiniz.

`--signoff` olmadan gönderilen pull request'ler, birleştirilmeden önce bu adımı tamamlamanızı isteyecek şekilde geri döndürülebilir.

## Pull request süreci

1. Değişikliğinizi küçük ve odaklı tutun — bir PR bir konuyu ele alsın.
2. Yeni saf mantık için kendi testini ekleyin (proje testleri `node:test` ile, Vite/env bağımlılığı olmayan saf modüller için — bkz. mevcut `*.test.ts` dosyaları örnek olarak).
3. `npm test` ve `npx svelte-check` yerel olarak geçmeli.
4. Değişikliğin **neden** gerekli olduğunu PR açıklamasına yazın, yalnızca ne değiştiğini değil.

## Güvenlik açıkları

Genel bir issue yerine `SECURITY.md`'deki özel bildirim kanalını kullanın.
