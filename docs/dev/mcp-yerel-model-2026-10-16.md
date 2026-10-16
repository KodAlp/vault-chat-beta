# Yerel modellerle MCP deneyi (#39) — 2026-10-16

## Düzen

- Betik: `bench/mcp-yerel-model.mjs`. Worktree'deki MCP sunucusunu stdio'dan başlatır (`mcp/launch.mjs`, `DATA_DIR` = kurulu uygulamanın AppData'sı) ve yalnız okuma araçlarını (`list_vaults`, `list_sources`, `list_domains`, `search_library`, `get_note`) Ollama'nın araç çağırma API'siyle modele verir. Yazma araçları verilmez, hiçbir şey yazılmaz.
- LM Studio kurulu değil; aynı modeller Ollama'dan (`/api/chat`, `tools`, sıcaklık 0, `num_ctx` 8192). LM Studio da MCP araçlarını aynı OpenAI biçimli şemayla modele verir, fark istemcinin araç sonuçlarını kesip kesmemesinde (burada 6000 karakterde kesildi).
- Modeller: `qwen3:8b` (Q4_K_M, 5,2 GB) ve `qwen3:4b` (2,5 GB), düşünme açık/kapalı. RTX 4050 6 GB.
- 10 görev, gerçek kasalardan cevabı bilinen sorular: Fizik (18 not), Rusça (2 not), indekslenmemiş Almanca. Puan: beklenen araç kullanıldı + cevapta beklenen anahtar ifade + kaynak notun yolu/adı geçiyor. "Kasa boş" görevinde doğru cevap uydurmamak.
- Sıcaklık 0'da iki tekrar birebir aynı çıktı (qwen3:8b), sonraki koşular tek tekrar. n=10 küçük: ±2 fark gürültü sayılmalı.

## Sonuç

| Model | Düşünme | Başarı (önce) | Başarı (sonra) | Araç hatası (önce → sonra) | sn/görev |
|---|---|---|---|---|---|
| qwen3:8b | kapalı | 3/10 | 4/10 | 5 → 1 | 24–42 |
| qwen3:8b | açık | 4/10 | 4/10 | 1 → 1 | 93–98 |
| qwen3:4b | kapalı | 8/10 | 6/10 | 0 → 0 | 60–65 |
| qwen3:4b | açık | 6/10 | 8/10 | 0 → 0 | 63–70 |

"Sonra": MCP sunucusunda kasa adı çözümleme ve hata ipucu (aşağıda). İlk 80 koşuluk matris (eski puanlama, 2 tekrar) aynı sıralamayı verdi: 4b > 8b.

## Gözlenenler

1. **qwen3:8b kasa kimliğini tahmin ediyor.** `list_vaults` çağırmadan `vault: "Fizik"` (ad) ya da `"default"` veriyor; hata alınca `list_vaults`'a dönmek yerine pes ediyor ya da kendi bilgisinden cevap veriyor. qwen3:4b 40 koşuda bir kez bile yanlış kimlik vermedi.
2. **Uydurma.** qwen3:8b (düşünme kapalı) kasa bulunduktan sonra bile `kuantum-liste`'de kasada olmayan 5 not başlığı icat etti, `stony-brook`'ta "18 not" dedi (doğrusu 3). Düşünme açıkken 4 görevden 2'sinde hiç araç çağırmadan kendi bilgisinden cevap verdi.
3. **`k=1` ile yanlış not.** Model `search_library`'yi `k=1` ve alan filtresiyle çağırıyor; Einstein denklemi sorusunda Carroll yerine kozmoloji notu geldi, model onun λ'lı Poisson denklemini "Einstein alan denklemi" diye sundu (kaynağı doğru belirterek).
4. **`get_note` çok büyük.** Notun tamamı dönüyor (Fizik notları yüz binlerce karakter); 8K bağlamda kesilince model aradığı denklemi bulamayıp genel laf ediyor (Friedmann). `get_note`'un bölüm/sayfa parametreleri var ama hiçbir model kullanmadı.
5. **qwen3:4b düşünme kapalıyken akıl yürütmeyi cevaba sızdırıyor.** 10 cevabın 10'u İngilizce "Okay, let's break down…" ile başlıyor; doğru bilgi sonda. Kullanıcıya gösterilecek cevap olarak kullanışsız. Düşünme açıkken temiz.
6. **Hız.** 8b düşünme kapalı görev başına ~25–40 sn, düşünme açık ~95 sn; 4b ~60–70 sn (düşünme kapalıyken de uzun akıl yürütme metni üretiyor).

## Yapılan düzeltme (MCP sunucusu)

- `mcp/vault-scope.ts`: `vault` argümanı, yalnız dışa açık kasalar arasında büyük/küçük harf duyarsız kimlik ya da ad tek bir kasaya çıkıyorsa o kasaya çözülür (`"Fizik"` → `fizik`). Kapalı kasalar eşleşmeye hiç girmez; İ6 kapısı aynı.
- Kasa bulunamadı / açık değil hatalarına erişilebilir kasaların listesi (kimlik — ad) eklenir; `list_vaults`'un zaten gösterdiğinden fazlası yok.
- `NOT_INDEXED` ve bayat indeks mesajları `npm run index` yerine uygulamadaki yolu söyler (Ayarlar → Kasalar → Yeniden indeksle); model bunu kullanıcıya aynen aktarıyordu.
- Etki: araç hataları 6 → 2. Başarı oranında ölçülebilir değişiklik yok; kasa hatası kalkınca model içerik aşamasında (madde 2–4) takılıyor.

## Öneri

- Yerel modelle MCP için **qwen3:4b, düşünme açık** en iyisi (8/10 ve 6/10, temiz cevap, kimlik tahmini yok). qwen3:8b bu araç setinde uydurmaya yatkın.
- Sunucu tarafında denenebilecekler (ölçülmedi): `search_library`'de `k` için alt sınır (ör. 3); `get_note` varsayılan olarak notun tamamı yerine başlık listesi + ilk bölüm, büyük notta bölüm/sayfa parametresini öneren bir ipucu.
- README / Ayarlar'daki "MCP istemcisine bağla" kartına yerel model notu: hangi model, düşünme açık, bağlam en az 8K.
