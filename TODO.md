# TODO

Vault Chat'in hedef listesi. Her çalışma oturumunun sonunda güncellenir.

**Son güncelleme:** 2026-10-10 · dal `docs/readme-vitrin`

## Kurallar

- **Dört kategori.** Bir madde aynı anda yalnız birinde durur:
  - **Acil:** kullanıcıyı ya da veriyi şu an etkileyen hata, kırık bir akış, ya da başka işi engelleyen şey.
  - **Yapılacak:** kararı verilmiş, kapsamı belli iş. Sıra en üstten başlar.
  - **Gelecek hedefleri:** yapılacağı kesin, ama zamanı ya da ön koşulu henüz gelmemiş iş (ör. "Qwen4 çıkınca", "repo public olunca").
  - **Acaba:** fikir ya da belirsiz istek. Önce bir ölçüm, bir deney ya da bir karar gerekiyor.
- **Madde biçimi:**
  ```
  - [ ] **Kısa ad.** Bir cümlelik açıklama. `kaynak: ertelenenler #N` · eklendi 2026-10-10
  ```
  - Büyük işler için sona `(B)` eklenir; küçük ve orta işler etiketsiz kalır.
  - Bir madde başka bir maddeyi bekliyorsa sona `← <kısa ad>` yazılır.
- **Oturum sonunda yapılacaklar:**
  1. Biten maddeyi listeden çıkar ve "Son tamamlananlar"a commit hash'iyle taşı.
  2. Oturumda bulunan yeni hata ya da fikri doğru kategoriye ekle.
  3. Kategorisi değişen maddeyi taşı (ör. Acaba → Yapılacak).
  4. "Son güncelleme" satırını güncelle.
- **Eleme.** Elenen madde silinir. Gerekçesi, varsa, ertelenenler belgesine "elendi" olarak işlenir.
- **Ayrıntı nerede tutulur:** Uzun bağlam bu dosyada tutulmaz. Ayrıntı ilgili belgededir (ör. `docs/dev/ertelenenler-2026-10-10.md`, ölçüm raporları); madde yalnız oraya işaret eder.

## Acil

_(boş)_

## Yapılacak

_(boş)_

## Gelecek hedefleri

_(boş)_

## Acaba

_(boş)_

---

## Son tamamlananlar

Yalnız son iki haftanın kaydı tutulur; daha eskisi git geçmişindedir.

- 2026-10-10: dil seti 23 dile çıktı (pcm, ar-EG çıktı; ko, it, nl, pl, cs, sv, nb, da, fi girdi). `6af6b6c`
- 2026-10-10: README için İngilizce demo görselleri ve markaya uygun mimari şema. `b09c434`
- 2026-10-10: ertelenen işler toplandı (88 madde). `docs/dev/ertelenenler-2026-10-10.md`
