# vault-chat — Öğrenme Ajanı ve Performans Yol Haritası

**Tarih:** 2026-09-20
**Kapsam:** Local Educational Agent spec'inin (63 bölüm) uygulamaya taşınması +
yerel LLM performansı + MinerU görselleri + slayt kalitesi + API sağlayıcı model listesi
**Durum:** F12 aşama 2, 3, 4 **uygulandı ve ölçüldü** (2026-09-20, §3). Aşama 1 (kalıcı
Ollama env, artık üç değişken) **uygulandı ve doğrulandı** (2026-09-20, §3). Aşama 5–6, F1–F9, F11, F13, F14 henüz uygulanmadı.

Bu belge `docs/ollama-latency-analysis.md`'nin (2026-09-18) **yerini aldı**; o dosya
kaldırıldı. Eski rapor "ölç, muhtemelen prompt boyutu" diyordu; ölçüm geldi ve teşhis
netleşti (bkz. §3). Hâlâ geçerli varsayımları buraya devşirildi: istek yolu ölçümü (§2),
bozuk çıktı retry'ı ve tool-call round-trip'leri (§3 aşama 4). Devşirilmeyenler ve
nedenleri: prompt boyutu hipotezi (ölçümle aşıldı), `num_ctx` şüphesi (F12 aşama 2'nin
kendisi), model swap/gate (§3'ün "zaten yapılmış" listesinde), Seçenek A maddeleri
(F12 aşama 1–5 olarak somutlaştı), Seçenek B runtime tablosu (§3 aynı sonucu tahminle
değil ölçümle kuruyor).

---

## 1. Durum

**Ana hat ile yan görev ayrımı.** Belgedeki kalemler eşit ağırlıkta değil:

| | Kalemler |
|---|---|
| **Ana hat** — öğrenme ajanının kendisi | F1 (learner model) → F2 / F3 → F6 (modlar); F7, F8, F9 destek |
| **Yan görevler** — ana hatta hizmet eder | **F12** (performans — *engelleyici*: %46 CPU offload çözülmeden hiçbir ölçüm anlamlı değil), F11 (MinerU görselleri), F13 (slaytlar), F14 (sağlayıcı model listesi — sıranın sonunda) |

Yan görev "ikincil" demek değil: F12 olmadan ana hat ölçülemez, F14 ana hattın bir
kısıtını kaldırıyor (bkz. F14-5). Sıra §6'da.

**Tamamlanan.** Educational Agent spec'inin prompt metnine çevrilebilen kısmı iki
klasör-skill olarak paketlendi ve uygulamanın kendi zod şemasıyla doğrulandı:

| Paket | Kapsam | Gövde | Ek dosya |
|---|---|---|---|
| `educational-agent` | `chat` | 4 089 krkt | 6 referans |
| `learning-generators` | `quiz`, `flashcards` | 2 375 krkt | — |

Yükleme: Ayarlar → Skills → zip. Ek dosyalar `read_skill_file` aracıyla,
**yalnızca sohbette ve yalnızca Ollama'da** okunabilir (`prompt.ts:64`,
`modelCaps`); beş üretici yalnızca SKILL.md gövdesini görür.

> "Yalnızca Ollama'da" bir tasarım kararı değil, **tek satırlık bir sabit**:
> `registry.modelCaps:146` bulut sağlayıcılarının hepsine `{tools:false}` dönüyor.
> F14-5 bunu kaldırabilir.

**Kalan.** Spec'in kod gerektiren kısmı — bir skill yalnızca prompt metnidir,
Memory (§18–22), Skill Graph (§23), Learning Signals (§24), Error tracking (§30)
ve Modes (§33) **durum** gerektirir. Bunlar §5'te F1–F9. Buna ek olarak, öğrenme
ajanından bağımsız ama yapılması gereken bir yan görev: **F14** — API sağlayıcı
model listesi.

**F10 kaldırıldı** (kullanıcı 2026-09-20'de doğruladı). Spec §40'taki
PDF/PPTX/Cheat Sheet/Question Bank/Exam listesi başka bir model tarafından örnek
olarak eklenmiş, gerçek gereksinim değil: mevcut beş üretici (quiz, cards, mindmap,
report, slides) zaten kaynak atfı yapıyor. **F10 numarası boş kalır** — geri çekilmiş
bir numarayı yeniden kullanmak eski atıfları sessizce yanlış yere yönlendirir.

---

## 2. Doğrulanmış sistem gerçekleri

Hepsi koddan veya canlı veriden okundu, dokümandan değil. Bir sonraki oturumun
yeniden keşfetmemesi için burada.

### İstek yolu — ölçüldü, fazladan network hop yok

```
client (SvelteKit UI) → aynı Node.js sürecinde çalışan +server.ts
  → chatWithFallback() → OllamaAdapter.chat()
  → fetch('http://127.0.0.1:11434/api/chat', {stream:true})   ← tek loopback hop
  → NDJSON satır satır okunup anında SSE olarak client'a proxy'lenir
```

Paketli (Tauri) sürümde sidecar olan şey **Ollama değil, Node.js sunucusunun kendisi**;
Ollama kullanıcının kendi kurduğu ayrı bir servis (`OLLAMA_URL=http://127.0.0.1:11434`).
İki hop da aynı makinede, loopback üzerinden. **"Raw Ollama'dan daha yavaş" hissi bir
network mimarisi sorunu olamaz** — bu soru kapandı, tekrar açılmasın.

### Donanım ve runtime

| | |
|---|---|
| GPU | RTX 4050, **6 GB VRAM** |
| RAM | 32 GB |
| `ollama ps` | `qwen3:8b · 7.8 GB · **46%/54% CPU/GPU** · 16384` |
| Model | Q4_K_M, ~5.2 GB ağırlık |

### Retrieval

| | |
|---|---|
| Embedding | `bge-m3`, 1024 boyut, prefix yok (`embed-config.ts`) |
| Neden nomic değil | Türkçe sorgular konuya değil **dile** göre kümeleniyordu; doğru not 154. sıraya düşüyordu |
| Vektör deposu | `sqlite-vec`, `distance_metric=cosine`, eşik **0.6** |
| İndeks boyutu | 330 dosya / **2 161 chunk** (`default` vault) |
| `k` | chat 12, quiz/cards/report 12, mindmap 16 (`DEFAULT_K=8` yalnızca fallback) |
| Keyword/FTS | **yedek olarak var (F5)** — `chunks_fts`; yalnızca vektör yolu boş dönünce ve yalnızca sohbette |
| Korpus dili | 329 İngilizce / 1 Türkçe; sorgular Türkçe → bilinçli cross-lingual |

### Chunking (`indexer/chunk.ts`)

- Bölme noktası `##` ve altı; **`#` bölmez**
- Hedef 1 400 karakter, sert tavan **2 048**
- `$$` ve ``` blokları atomik; boş satır yoksa kelime ortasından kesiliyor
- ≥%70 çıplak link olan bölüm indeksten **tamamen düşer** (`isNavigationOnly`)
- `title` yoksa dosya **hiç indekslenmez**

### Veritabanları

| DB | Tablolar |
|---|---|
| `chats.db` | `chats`, `messages` — **hepsi bu** |
| `study.db` | quizzes, quiz_items, attempts, attempt_answers, decks, cards, reports, report_sections, mindmaps, mindmap_nodes, slidedecks, slides |

Memory, skill graph, learner model, hata takibi tabloları **yok**.
Ham veri var ama toplanmıyor: `attempt_answers` **97 satır (86 yanlış / 11 doğru)**,
`quiz_items.source_path`'in **27/27'si** `index.db`'deki `files.path` ile eşleşiyor.

### Konvansiyonlar (uyulacak)

- Tablo: `CREATE TABLE IF NOT EXISTS`
- Sonradan eklenen sütun: **mutlaka** `ensureColumns()` (`src/lib/server/sqlite-schema.ts`)
- `user_version` yok, migration framework yok
- Sütuna `CREATE INDEX`, `ensureColumns`'tan **sonra** koşar — aynı `db.exec()`
  içinde bundle edilirse "no such column" ile patlar (belgelenmiş gerçek bug)
- Vault başına DB: `data/vaults/<id>/study.db`

### Bilinen kusurlar

- **`_meta` indeksleniyor.** `excluded-dirs.ts`'te yok; canlı indekste gövdesi
  `test` olan bir staging artığı retrieve edilebilir chunk olarak duruyor.
- **İndeks bayat.** 10 499 karakterlik chunk'lar var, oysa kod 2 048 uyguluyor —
  `hardSplit` düzeltmesinden önceki kalıntılar. `--full` rebuild gerekiyor.
- **`vault-rag-index/SKILL.md` güncel değil** — `nomic-embed-text`/768 diyor,
  gerçek `bge-m3`/1024.
- ~~**İndeksli dosyayı yeniden adlandırmak patlıyordu.**~~ ✅ Düzeltildi (`85d69e2`):
  `chunks.path`, `files.path`'e `ON UPDATE CASCADE` olmadan bağlı; `better-sqlite3` yabancı
  anahtarı zorunlu kıldığından `renameFileInIndex` chunk'ı olan her dosyada
  `SQLITE_CONSTRAINT_FOREIGNKEY` veriyor, üstelik `library.ts` dosyayı diskte çoktan
  taşımış oluyordu. F5 testi yazılırken bulundu. `defer_foreign_keys` + regresyon
  testleri (3'ü düzeltilmemiş kodda kırmızı).

---

## 3. F12 — Performans · **önce bu**

**Teşhis: sorun Node değil, prompt da tek başına değil — CPU offload.**

```
qwen3:8b   7.8 GB   46%/54% CPU/GPU   16384
```

Modelin **%46'sı CPU'da** çalışıyor. Bu hem prefill'i hem decode'u, yani her
token'ı yavaşlatır; büyüklük mertebesinde bir kayıptır. 16384 context'in
KV-cache maliyeti 6 GB karta sığmıyor.

### Ölçüm sonuçları (2026-09-20) — aşama 2–4 uygulandı

**Yöntem.** Kullanıcının Ollama'sına dokunulmadı: `OLLAMA_HOST=127.0.0.1:11435` ile
geçici ikinci bir `ollama serve` (aynı model klasörü), her basamakta ~2 800 token'lık
sabit prompt, `num_predict 128`, basamaklar arası `keep_alive:0`. Kontrol basamağı
teşhisi **birebir yeniden üretti** (`7.81 GB`, `%54.2 GPU`), yani merdiven geçerli.

| `num_ctx` | env | katman (GPU) | GPU % | decode tok/s | prefill tok/s |
|---|---|---|---|---|---|
| 16384 | yok (**eski hal**) | 20/37 | 54.2 | 7.2 | 1 028 |
| 8192 | yok | — | 63.6 | 8.9 | 1 137 |
| 4096 | yok | — | 70.5 | 11.2 | 1 221 |
| 16384 | FA + `q8_0` | 23/37 | 61.5 | 9.0 | 1 106 |
| **8192** | **FA + `q8_0`** | — | **70.4** | **12.4** | 1 229 |
| 6144 | FA + `q8_0` | — | 70.4 | 12.5 | 1 225 |
| 4096 | FA + `q8_0` | — | 72.7 | 13.3 | 1 267 |

**Bulgular.**

1. **%100 GPU bu kartta bu modelle ulaşılamaz — hiçbir `num_ctx`'te.** Ollama'nın kendi
   zamanlayıcısı bu kartta `available="4.5 GiB"` bütçesi ayırıyor (6 GiB'in 5.0'ı
   boş); `qwen3:8b Q4_K_M` ağırlıkları tek başına bunu aşıyor. `ctx` yalnızca **kaç
   katmanın GPU'da kalacağını** belirliyor (20 → 23 → …). Bu yüzden **§7'nin eski
   "%100 GPU" kabul kriteri yanlıştı** ve değiştirildi. Gerçek çıkış yolu aşama 6
   (quantization) — bkz. §8, karar bekliyor.
2. **Env ve ctx birbirini güçlendiriyor.** Tek başına ctx (16384→8192, env yok): +%24
   decode. Tek başına env (16384, FA+q8_0): +%25. İkisi birlikte (8192): **+%72**
   (7.2 → 12.4 tok/s), çünkü serbest kalan VRAM'e daha çok katman sığıyor.
3. **8192 dirsek noktası.** 6144 hiçbir şey kazandırmıyor (70.4 = 70.4); 4096 yalnızca
   +%7 decode verip sessiz baştan-kırpılma riskini büyütüyor. **Seçilen: `serveCtx = 8192`.**
4. **Prompt uzunluğu decode'u kabaca yarıya indiriyor.** Eski konfigürasyonda 8 362
   token'lık prompt ile decode **3.6 tok/s** (2 800 token'da 7.2). Bu, `k`'nın
   düşürülmesinin (aşama 3) gerekçesi: `k=12` ≈ 6k token `<context>` yalnızca
   gecikme değil, 8192 penceresine **sığma** sorunu da yaratıyor.
5. **`prompt_eval_cached_count` alanı yok.** Ollama 0.32.5'in son satırında yalnızca
   `total_duration`, `load_duration`, `prompt_eval_count/duration`, `eval_count/duration`,
   `done_reason` geliyor. Yol haritasının önceki metni olmayan bir alanı bekliyordu.

**Gerçek chat yolunda doğrulama.** İzole veri dizini (`DATA_DIR`) + hedef konfigürasyonla
geçici Ollama'ya bakan geliştirme sunucusu, gerçek `/api/chat` üzerinden: iki mesajda
`llm_timing` kaydı yazıldı (`numCtx: 8192`, `attempt: 0`, `toolRoundTrips: 0`,
`nearCtxLimit: false`), decode **10.2 ve 13.5 tok/s**, log'da metin gövdesi yok.

### Yeni bulgu — her turda iki model yüklemesi · **en büyük tek gecikme kalemi**

Sıcak ikinci mesajda bile `loadMs ≈ 5 000`, ilk token ~12 sn'de geliyor, oysa prefill
yalnızca 1.7 sn. Ollama logu iki chat turunda **dört model yüklemesi** gösterdi ve
sıra hep `bge-m3 → qwen3 → bge-m3 → qwen3`. Sebep Ollama'nın kendi zamanlayıcısı:
*"llama-server model predicted to exceed available memory, evicting"* (qwen3 @8192 için
öngörülen 6.0 GiB, uygun ~4.5 GiB). Yani takas `ollama-gate.ts`'in `keep_alive:0`
kuralından **değil**, VRAM kararından geliyor. Her tur: sorgu embed'i için `bge-m3`
yüklenir → qwen3 atılır → qwen3 ~5 sn'de geri yüklenir. **İlk tokenın gecikmesinin
yaklaşık %40'ı bu.** Bu, aşağıdaki "gate gereksiz tetikleniyor mu?" sorusunun
cevabı: hayır, gate değil, embed modelinin VRAM'de yer tutması. Çözüm **denenmedi**;
aday: embed'i GPU dışında çalıştırmak (`num_gpu: 0`). Bkz. §8.

### Kuantizasyon ölçümü (2026-09-20) — Q4_K_M'den küçük adaylar

**Amaç:** model boyutunu küçültmeden, çıktıdan fazla ödün vermeden hızlanmak. (Bir önceki planım Q4 vs
Q8'i kıyaslıyordu; yanlıştı — Q4 sığmıyorsa Q8 hiç sığmaz.) Resmî `Qwen/Qwen3-8B-GGUF` deposunda
Q4_K_M'den küçük dosya yok; adaylar `bartowski/Qwen_Qwen3-8B-GGUF`'tan (tek yayıncı, aynı imatrix ve
llama.cpp sürümü). Her dosyanın SHA256'sı indirmeden önce HF API'sinden alındı, indirdikten sonra iki kez
hesaplanıp **eşleştiği doğrulandı**. Modeller, resmî `qwen3:8b`'in TEMPLATE/PARAMETER/LICENSE'ını
**birebir kopyalayan** Modelfile ile paketlendi (özgün dosyadan yalnızca `FROM` satırı farklı, otomatik
kontrol edildi); `tools` ve `thinking` yetenekleri her adayda görüldü.

**Koşullar:** geçici Ollama (11435), `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `num_ctx 8192`,
temp 0. **Bu env sonradan kalıcı uygulandı (bkz. "Son doğrulama" aşağıda); bu ölçümler o zamana kadar yalnızca geçici sunucudaydı.**
KISA: ~80 token prompt → 128 token (n=5). UZUN: gerçek vault notu, ~3k token bağlam → 1 024 token (n=3).
Taban çizgi: kurulu resmî `qwen3:8b` (Q4_K_M). Sondaki taban çizgi tekrarı **−%1.8** sapma (eşik ±%10).

| Model | Boyut | GPU katman | GPU % | KISA decode tok/s | UZUN decode tok/s | UZUN süre | UZUN ilk token |
|---|---|---|---|---|---|---|---|
| **Q4_K_M** (resmî, taban) | 5.03 GB | 27/37 | 70.4 | 16.7 | 10.0 [9.3–10.2] | 105 sn | 2.6 sn |
| IQ4_XS | 4.56 GB | 30/37 | 77.5 | 22.2 (**+%33**) | 14.9 (**+%49**) | 71 sn | 2.1 sn |
| **IQ3_M** | 3.90 GB | **35/37** | 89.1 | **28.2 (+%69)** | **23.0 (+%130)** | **46 sn** | 1.8 sn |
| Q3_K_M | 4.12 GB | 33/37 | 84.8 | 27.6 (+%66) | 20.5 (+%104) | 52 sn | 2.0 sn |

KISA'daki "prefill tok/s" değerleri (83–168) anlamsız: ~80 token'lık prompt'ta istek başı sabit maliyet
baskın; yalnızca UZUN prefill'e bakılır (1 211 → 1 514 / 1 719 / 1 506 tok/s).

**Hız bulguları.**
1. **Hız, GPU'daki katman sayısıyla neredeyse doğrusal artıyor.** IQ3_M 35/37 katmanı GPU'ya sığdırıyor
   (tam sığma değil: 37/37 değil; "ağırlık ≲3.8–3.9 GB tam sığar" tahmini kabaca doğru, biraz iyimser).
2. **i-quant'ların CPU'da yavaş olacağı endişesi burada görülmedi**: IQ3_M'de yalnızca 2 katman CPU'da.
3. **Q3_K_M, IQ3_M'e göre dominated**: daha büyük, uzun işte daha yavaş, kalite göstergeleri daha kötü.
4. Aynı bulgu §3 tablosundaki F12 sonucunu güçlendiriyor: darboğaz CPU'ya taşan katmanlar. (Not: bu makinede
   Windows yalnızca **6 mantıksal işlemci** gösteriyor, `llama-server` `n_threads = 3` kullanıyor — gerçek
   i7-13700H 14 çekirdek/20 iş parçacığı. Nedeni belirlenemedi. CPU'da kalan katmanlar bu yüzden yavaş;
   kısıt kalkarsa Q4_K_M'in payı iyileşir ve fark daralabilir.)

**Kalite bulguları — hüküm değil, ipucu.**
- **Yayınlanmış veri** (eaddario, Qwen3-8B, KL-divergence vs F16; dosyalar özel katman-bazlı kuantizasyon,
  standart dosyalar değil, yalnızca eğilim): Q4_K_M **0.052**, IQ3_M **0.111**, Q3_K_M **0.162**. 3-bit,
  Q4'ün ~2–3 katı sapma taşıyor. IQ4_XS için doğrudan sayı yok; komşusu Q4_K_S 0.056.
- **Yerel çoktan seçmeli test** (`study.db`'den 32 madde × 2 seçenek sırası, n=64; doğru şık %56 ilk
  sırada olduğu için sıra karıştırıldı; **80 maddenin 48'i bozuk üretilmiş olduğu için elendi**):
  doğruluk **%56.3 / %57.8 / %56.3 / %51.6** (Q4_K_M / IQ4_XS / IQ3_M / Q3_K_M). Standart hata ≈ ±6 puan:
  **hiçbiri ayırt edilemez.** Q3_K_M en düşük (−4.7 puan, anlamlı değil) ve ortalama P(doğru)'su da en
  düşük (0.555 vs 0.624) — beklenen yönde ama zayıf. NLL(doğru) IQ3_M'de en iyi çıktı (2.48), Q3_K_M'de en
  kötü (4.09): **sınırlı örnekte ağır kuyruklu, gürültülü**.
- **Bu test 2× KLD farkını ayırt edemez** (düşük güç). "IQ3_M'de hasar görülmedi" ≠ "IQ3_M'de hasar yok".
- **Bozuk karakter (U+FFFD): hiçbir modelde 0.** Nadir bir olay; n bunu ölçmeye yetmez.
- **Otomatik bozulma kontrolleri** (CJK sızıntısı, Türkçe işaret oranı, döngü): hepsinde temiz. IQ3_M'in
  4-gram tekrar oranı yüksek çıktı (0.059 vs 0.025) — incelendi: **aynı SQL örneğini 6 kez yazması**, bir
  döngü değil. Kısa cevaplarda küçük yazım kaymaları hem Q3_K_M'de ("ağac") hem taban çizgide ("Dengelemiş")
  görüldü.
- **Çıktı-benzerliği metriği bilgisiz**: IQ4_XS bile taban çizgiyle UZUN'da yalnızca %1 ortak önek
  paylaşıyor (temp 0 çıktılar deterministik: taban çizginin iki koşusunda token sayıları aynı; farklı ağırlıklar
  ilk yakın eşitlikte ayrışıyor). Kalite göstergesi olarak kullanılmadı.

**Sonuç.** En hızlısı **IQ3_M** (UZUN görevde 105 → 46 sn); kalite bedeli yayınlanmış veriye göre gerçek
ama modest, yerel testte **tespit edilemedi**. Kalite hassasiyeti önceliğiyse **IQ4_XS** (kalitesi Q4_K_M'e
yakın, +%33–49). **Q3_K_M elenir.** Nihai kalite yargısı gerçek sorularla kullanıcıda: bu yüzden modeller
Ollama deposunda bırakıldı (`qwen3:8b-bart-iq4xs`, `qwen3:8b-bart-iq3m`, `qwen3:8b-bart-q3km`) ve
uygulamanın model seçicisinde görünür; **uygulamaya hiçbir model değişikliği yapılmadı**.

### Motorun VRAM güvenlik payı (`--fit-target`) — en büyük kaldıraç (2026-09-20)

**Düzeltme:** yukarıda "Ollama ~4.5 GiB bütçe ayırıyor" demiştim; bu yalnızca Ollama'nın **zamanlayıcı**
katmanının sayısı (`free 5.0 − minimum 457 MiB`). GPU'ya ağırlık+KV+tampon koyma tavanını asıl belirleyen,
motorun (`llama-server.exe`, llama.cpp) kendi **`--fit`** algoritması: varsayılan olarak cihazda **1024 MiB
boş bellek bırakmaya** çalışıyor (`cannot meet free memory target of 1024 MiB … target=4049 MiB`). Ollama
chat modellerini hiçbir `--fit`/`-ngl` bayrağı vermeden başlatıyor (yalnızca embed'e `-ngl 0`, yani
`num_gpu:0`'ın çevirisi), bu yüzden motorun varsayılanı geçerli. Model çalışırken `nvidia-smi`: 6141 MiB
toplam, 4147 kullanılan, **1775 MiB boş** — kart kullanılmadan kalıyor, tüm ölçümlerdeki `vramGB ≈ 4.2` tavanı bu.

**Motor bu payı ortam değişkeniyle alıyor: `LLAMA_ARG_FIT_TARGET` (MiB).** Ollama ortamı motora aktarıyor
(log: `free memory target of 256 MiB`, `target=4817 MiB`). Geçici Ollama, hedef konfigürasyon
(FA + `q8_0` KV), `num_ctx 8192`, aynı prompt, tek istek:

| Model | pay 1024 (varsayılan) | pay 512 | pay 256 |
|---|---|---|---|
| Q4_K_M (resmî) | 27/37 kat, **12.2** tok/s | 30/37, 15.3 (+%25) | 32/37, **18.1 (+%48)** |
| **IQ4_XS** | 30/37, 16.4 | 35/37, 28.8 (+%76) | **37/37 (%100 GPU), 39.9 (+%143)** |
| IQ3_M | 35/37, 24.7 | **37/37 (%100), 45.1 (+%83)** | 37/37, 45.2 |

- **Kaliteyi değiştirmez:** aynı ağırlıklar, yalnızca katmanların nerede koştuğu değişiyor. Resmî Q4_K_M bile +%48.
- **Güvenlik:** payı 256'ya çekince model yüklüyken `nvidia-smi` hâlâ **~1070 MiB boş** gösterdi (motorun "boş bellek"
  hesabı CUDA bağlamı vb. kadar kısmı zaten düşüyor). 9 istekte OOM/çökme yok. Ekranı Intel çizdiği için NVIDIA
  masaüstü belleği kullanmıyor; dGPU-only (MUX) moda geçilirse pay daha önemli olur.
- **Sonuç:** payı küçültünce IQ3_M'in IQ4_XS'e üstünlüğü %+100'den %+13'e iniyor, ama kalite riski IQ3_M'de.
  **IQ4_XS + pay 256 en iyi denge** (%100 GPU, ~40 tok/s, kalitesi Q4_K_M'e yakın).
- **Sonradan kalıcı uygulandı** (kullanıcı onayıyla, bkz. "Son doğrulama"). Ollama bunu belgelenmiş bir ayar olarak
  sunmuyor, motor ortam değişkeninin geçişi bir uygulama ayrıntısı; güncellemeyle değişebilir.

### Uygulama yolunda matris — 3 model × 3 bağlam (pay 1024, embed CPU'da)

| Model | ctx | GPU kat. | KISA decode | UZUN decode | nearCtx |
|---|---|---|---|---|---|
| Q4_K_M | 8192 / 6144 / 4096 | 27 / 27 / 28 | 13.1 / 12.7 / 12.9 | 10.6 / 9.9 / 11.9 | 0 / 1 / 3 (/8) |
| IQ4_XS | 8192 / 6144 / 4096 | 30 / 31 / 33 | 17.2 / 18.5 / 23.6 | 14.8 / 17.1 / 21.4 | 0 / 0 / 2 |
| IQ3_M | 8192 / 6144 / 4096 | 35 / **37** / **37** | 24.6 / 42.8 / 46.3 | 23.2 / 42.1 / 44.8 | 0 / 0 / 3 |

- Q4_K_M bağlam düşürmekten kazanmıyor (27→28 kat): darboğazı KV değil ağırlıklar. IQ3_M 6144'te tamamen GPU'da.
- **Bağlam 4096 güvensiz.** Kısa sorulardan biri **4 091 token'lık prompt** aldı (k=6 bile 4k'ya çıkabiliyor) ve
  Ollama `--context-shift --keep 4` ile başlatılıyor: pencere dolunca yalnızca ilk 4 token korunur, **sistem kuralları
  sessizce düşer**. 6144 sınırda (bir uzun cevap 4096 token'a dayandı). **8192 güvenli kalsın**; pay küçültmek
  bağlamı küçültmekten çok daha iyi bir yol.
- Embed CPU düzeltmesi: ilk token ~11 sn → ~2 sn, tur başı model yükleme ~5 sn → ~130 ms.
- Bozuk-çıktı yeniden üretimi: IQ4_XS 2/27 istek (ikisi de 8192 hücresinde), Q4_K_M 0/27, IQ3_M 0/27. n küçük.

### Kodun kendi varsayımı gerçekle çelişiyordu — düzeltildi

`src/lib/server/providers/ollama.ts` tablo yorumu şunu söylüyordu:

> *"serving at its full max costs VRAM (~4.2GB at 16384 already) … the failing
> real chat that motivated this table peaked at ~4.6k tokens … 16384 clears that
> with room to spare"*

Tablo **4.2 GB tahminiyle** yazılmıştı; gerçek **7.8 GB**. Yorum şimdi ölçülen
sayılarla yeniden yazıldı ve `serveCtx` `16384 → 8192`.

### Bozuk çıktıdan kaldığı yerden devam — uygulandı (2026-09-20)

Modelin çıktısında U+FFFD veya beklenmeyen bir Çince karakter belirince eski davranış
yanıtın **tamamını atıp baştan üretmekti**. Artık, koşullar uygunsa, temiz önekten devam
edilir (`resume-plan.ts`, `chat/+server.ts`).

**Kapı deneyi (kod yazılmadan önce, gerçek Ollama 0.32.5 + qwen3).** Sondaki yarım asistan
mesajı **devam ettiriyor**, ama üç bulguyla:

- qwen3 devamı `<think>` bloğunun *içinde* sayıyor: `</think>` yazıp yanıtı yeniden
  veriyor → `stop` dizileri şart (`RESUME_STOP`).
- Ön ek kelime ortasında bitince kelime bölünüyor → **dikiş**: istem son boşluğa kadar
  verilir, devamın başındaki (kullanıcının zaten gördüğü) kuyruk kırpılır; tutmazsa aynı
  dikiş en çok üç kez denenir, sonra baştan üretmeye düşülür.
- KV önbelleği ön eki yeniden kullanıyor (devam isteğinde prompt yeniden işlenmiyor).

**Ne zaman devam, ne zaman baştan:** yalnızca Ollama + doğrulanmış aile (qwen3), düz metin,
düşünce/araç yok, ≥120 karakter. Diğer her durumda **eski davranış aynen** (`planRecovery`
nedenleri: `reasoning`, `think-mode`, `has-thinking`, `tool-round-trips`, `tool-call`,
`unsupported`, `resume-limit`, `too-short`, `no-seam`). Devam isteği başka sağlayıcıya
**sıçramaz** (`chat-fallback.ts`: `continuation` ⇒ hata yükselir, rota baştan üretir).

**Sonuç.** Deterministik uçtan uca (sahte Ollama, 42 kontrol) geçti. Gerçek modelde bozucu
vekil ile 15 denemenin **14'ü baştan üretmeden kurtarıldı (%93)**. Ayrıca gerçek kullanımda
**ilk doğal Çince bozulması** günlüğe düştü — sorun teorik değil.

**Ölçüm.** `output_corruption` kaydı (yalnızca sayılar): tür, konum, tutulan karakter,
denemenin süresi (baştan üretmede *boşa giden*, devamda *korunan* süre), `action`.
`llm_timing`'e `resumeCount`. Sıklık ve maliyet artık günlükten okunur.

**Sınır.** Kullanıcıya gösterilmiş metin geri çekilemez (`delta` gitti); bu yüzden bozuk
yerden önceki son kelime sınırına dönülmez. Aynı token'ı yeniden üretme riski üst sınırla
(3 devam) ve baştan üretmeye düşerek karşılanır.

### Rust neden çözüm değil

| Node'un istek başına işi | Nerede çalışıyor |
|---|---|
| prompt birleştirme | JS, birkaç string concat |
| sorgu embed'i | Ollama'ya 1 HTTP çağrısı (iş bge-m3'te) |
| vektör KNN | `sqlite-vec` — zaten **native C** |
| filtreleme (`select-chunks`) | JS, birkaç yüz satırlık döngü |
| yanıt | NDJSON → SSE satır satır proxy |

CPU-bound JS yok. Sıcak olan iki parça çoktan native. 2 161 vektörde KNN
milisaniye mertebesinde. Mevcut Rust (Tauri kabuğu) süreç denetimi yapıyor ve
doğru yerde duruyor. **Backend'i Rust'a taşımak ölçülebilir kazanç getirmez.**

### Aşamalar

**1 — Ollama env · ✅ uygulandı (2026-09-20, kullanıcı onayıyla).** Üç kullanıcı-düzeyi değişken:
`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0` ve **`LLAMA_ARG_FIT_TARGET=256`** (bkz. aşağıdaki
"Motorun VRAM güvenlik payı"). Öncesinde üçü de ayarsızdı. Geri alma: her biri için
`[Environment]::SetEnvironmentVariable('<AD>', $null, 'User')` ve Ollama'yı yeniden başlat.
Kod tarafı (aşama 2–4) env olmadan da çalışır ve değer üretir; env üstüne binen ikinci ve büyük kazanç.

**Son doğrulama (2026-09-20)** — kullanıcının kendi Ollama'sında (11434), yeni ayarlarla, uygulamanın gerçek
`/api/chat` yolunda (izole veri dizin, kullanıcının `chats.db`'sine dokunulmadan), embed CPU'da, ctx 8192, k=6:

| Model | ilk token (kısa / uzun) | decode (kısa / uzun) | uzun görev süresi (medyan) | VRAM |
|---|---|---|---|---|
| **IQ4_XS** | **1.5 / 1.3 sn** | **40.8 / 39.6 tok/s** | **38 sn** (1 488 token) | 4.98 GB = tamamı GPU'da |
| Q4_K_M (resmî) | 1.9 / 1.7 sn | 19.0 / 18.0 tok/s | 96 sn (1 713 token)* | 4.92 / 6.01 GB (%82) |

\* Q4_K_M'in bir uzun cevabı uygulamanın 4 096 token üst sınırına dayandı (244 sn).

Başlangıç (embed GPU'da, env yok, Q4_K_M): ilk token **~11 sn**, decode 13.1 / 11.4 tok/s, uzun görev 118–190 sn.
IQ4_XS ile: ilk token **−%86**, decode **~3.1–3.5×**, uzun görev **~3–5× kısa**. Model yükleme/tur ~130–145 ms
(`bge-m3` 0 VRAM). Bu koşuda `nearCtx` 0/8 ve bozuk-çıktı bildirimi 0 (iki model de). Sunucu logu:
`free memory target of 256 MiB`, `target=4817 MiB`, `FLASH_ATTENTION:true`, `KV_CACHE_TYPE:q8_0`.
Önceki matriste IQ4_XS'te 2/27 istek bozuk çıktı nedeniyle yeniden üretilmişti; bu koşuda görülmedi
(n küçük, olay rastgele olabilir).

**2 — `serveCtx` · ✅ yapıldı:** `16384 → 8192` (`providers/ollama.ts`), yanlış "~4.2 GB"
yorumu ölçülen sayılarla yeniden yazıldı. Seçim gerekçesi §3 ölçüm tablosunda.

**3 — `k` · ✅ yapıldı, yalnızca chat:** `api/chat/+server.ts` `k: 12` → `CHAT_K = 6`.
Üreticiler (`generate-*.ts`, mindmap `k:16`) **dokunulmadı**: tek seferlik, geniş bağlamdan
kalite kazanan ve gecikmeye duyarsız çağrılar. **Bu bir kalite/gecikme takasıdır ve
kalite tarafını log ölçemez** — `k=6`'nın `k=12` kadar iyi cevap verip vermediğine
kullanıcı bakmalı; sabit tek satırda geri alınabilir. (Eski kodda `k: 12`'nin gerekçesi
"sohbette bir konuyu bütünüyle açıklamak tek bir quiz sorusundan az bağlam istemez"
idi; bu gerekçe reddedilmedi, gecikme ve pencereye sığma ile tartılıp aşıldı.)

**4 — Ölçümü kalıcılaştır · ✅ yapıldı:** `chat` yolunda her tamamlanan Ollama çağrısı
için `app-log.jsonl`'a `kind: 'llm_timing'` kaydı: `promptTokens`, `completionTokens`,
`promptMs`, `completionMs`, `loadMs`, `numCtx`, `nearCtxLimit`. (`prompt_eval_cached_count`
**yazılmadı: alan yok** — bkz. ölçüm bulgusu 5.) Ölü olan `usage` chunk tipi
(`types.ts`) ilk kez üretiliyor; saf ayrıştırıcı `providers/ollama-usage.ts`,
gerçek bir `done` satırıyla test edildi. **Kırpılma tespiti:** `nearCtxLimit`,
`prompt+completion ≥ %90 × numCtx` olan çağrıları işaretler — ctx düşürmenin sessiz
baştan-kırpılmaya dönüştüğü gün log'da görünür. Kapsam: yalnızca chat yolu; üreticiler
ve bulut adaptörleri loglanmıyor.

Aynı kayıt iki sayacı da **ek kod yazmadan** verir — ikisi de eski gecikme notundan
devşirilmişti:

- **Bozuk çıktı retry'ı:** `attempt > 0` olan kayıtlar (`retryReason` ile birlikte).
  Sınır: bozulmayla iptal edilen bir deneme son satıra hiç ulaşmadığı için kendi kaydını
  yazmaz; sonraki denemenin `retryReason`'ı iz bırakır ve harcanan süre görünmez.
- **Tool-call round-trip'leri:** `toolRoundTrips > 0` olan kayıtlar.

Bu ikisi henüz **ölçülmedi** — kayıt altyapısı var, veri toplanması gerekiyor.

**5 — Context compression.** Chunk'ın tamamı yerine sorguyla gerçekten ilgili
cümleleri gönder; BM25/cümle skorlaması ikinci bir LLM çağrısı gerektirmez.
**F5'in FTS tablosu bunun altyapısı** — ikisi birlikte planlanmalı.

**6 — Quantization · ✅ ölçüldü, karar bekliyor.** Eski satırdaki boyutlar yanlıştı (`IQ4_XS` ~4.3 GB
değil **4.56 GB**, `Q3_K_M` ~3.7 GB değil **4.12 GB**). Gerçek ölçüm ve sonuç için bkz. §3
"Kuantizasyon ölçümü". Q4→Q3'ün kalite bedeli yayınlanmış veriye göre gerçek (KLD ~2×).

Speculative decoding ve runtime değişimi (`node-llama-cpp`) bundan sonra gelir ve
muhtemelen hiç gerekmez.

### Zaten yapılmış — tekrar uğraşma

- **`/no_think` gereksiz.** Chat `think: body.think ?? false`, beş üreticinin
  hepsi açıkça `think: false`. Thinking varsayılan kapalı.
- **Tool schema yükü yok.** Tek tool var (`read_skill_file`), o da klasör-skill
  aktifken. "15 tool × 400 token" senaryosu uymuyor.
- **ANN/KNN tartışması konu dışı.** 2 161 vektörde exact KNN zaten ucuz.
- **`keep_alive: -1` mevcut tasarımla çelişiyor.** `ollama-gate.ts` bilerek
  `keep_alive: 0` kullanıyor ("single-large-model-in-RAM discipline") — 6 GB
  kartta doğru karar. ~~Bakılacak şey: aynı model art arda kullanılırken gate
  gereksiz tetikleniyor mu?~~ **Cevaplandı: gate değil.** Takas Ollama'nın kendi
  VRAM zamanlayıcısından geliyor (bkz. "Yeni bulgu — her turda iki model yüklemesi").

### Skill'lerin payı — ölçüldü

Aynı sorgu, aynı retrieval, tek fark `educational-agent` açık/kapalı (izole kopyada,
gerçek chat yolu):

| | prompt token | prefill | decode |
|---|---|---|---|
| skill **kapalı** | 1 549 | 1 723 ms | 13.5 tok/s |
| skill **açık** | 3 257 | 2 682 ms | 9.9 tok/s* |
| **fark** | **+1 708** | **+0.96 sn** | |

Önceki tahmin (~1 000 token) düşüktü. Gövde metni (4 089 karakter) yaklaşık 1 000
token tutar; **kalan ~700 token'ın kaynağı ölçülmedi.** En olası aday, klasör-skill
aktifken eklenen `read_skill_file` araç şeması ve skill'e eşlik eden ek sistem metni
— ama bu bir çıkarım. Doğrulamak için tek değişkenli bir ölçüm gerekir (aynı skill,
araç şeması olmadan). O zamana kadar "tool schema yükü yok" tespiti (yukarıda)
**çürütülmüş değil, doğrulanmamış** sayılmalı. `toolRoundTrips` iki ölçümde de 0
(model aracı çağırmadı).
\* Decode farkı **tek örnek ve karışık**: cevaplar farklı uzunlukta (305 vs 525 token).
Prefill farkı ise temiz (aynı girdi).

Kullanıcının kendi dosyaları ölçüm boyunca `enabled: false` kaldı (ölçüm izole
kopyada yapıldı).

---

## 4. Araştırmalar

### F11 — MinerU görsellerine içerik temelli ad verme

**Bulgu: içerik okuyup ad veren mekanizma yok.**

`tools/pdf2md.py` (vault deposunda) MinerU çıktısını olduğu gibi kopyalıyor:

```python
images_dir = md_path.parent / "images"
images_rel = f"{images_stem}_images"
shutil.copytree(images_dir, dst_images)
text = text.replace("](images/", f"]({images_rel}/")
```

Yalnızca **klasör** adı türetiliyor; dosya adları MinerU'nun 64 karakterlik
hash'leri olarak kalıyor. Kodun kendi yorumu doğruluyor: *"Windows MAX_PATH (260
chars) breaks on long source filenames combined with mineru's 64-char hash image
names"* — hash adlar bilinen ve tolere edilen bir durum, tasarım tercihi değil.

İki ek gerçek:

- **`raw/` altında şu an hiç görsel yok (0 dosya).** Bu kod yolu pratikte hiç
  çalışmamış. Adlandırma işine girmeden önce **nedeni bulunmalı** — yoksa
  çözülecek bir sorun olmayabilir.
- Uygulamanın kendi ingest hattı görselleri büsbütün atıyor:
  `ingest/postprocess.py`'deki `strip_html_remnants` tüm HTML'i siliyor (`<img>`
  dahil), `excluded-dirs.ts` `attachments`'ı indekslemiyor.

**Çözüm — ayrı bir Claude Code geçişi.** VLM gerektiği tespiti doğru ve bu
oturumda kanıtlandı (el yazısı Türkçe ders notu `Read` ile okundu):

```
raw/markdown/<domain>/<stem>_images/*.png
  → her görseli oku
  → kısa açıklayıcı ad üret (kebab-case, domain öneki)
  → çakışma kontrolü + sayısal sonek
  → dosyayı yeniden adlandır VE .md içindeki ](...) referansını güncelle
  → eşlemeyi sidecar'a yaz: <stem>_images/.names.json  {hash: yeni-ad}
```

Kritik noktalar:

- **Atomiklik** — önce tüm eşleme tablosu üretilir, doğrulanır, sonra rename +
  rewrite tek geçişte yapılır.
- **Idempotency** — `.names.json` sayesinde ikinci çalıştırma yeniden
  altyazılamaz; eşlenmiş hash atlanır.
- **Maliyet** — görsel başına bir VLM okuması. Bir kitapta yüzlerce figür
  olabilir; batch sınırı + checkpoint şart.
- **Doğrulama** — sonrasında markdown'daki her `](...)` referansının diskte
  karşılığı olmalı; kırık referans = başarısız geçiş.
- **`raw/` dokunulmazlığı** — vault'un `CLAUDE.md` invariant 1'i `raw/`'u salt
  okunur ilan ediyor. Bu iş onu ihlal eder. **Karar gerekiyor:** istisna açıkça
  yetkilendirilecek mi, yoksa çıktı ayrı bir dizine mi yazılacak?

### F13 — Zengin slaytlar

**Bulgu: slaytlar tasarım gereği düz metin. Üç sınır var, üçü de aşılabilir.**

**Sınır 1 — şema.** `slides-schema.ts` slayt başına iki alan tanıyor:

```ts
export const Slide = z.object({
  content_markdown: z.string().min(1),
  source_id: z.string().min(1)
});
```

Başlık yok, düzen yok, konuşmacı notu yok, görsel alanı yok.

**Sınır 2 — prompt.** `generate-slides.ts:142-143` daraltıyor: *"Her slaytta en
fazla 4-6 kısa madde işareti olsun, uzun cümleler kurma."*

**Sınır 3 — tema.** `buildMarpDeck` header'ı yalnızca `marp: true`. Ne tema, ne
yönerge, ne CSS — Marp'ın varsayılan temasıyla render ediliyor.

**Tıkaç:** görsel gömmek bugün imkânsız; ikili dosya servis eden route yok.
`api/library/file` JSON içinde `raw` metin döndürüyor, `![](...)` çözülemez.

**Yol — artan maliyetle üç adım:**

1. **Şemayı genişlet** (en yüksek getiri/maliyet):

   ```ts
   const Slide = z.object({
     layout: z.enum(['title','bullets','two-column','quote','diagram','code']),
     heading: z.string().min(1),
     content_markdown: z.string().min(1),
     notes: z.string().optional(),
     source_id: z.string().min(1)
   });
   ```

   `buildSlidesJsonSchema`'daki `enum` tekniği (GBNF grammar için `pattern`
   yerine `enum`) `layout` için aynen kullanılır. "4-6 madde" kısıtı düzene göre
   değişir: `bullets` için geçerli, `quote`/`diagram` için değil.

2. **Marp teması ekle.** `buildMarpDeck` header'ına `theme:` ve global
   yönergeler. `DESIGN.md`'deki gözlemevi sistemi (koyu zemin, tek yeşil accent,
   Fraunces / Schibsted Grotesk / IBM Plex Mono) zaten tanımlı; slayt teması
   oradan türetilirse ürün kimliğiyle tutarlı olur. `layout` → Marpit sınıfları
   (`<!-- _class: lead -->`).

3. **Görseli raster değil vektör üret.** İkili route açmak yerine diyagramı
   **satır içi SVG** veya Mermaid olarak ürettir — dosya servisi gerekmez, tema
   renklerini devralır, ölçeklenir. `mindmap-validate.ts` + `markmap` deseni
   bunun kanıtı: yapılandırılmış çıktı → zod doğrulama → istemcide render zaten
   çalışıyor.

   Gerçek görsel (fotoğraf, taranmış figür) ayrı bir iş: ikili route + içerik
   tipi doğrulaması + path traversal koruması — ve **F11'in çıktısı buna girdi**.

**Bağımlılık:** adım 3'ün gerçek-görsel kolu F11'e bağlı; diyagram kolu bağımsız.

---

## 5. Spec özellikleri (F1–F9)

### F1 — Learner model & skill state (§23, §24) · temel

Hammadde hazır: `attempt_answers` 97 satır, `quiz_items.source_path` 27/27
`index.db`'deki `files.path` ile eşleşiyor → domain/level iki DB arasında
`ATTACH` ile türetilebilir.

```sql
CREATE TABLE IF NOT EXISTS skill_nodes (
  id TEXT PRIMARY KEY,            -- 'math/calculus/integration-by-parts'
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  parent_id TEXT REFERENCES skill_nodes(id),
  source_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
-- append-only zaman serisi: §18 "eski değer yok edilmez"
CREATE TABLE IF NOT EXISTS skill_state (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skill_nodes(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  mastery REAL NOT NULL,
  recall REAL, understanding REAL, application REAL,
  analysis REAL, synthesis REAL, transfer REAL, retention REAL,
  evidence_count INTEGER NOT NULL,
  origin TEXT NOT NULL            -- STATED | OBSERVED | INFERRED  (§20)
);
CREATE INDEX IF NOT EXISTS idx_skill_state_skill ON skill_state(skill_id, observed_at);
```

Spec §23 formülü bilinçli boş bırakmış. v1 için savunulabilir bir taban:
`mastery = Σ(wᵢ·signalᵢ) / Σwᵢ` — ağırlıklar recall .15, understanding .20,
application .25, analysis .20, transfer .20. Her sinyal o eksendeki doğru/toplam
oranının Laplace düzeltilmiş hâli `(correct+1)/(total+2)`, az kanıtla aşırı
güvenden kaçınmak için. `evidence_count` her zaman raporlanır.

Yeni: `src/lib/server/learner-model.ts` (saf fonksiyonlar) + `learner-model.test.ts`.
Şema `study-db.ts`'e. Backfill: `scripts/backfill-learner-model.ts`, `--dry-run`.

### F1a — Quiz üretici: kopya, seçeneksiz soru ve bileşim hatası · ✅ düzeltildi (2026-09-21)

F1'in kanıtı quiz cevaplarından gelecek; bu yüzden önce soruların kendisinin geçerli olması gerekiyordu. Etiket deneyi sırasında görülen tekrarlar kök nedeni aramaya götürdü.
Hepsi gerçek veride **salt okunur ölçüldü**; düzeltme aynı konularda, **izole** sunucuda gerçek `/api/generate/quiz` üzerinden karşılaştırıldı.

**Bulgular (mevcut kod).**
- **Aynı sorunun tekrarı:** ham metin eşitliğiyle gerçek sınavlarda **%14** (18/129), deneyde **%35** (14/40). ≤5 soruluk 13 sınavda **hiç yok**; kopyalar yalnızca çok partili sınavlarda ve **sonraki partide** (deneyde 20 sonraki-parti sorusunun 14'ü, %70).
  Neden: önceki soruların **tam metni** "AYNI SORUYU TEKRAR ÜRETME" diye prompt'a yapıştırılıyordu; küçük model listeyi örnek alıp geri yazıyordu.
- **Seçeneksiz çoktan seçmeli:** gerçek 80 sorunun **46'sında** (%58) seçenek listesi yok (deneyde 24'ün 18'i): `options` hem zod'da hem JSON şemasında isteğe bağlıydı → cevaplanamayan soru; ayrıca 7'sinde seçenek sayısı 5 değil.
- **Bileşim:** 4/2/4 istendi, dört sınavın dördü **6/2/2** çıktı (karışık tür tek gramerde; doğrulama yalnızca toplam sayıyı sayıyordu).
- **Kaynak çeşitliliği:** havuz dar değildi (5–12 bölüm) ama 10 soru **2–3 bölümden** çıkıyordu; havuzun %20–30'u öğretici olmayan parçaydı (`wiki/_index` MOC, "> Related", "> Sources"); tüm indekste %17 (375/2161). İki sınav sorularını tam bu tür bir bölümden üretmişti.
- Doğru-yanlış "…kaçtır?" gibi soru cümlesi olarak üretilebiliyor; TF cevabı "False" (büyük harf) saklanırsa sayfanın gönderdiği "false" ile hiç eşleşmez.
- **Yakın-kopya TESPİTİ güvenilmez:** bge-m3 kosinüsü gerçek parafraz kopyaları (0,94–0,96) ile "aynı şablon, farklı sayı" meşru soruları (0,91–0,94) ayıramıyor; Jaccard şablon sorularda 1,00 veriyor → kopya **önlemeyle** çözüldü, tespit yalnızca kesin eşitlik için emniyet ağı.
- Kartlarda sorun yok (40 kart, 0 kopya).

**Düzeltme.** `quiz-batch.ts`, `quiz-schema.ts`, `quiz-validate.ts`, `quiz-pool.ts`, `quiz-dedupe.ts`, `generate-quiz.ts`:
- **Türe göre homojen partiler + gramerde tek `type`:** çoktan seçmelide `options` **zorunlu (5)**, doğru-yanlışta cevap `true|false` enum'u, açık/TF'de seçenek yok → bileşim yapı gereği tam.
- **Her sorunun kaynağı gramerle sabitlenir** (`prefixItems`, soru başına bir `source_id`; test edildi, Ollama destekliyor): çeşitlilik doğrulama+retry ile değil yapı gereği. (İlk denenen "aynı kimlikten en fazla N soru" doğrulama kuralı retry döngüsüne yol açıp bir partiyi kaybettirdi ve süreyi 3–4 katına çıkardı; bırakıldı.)
- **Tam metin "üretme" listesi kaldırıldı;** farklı kaynak parçaları görmeyen partiler aynı olguyu soramaz.
- **Öğretici parça filtresi:** dizin/MOC/_meta, "Sources/Related/See also/…" bölümleri ve <200 kr parçalar dışlanır (24 aday çekilir, 12 öğretici parça kalır).
- **Emniyet ağı:** kesin (harf/boşluk/noktalama duyarsız, **matematik korunur**, Türkçe İ/i noktası düzeltilmiş) tekrar düşer; eksik kalan türe **bir kez** kullanılmamış kaynak parçalarından tamamlama; dolgu yok, eksikse `done` olayında `requested/delivered` ve bildirim ("İstenen X, üretilen Y").
- **Doğrulayıcı** (`quiz-validate.ts`): 5 farklı seçenek, cevap seçeneklerden biri (harf etiketli "A) …" cevabı seçenek metnine çözülür), TF cevabı küçük harfe, TF ifadesi soru cümlesi olamaz, tür/sayı/kaynak-slot uyumu. Retry mesajı modele geri verilir.

| Ölçüm (izole, aynı 3 konu) | Eski kod (v0) | Yeni tasarım (v3, 6 sınav) |
|---|---|---|
| Aynı sorunun tekrarı | **11/30 (%37)** | **0/60** |
| Bileşim (4/2/4) tam | **0/3** | **6/6** |
| Seçeneksiz çoktan seçmeli | **8/20 (%40)** | **0/24** |
| Geçersiz doğru-yanlış | 1/6 | 0/12 |
| Sınav başına farklı bölüm | 2,7 | **9,8** |
| Süre (ortalama / medyan) | 106 / 108 sn | 163 / 140 sn |

Süre kabul kuralı (≤1,5×) ortalamada 1,54× ile 0,04 aşıldı; tek aykırı değer (dsa 318 sn), medyan 1,3×. Karşılığında çoktan seçmelilerin hepsi cevaplanabilir.

**Sınırlar (bilinmeli).**
- **Cevap anahtarının doğruluğu (36 çoktan seçmeli/doğru-yanlış soru, salt okunur ölçüm, izole veri):** iki kör kontrol: (1) anahtarı görmeyen bir çözücü (qwen3:8b, düşünme açık), (2) sorunun KENDİ açıklamasını okuyup hangi seçeneği desteklediğini söyleyen okuyucu.
  Çoktan seçmeli (24): çözücü anahtarla **20/24** uyuşuyor, açıklama anahtarı **24/24** destekliyor (yani "cevap 13, açıklama 7" türü iç tutarsızlık bu tasarımda 24'te 0). Doğru-yanlış (12): çözücü 10/12, açıklama 9/12.
  8 uyuşmazlığı tek tek okudum (öznel yargı): **1 kesin yanlış anahtar** (C'nin B'den devraldığı özellik: anahtar "işlemci bağımlı türler", açıklamanın kendisi C'de bağımsız hale getirildiğini söylüyor; asıl doğru büyük olasılıkla dizi-değer dönüşümü), **1 şüpheli** (sorgu yeniden yazımı "parse aşamasında": kaynağa özgü, genel bilgiyle çelişiyor), **2 kötü kurulmuş soru** (belirsiz "yaklaşımla tahmini algoritmaların zorlukları"; anlamsız kaynağa-özgü bir doğru-yanlış), **4'ünde anahtar doğru, çözücü ya da okuyucu yanılmış** (spectral teorem, io_uring, C'de çoklu tanım, consistent hashing).
  Sonuç: kesin anahtar hatası ≈ %3 (1/36), sorunlu soru (yanlış/şüpheli/belirsiz) ≈ %11 (4/36). **Çözücü uyuşmazlığı doğru/yanlış hakemi değil, "bu soruya bak" işareti** (6 uyuşmazlığın 3-4'ü gerçekten sorunlu). Açıklama okuyucusu "yanlış anahtar + gerekçelendirilmiş" durumunu göremez (açıklama anahtarı savunur).
  Yani "açıklamayı cevaptan önce yazdır" iyileştirmesinin hedeflediği hata (anahtar açıklamayla çelişir) bu örneklemde yok; kalan sorun soru kalitesi (Türkçe çeviri artefaktları: "yaklaşımla tahmini", "sayfa rootu", "yerden çıkarmak"; kaynağa özgü sorular). Aritmetik ağırlıklı (türev/integral) MC ayrıca ölçülmedi.
- **Repodaki son kodla uçtan uca doğrulandı** (izole sunucu, gerçek rota): 10 soruluk sınavlar 10/10, 0 kopya; **20 soruluk ölçek sınavı** (12/4/4) 20/20, 0 kopya, bileşim tam, 12 çoktan seçmelinin 12'sinde 5 seçenek, 12 farklı bölüm (12 parçalık havuz 20 soruya döngüyle dağıtıldı); `done` olayında `requested/delivered` geliyor. Süre 271–329 sn (Ollama'da kuyrukta bekleyen başka üretim vardı, ölçek sınavı temiz bir süre değil).
- İstenenden az soru / tamamlama yolu hiçbir sınavda tetiklenmedi (yalnızca birim testli). v1/v2 ayrıştırması yapılmadı: hangi parçanın ne kadar katkı verdiği ayrı ölçülmedi, yalnızca bütünün sonucu.
- Gerçek veride **18 tarihsel kopya** duruyor; öğrenen modeli kanıtı `(source_path, normalize soru)` ile tekilleştirecek.
- Eski 129 soru olduğu gibi kalır (yeniden üretilmez).
- **"Bu soru hatalı" işareti (kullanıcı, sonuç ekranında):** `quiz_items.flagged_at` (nullable; eski study.db'ler sütunu ilk açılışta alır). İşaretli soru bir daha sorulmaz (`GET /api/study/quizzes/[id]` süzer), görünen puandan hem pay hem paydadan çıkar (`scoreExcludingFlagged`), geri alınabilir (`PATCH /api/study/quizzes/[id]/items/[itemId]` `{flagged}`). **F1b kanıtından çıkarılacak** (henüz F1b yok; sözleşme: `flagged_at IS NOT NULL` olan soru kanıt sayılmaz). Nedeni: 36 soruluk elle okunan örnekte 1 kesin yanlış anahtar ve ≈ 9'da 1 sorunlu soru vardı ve yalnızca cevaplayan kişi hangisi olduğunu bilir. Uçtan uca 12/12 (izole sunucu, sütunsuz study.db kopyasıyla geçiş dahil); düğmenin tarayıcıda tıklanması yapılmadı (arayüz derlendi/tiplendi, API doğrulandı). Sebep/gerekçe alanı bilerek yok (v1).

#### Pipeline hata senaryoları: araştırma, kanıt, düzeltme (2026-09-21)

Soru: sınav kalitesi ve etiket sorunları **pipeline'dan mı, yerel modelin yetersizliğinden mi** geliyor? 8 hipotez önce **salt okunur** ölçüldü (129 gerçek + 156 A2 + 60 deney sorusu, gerçek indeks), sonra izole sunucuda üç varyant × 12 sınav (6 konu × 2 tekrar × 4/2/4) ve parti günlüğüyle karşılaştırıldı (`generate-quiz.ts` içine deney kopyasında sayaç). Kural: **kanıtlanmayan hipotez koda alınmaz.**

| Hipotez | Sonuç | İşlem |
|---|---|---|
| H5 sohbet bağlamı sorguya ekleniyor ("sohbet bağlamını kullan" kutusu **varsayılan açık**, `GenerationDialog.svelte`) | **Kanıtlandı:** konu sorgusuna sohbet özeti eklenince havuz neredeyse tamamen değişiyor (parça örtüşmesi 0,00–0,20; selamlaşma sohbeti bile). Üç otomatik düzeltme **ölçüldü ve elendi:** yalnız kullanıcı satırları (yine 0,00), "eşiği geçen yoksa sohbeti kullan" (konusuz istemler eşikte ayrışmıyor: en yakın parça 0,41–0,51, hepsi 0,6 içinde), vektör karışımı (iki ihtiyaç çelişiyor: konusuz istem için ağırlık ≥0,5, açık konu için <0,15) | Otomatik kural yok. **Kullanıcı kararıyla kutu varsayılan KAPALI yapıldı** (2026-09-21; aynı diyalog beş üreticide — sınav, kart, rapor, zihin haritası, slayt — ortak olduğu için beşi birden; hepsi sorguya aynı sohbet özetini ekliyordu, ölçüm yalnızca sınav üzerindeydi). Konusuz istemde ("bu konudan sınav yap") kutuyu kullanıcı işaretler |
| H7 doğru seçenek konumu | **Kanıtlandı:** A..E = 25/29/19/7/8 (n=88, χ²=22,2, p<0,001); eski gerçek 18/8/3/3/0 | Sunucu tarafı karıştırma (`quiz-options.ts`; cevap metinle saklandığı için güvenli). Canlı: 5/4/6/4/5 ve 7/5/2/3/7 (n=24, dağılım düz) |
| H4 retry/kayıp parti izlenmiyordu | **Ölçüldü:** parti başına ≈0,43 retry; 12 sınavda 4 parti kayıp. Retry'ların **yarısı (9–11/18) kimlik kuralımdan**, kayıpların çoğu da (veritabanları 10 yerine 6 soru, iki kez). v0 ve v1'de yakalanan 18 reddin **hepsinde** kimlik **açıklamada** (53 yer), soru/seçenekte 0 (v2'de seçenekte 1, canlı düğme-açık koşusunda 2 `id_in_question` reddi görüldü; onlar retry ile çözüldü): kaynakça niteliğindeki parçalarda model "S1 kaynakça, …" diye başlıyor ve retry'da tekrarlıyor | Açıklamadaki kimlik **kaynağın adına çevrilir** (`replaceSourceIds`), soru/seçenekte hâlâ reddedilir, notun kendi içeriğinde geçen kimlik ("Schedule S1") muaf; günlük: `generation_warning` `batch_retried/batch_lost` (yalnızca kod). Canlı (düğme kapalı): **60/60 teslim, kayıp 0, kimlik kaynaklı retry 0**, ortalama 189 sn (önce 240–258) |
| H1/H2 yuva dağıtımı tür-körü (`assignSlots`: açık uçlu sorulara her zaman en düşük sıralı parçalar S7–S10) | Mekanizma **kanıtlı**, etkisi **kanıtlanamadı:** açık uçlu cevapta >200 karakter oranı v0 %77, v1 (tür-duyarlı yuva) %56, v2 (v1 dahil) %69; birleşik %62'ye karşı %77, p≈0,1 | **Alınmadı** (`assignSlotsByType` yalnız deney kopyasında). Eski gerçek verinin kısa cevapları da sağlam kanıt değil (quiz başına medyan 2–158 kr) |
| H3 `source_path` bağlamda ("X kitabında …" soruları) | **Kanıtlanamadı:** kaynağa atıflı ifade v0 %6, v1 %8, v2 (yol gizli) %3 (4'e karşı 9, anlamlı değil); eski gerçek veride 0/129 | **Alınmadı** |
| H6 küçük havuz, büyük sınav | Yapısal olarak var (3 parçalık havuzda 20 soruda tek parça 7 kez kullanılır); canlı senaryo **çalıştırılmadı** | İşlem yok |
| Seçenekler birbirinden farklı değil | Retry'ların en büyük tek nedeni (12 çoktan seçmeli partiye 6–8): model 5. seçeneğe gelince son 2–3 seçeneği aynen tekrar ediyor (bozuk 12 soruda 3–4 farklı seçenek). Koddan onarılamaz (yeni seçenek uydurmak gerekir) | **Model sınırı**, retry çözüyor; bırakıldı |
| H8 varyans | Konu başına 2 tekrar; örneklem küçük (varyant başına 12 sınav) | Sonuçlar bu örneklemle sınırlı |

Ölçüm hataları (kendi hatalarım, kayda geçsin): ilk kimlik ölçümüm ("0/30") retry sayısını kaydetmediği için kuralın maliyetini gizledi; etiket deneyinin ilk parça eşlemesi Türkçe soru–İngilizce not yüzünden geçersizdi (kullanılmadı); "belirgin yol jetonu" H3 ölçütü konu kelimelerini yakaladığı için geçersizdi (kullanılmadı).

#### F1 etiketleri: 4 düzey, **düğmenin arkasında, varsayılan KAPALI, deneysel** (kullanıcı kararı)

Düzeyler `recall / understanding / application / higher`; **ayarlar sayfasında** "Sınav sorularını bilişsel düzeye göre etiketle (deneysel)" anahtarı (`Settings.quizLevelLabels`, tarayıcıda saklanır). Kapalıyken prompt, gramer ve saklanan satırlar **düzey özelliği yokken olanla bayt-bayt aynıdır** (`quiz-prompt.test.ts`: beklenen metin bir önceki commit'ten). Açıkken her sorunun hedef düzeyi türüne ve **kaynak parçanın uygulanabilirliğine** göre önceden atanır, gramerle sabitlenir (`prefixItems`, düzey `question`'dan önce), `quiz_items.cognitive_level` (nullable) içine yazılır. Sunucu yalnızca `levels === true` ise açar.

İki pipeline hatası düzeltildi (ikisi de yalnızca etiketin arkasında): **(1) düzey parçaya bakmadan dağıtılıyordu** — ilk deneyde "application" atanan 18 sorunun 15'i uygulanacak malzemesi olmayan parçadaydı ve model tanım sorusu yazıp etiketi üstüne bırakıyordu; şimdi böyle bir parçaya "application" atanmıyor (`chunkSupportsApplication`, dilden bağımsız yapısal işaret: matematik/kod/sayı işlemi/numaralı adım; indeksin %17'si; konu havuzlarında matematik %78, C ve veri yapıları %17, algoritma / işletim sistemi / veritabanları **%0**, yani üç konuda hiçbir soruya "application" atanamaz); atanan "application" soruları hakemce 3/4 ve 4/4 doğrulandı. **(2) çoktan seçmeliye "higher" atanıyordu** — iki ayrı koşuda hakem 1/6 ve 0/5 uyuştu (5/5'ine recall/understanding dedi), açık uçlu "higher" ise %64–91; çoktan seçmeli menüden çıkarıldı.

Ölçüm (60 soru/koşu, kör yeniden etiketleme, iki tanım sırası, sıcaklık 0; hakem aynı 8B model):

| | 6 düzey (önceki) | 4 düzey, parça-körü | 4 düzey, parça-duyarlı | + çoktan seçmelide "higher" yok (nihai) |
|---|---|---|---|---|
| 4'lü uyum (ters / düz sıra) | %40 (6'lı) | %48 / %47 | %47 / %57 | **%50 / %47** |
| hakemin kendi tutarlılığı | – | %63 | %63 | %57 |
| **kaba ayrım** hatırla-anla ↔ uygula-üst düzey: uyum | – | %82 / %78 | %72 / %73 | **%82 / %78** |
| kaba ayrımda hakem tutarlılığı | – | %83 | %88 | %87 |
| "yüksek" atananların hakemce de yüksek sayılması | – | %67 / %73 (n=30) | %60 / %75 (n=20) | %81 / %94 (n=16) |

**Kabul eşiği (4'lü uyum ≥%60) geçilmedi**, ama ölçümün kendisi bu hakemle çözünürlük sınırında: hakem kendi kendiyle yalnızca %57–63 tutarlı ve "recall" ↔ "understanding" arasında tanım sırasına göre gidip geliyor (recall %11 ↔ %53, understanding %68 ↔ %16). **Etiketin taşıdığı gerçek bilgi kaba ayrım** (≈%80, hakem tutarlılığı %83–88); ince ayrım (hatırlama/anlama) küçük modelde güvenilir değil. Elle okuma (öznel, 60 soru): sıkı sayımla 46/60 (%77), sınırdakiler yanlış sayılırsa 33/60 (%55). Ayarlar sayfasındaki uyarı bu sayıları söyler.

**Sınırlar:** örneklem küçük (koşu başına 60 soru, konu başına tek tekrar); hakem üretici ile aynı modeldir (öz-tutarlılığı ölçer, doğruluğu değil); pipeline ↔ model ayrımı **güçlü bir modelle yapılmadı** (notların API'ye gönderilmesi onay ister). Anahtar gerçek tarayıcıda 9/9 doğrulandı (varsayılan kapalı, tıklama, kalıcılık, yenileme, tr/en); **sınav penceresinin `levels:true` göndermesi tıklanarak denenmedi** (tip denetimi ve kod incelemesiyle doğrulandı, canlı rota `levels:true` ile denendi). F1b: eksenler yalnızca `cognitive_level` dolu sorulardan; öneri **kaba ayrımla (2 kutu)** raporlamak, 4'lü etiket saklanır.

### F2 — Hata takibi (§27, §30) · F1'e bağımlı

```sql
CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  skill_id TEXT REFERENCES skill_nodes(id),
  domain TEXT NOT NULL,
  pattern TEXT NOT NULL,          -- "overfitting ile underfitting karıştırılıyor"
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  resolved INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL     -- attempt_answer id listesi
);
```

`is_correct = 0` olan 86 cevaptan beslenir. Tüketiciler: `generate-quiz.ts` (§35),
REVIEW modu (§38), `generate-cards.ts` (§39).

> İsim tuzağı: `generate-errors.ts` hata takibi değil, `NoSourcesError` sınıfı.

### F3 — Memory (§18–22, §52)

```sql
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,             -- GLOBAL|PERSONAL|DOMAIN|EPISODIC|ERROR|PROBLEM|LEARNING_HISTORY
  domain TEXT,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  origin TEXT NOT NULL,           -- STATED | OBSERVED | INFERRED
  confidence REAL,
  evidence TEXT,
  created_at TEXT NOT NULL,
  superseded_by TEXT REFERENCES memory(id)   -- §21: sessizce silme yok
);
CREATE INDEX IF NOT EXISTS idx_memory_live
  ON memory(type, domain, key) WHERE superseded_by IS NULL;
```

§52 gizlilik kısıtı somut: `chats.db` zaten tüm ham mesajları tutuyor; memory
**ham konuşma saklamaz**, yalnızca türetilmiş olgu. Yazmadan önce oku, aynıysa
yazma (§21). Retrieval (§22): `prompt.ts`'e `buildMemoryBlock()` — task relevance
× importance × confidence × recency ile sıralı, karakter bütçeli.
Yeni: `src/lib/server/memory.ts`, `memory.test.ts`.

### F4 — Prerequisite graph (§28) · ✅ kod hazır, gerçek indekse HENÜZ uygulanmadı (2026-09-21)

**Ölçüm önce geldi** (default vault, salt okunur): `prerequisites` 289 notta var, **258'i boş değil**; 432 referansın
**tamamı** `[[wikilink]]` (yol değil) ve **432/432'si dosya adıyla tekil çözülüyor** — çift anlamlı 0, kırık 0, **döngü 0**.

**Bu yüzden plandaki iki nokta değişti:**

- **Yazma zamanında çözümleme yok.** `prerequisites_json` linkin hedef ADINI saklar ("np-completeness"), yol değil; yola çevirme
  grafik okunurken yapılır (`src/lib/server/prerequisites-query.ts`). Hedef not sonradan eklenir/yeniden adlandırılırsa, ona
  işaret eden notlar yeniden indekslenmeden doğru çözülür (testli).
- **`--full` yerine `npm run index -- --prereqs`.** Artımlı indeksleyici sha256 aynıysa dosyayı atlar; `--full` ise
  indeksi silip 330 dosyayı yeniden gömer — birkaç satır metadata için. `--prereqs` yalnızca frontmatter okur, sütunu doldurur,
  **gömme ve chunk yok**. `--dry-run` ile veritabanı salt okunur açılır: sütun bile eklenmez.

**Ne yapıldı**

- `indexer/prerequisites.ts` (saf, testli): `parsePrerequisites` (`[[x|alias]]`, `#başlık`, `klasör/x`, `.md`, tırnaksız YAML —
  `- [[x]]` YAML'da **iki katlı iç içe dizi** olur, düzleştirilir —, düz string, virgüllü liste; bozuk değer atılır, indeksleyici
  çökmez), `resolvePrerequisites` (çözülen / **çözülemeyen / belirsiz** ayrı raporlanır, tahmin edilmez), `findCycles`,
  `transitivePrerequisites` (en yakın önce, döngüde sonsuz döngüye girmez).
- `indexer/db.ts`: `files.prerequisites_json` (`CREATE TABLE` + `ensureColumns` — eski indeks `--full` gerektirmeden sütunu alır),
  `upsertFile`, `setPrerequisites`. İki yazma yolu (`indexer/index-vault.ts`, `src/lib/server/incrementalIndex.ts`) yeni/değişen
  dosyada alanı birlikte yazar.
- `src/lib/server/prerequisites-query.ts`: `loadPrerequisiteGraph`, `getPrerequisites`, `getPrerequisiteChain`,
  `findPrerequisiteCycles`. **Sütun yoksa hepsi `null` döner** — bu "önkoşulu yok" demek değildir (uygulama indeksi salt okunur
  açar, sütunu kendisi ekleyemez); çağıran "indeks yenilenmeli" demeli.

**Doğrulama.** 342/342 test, `svelte-check` 0 hata. **Gerçek indeksin izole kopyasında** (`DATA_DIR` kopya; vault indeksi yalnızca
`DATA_DIR`'den çözülür): kuru çalıştırma hiçbir şey yazmadı; uygulama 258 satırı güncelledi (72'si zaten `[]`); ikinci çalıştırma **0
değişiklik** (idempotent); çıktı ölçümle birebir (258 / 432 / 0 çözülemeyen / 0 belirsiz / 0 döngü); okuma tarafı 330 nota 432 kenar
verdi, en derin zincir 14 ("love-linux-kernel-development" → … → "c-history"). Gerçek indekste sütun yok, okuyucular `null` döndürüyor.

**Bekleyen (kullanıcı onayı):** gerçek indekste `npm run index -- --prereqs` (yalnızca `files` tablosuna sütun ekler ve 258 satırı
doldurur; gömme yok). Onaylanana kadar hiçbir şey okumuyor bu veriyi, bu yüzden zararsız.

**Dürüst not.** F4 tek başına kullanıcıya görünür bir şey üretmez: tüketicileri F1 (skill ağacı) ve F6 (REVIEW modu: "önkoşulu zayıf
konulara dön"). Şimdilik yalnızca doğru, ölçülmüş bir altyapı.

### F5 — Keyword/FTS fallback (§11) · ✅ uygulandı, bilerek küçük (2026-09-21)

**Ölçüm önce geldi.** Sohbet yolu `no_sources` **hiç yazmıyordu** (günlükteki "2/97" yalnızca
üreticilerden geliyordu); "vektör araması neredeyse hiç boş dönmüyor" iddiam veriyle
desteklenmiyordu — **düzeltiyorum**. Gerçek kullanıcı sorularıyla (93 tekil mesaj, indeks
*kopyası*, bge-m3 CPU'da):

| | |
|---|---|
| Vektör yolu boş dönen soru | **5 / 93 = %5,4** — hepsi selamlaşma ("Selam", "Naber", "Dene"…), neden `filtered` |
| Yedeğin bunlardan kurtardığı | **0 / 5** (selamlaşmanın FTS isabeti yok) |
| En yakın komşu mesafesi p50 / p90 / max | 0,463 / 0,570 / 0,645 (eşik 0,6) |
| İlk 18 komşunun gizli klasördeki payı | ortalama 2,6 / 18 |
| Kaynak sayısı dağılımı (0…6) | 5, 1, 1, 1, 1, 2, **82** |

**Sonuç: tetikleyici gerçek sorularda neredeyse hiç yok.** Plandaki kapıya göre F5 yine
uygulandı ama **küçük tutuldu**: altyapı + yedek + günlük; hibrit sıralama yok (F9 harness'ı
olmadan değerlendirilemez). Kazancı bugün için **kanıtlanmış değil**; asıl çıktı, artık
ölçülebilir olması.

**Ne yapıldı**

- `indexer/db.ts`: bağımsız `chunks_fts(heading_path, display_text)` (harici-içerik **değil** —
  silmelerde özel `delete` komutu tuzağı yok), `porter unicode61 remove_diacritics 2`,
  `rowid = chunks.id`. `upsertFile`/`deleteFile` aynı transaction'da senkron tutar. Mevcut indeks,
  yazma için ilk açılışta yeniden gömme **olmadan** doldurulur (`syncFts`; sayılar eşitse işlem
  yok). FTS5 yoksa uyarı verir, indeksleme durmaz.
- `keyword-query.ts`: her terim çift tırnaklanır (FTS5 sözdizimi enjeksiyonu etkisiz), durak
  sözcük atılır, en çok 12 terim.
- `retrieve()`: `opts.keywordFallback` (**varsayılan kapalı; yalnızca sohbet açar** — üreticiler
  açmaz: alıntıladıkları parçanın mesafeyle doğrulanmasına dayanırlar). Yalnızca `filtered` /
  `no-embedding-match` sonrası; `scope` **değil** (o "kapsamı genişlet?" demek). **Tek AND geçişi,
  yalnızca güncel mesajda, en az 2 terimle** (bkz. "Sonradan bulunan sorun"). Mesafe eşiği atlanır; kapsam, alan, gizli klasör ve dosya başı 3 sınırı aynen. `chunks_fts`
  yoksa sessizce kapalı.
- Günlük: `retrieval` (parça sayısı, `reason`, en iyi mesafe, `keyword`) — **sohbet ilk kez bunu
  yazıyor** — ve `retrieval_fallback` (`mode`, terim, isabet). Yalnızca sayılar.

**Doğrulama.** 293/293 test, `svelte-check` 0 hata. Kopya indekste `chunks` = `chunks_fts` = 2 161.
Vektör komşuları hiç olmayan bir alan + o alandan nadir terimle: yedek **kapalıyken 0 parça,
açıkken doğru dosyayı** buluyor; gizli klasördeki 18 isabet doğru şekilde 0 kullanılabilire
iniyor; `scope`'ta yedek devreye girmiyor; tablo yokken sessizce kapalı. İzole dev sunucusunda
gerçek sohbet: kaynak `via: keyword`, günlükte `retrieval_fallback` + `retrieval`; normal soruda
yedek tetiklenmiyor.

**Sınırlar (bilinmeli)**

- **Çapraz dil:** korpus 329 İngilizce / 1 Türkçe, sorgular Türkçe ⇒ eşleşme yalnızca ortak
  terimlerde (B-tree, TCP, kimlik adları, sayılar) çalışır. Sorguyu yeniden formüle etmek LLM
  çağrısı ister; yapılmadı — yol haritasının "3 iterasyon"u yerine tek AND geçişi.
- **Uygulama indeksi salt okunur açıyor**, tabloyu kendisi oluşturamaz: **mevcut indeks için
  `npm run index -- --fts`** (yalnızca doldurma, gömme yok) çalıştırılmalı. **Gerçek indekste
  çalıştırıldı (2026-09-21, kullanıcı):** `data/vaults/default/index.db`, chunks = chunks_fts = 2 161,
  yetim 0.

**Sonradan bulunan sorun: selamlaşmada alakasız kaynak (2026-09-21).** `--fts` açıldıktan sonra kullanıcı
"Merhaba" yazdı; kaynak listesi bir SvelteKit notuna gitti **ve model bunu cevaba işledi** ("Sizden
bahsettiğiniz içerik, web temelleri ve Svelte'in derleme zamanı felsefesi ile ilgilidir"). Neden: vektör yolu
selamlaşmada boş döner (yukarıdaki 5/93), yedek tam o anda çalışır, "merhaba" korpusta rastlantıyla tek bir
chunk'ta geçer ve anahtar kelime isabeti mesafe eşiğini atlar. Sorgu son 3 kullanıcı turundan kurulduğu
için önceki yazım hatalı tur ("Meerhaba") ikinci terim olup OR kipini açmıştı (günlük: `and:0 → or:1`).

İlk düzeltme (selamlaşma sözcüklerini durak listesine eklemek) **bırakıldı**: dil ve slang'e bağlı ("sup dawg",
"napıyon lan"), her dil için sürdürülemez. Yerine dilden bağımsız bir **kabul kapısı**
(`keyword-query.ts` `buildFallbackQuery`): tek bir rastlantısal sözcük kanıt değildir, aynı chunk'ta ≥2 ayrık
terimin birlikte geçmesi kanıttır. Yani **yalnızca AND ve ≥2 terim**; OR kaldırıldı; yedek sorgusu çok turlu
vektör sorgusu değil **yalnızca güncel kullanıcı mesajı** (`retrieve` `keywordQuery`).

| Gerçek indekste ölçüm (salt okunur) | Sonuç |
|---|---|
| Çok dilli 24 slang/selamlaşma mesajı, eski OR geçişi | **12 / 24** alakasız chunk'a isabet ("what the hell" 1 923, "hey there buddy" 105) |
| Aynı mesajlar, yeni kapı (32 mesajlık genişletilmiş batarya) | **0 / 32** isabet; 12'sinde yedek hiç çalışmıyor |
| Başlık-eşleşmesi kapısı (elenen aday) | 6 / 24 sızdırıyor |
| Gerçek çok terimli İngilizce sorgular ("FreeRTOS task scheduling", "big-o notation", "B-tree insert") | hâlâ isabet (9 / 14 / 62) |
| Kullanıcının 266 gerçek mesajı | 234'ü kapıdan geçiyor, yalnızca **3'ünde** birlikte-geçen isabet var |

**Bedel açıkça:** Türkçe sorular İngilizce korpusta iki terimle birleşmediği için yedek, karma-dil sorularda
pratikte neredeyse hiç çalışmaz; yalnızca kesin çok terimli eşleşmeleri kurtarır ve sohbetin dışında durur.
Faydası zaten ölçülmemişti (gerçek bir soruyu kurtardığı olay: 0); zararı gösterilmişti. Kalite için hibrit
sıralama F9 ölçümüne bağlı. Doğrulama: 297/297 test, `svelte-check` 0 hata. Ollama'lı uçtan uca yeniden deneme
yapılmadı (kullanıcı "Merhaba" / "sup dawg" ile deneyecek).

**Kaynaksız sohbet kapısı — vektör yolu (2026-09-21).** Yukarıdaki kapı yalnızca *yedek* yolu düzeltti; kullanıcının
gerçek denemesi ("Naber lan tipine çaktığım") **vektör aramasının kendisinin** sohbete de 6 kaynak getirdiğini gösterdi (mesafe
0,535 — gerçek sorulardan iyi; `keyword=false`) ve model kaynakları cevaba işledi. Mesafe ayırt etmiyor (sohbet 0,494–0,651, gerçek
sorular 0,318–0,569), durak listesi her dil ve slang için yanlış olur; bu yüzden kapı, `retrieve()`'in zaten hesapladığı sorgu
vektörünü bilinen sohbet ifadeleriyle karşılaştırır (`smalltalk-gate.ts`, saf; `smalltalk-store.ts`, `chats.db` — kullanıcı düzeyi,
vault'tan bağımsız; `smalltalk-runtime.ts`, yapıştırıcı). Karar: sohbet ise **kaynak aranmaz**, arayüz "Sohbet olarak algılandı,
kaynak aranmadı · Yine de kaynak ara" der.

| Ölçüm (gerçek vault, bge-m3, 2 016 negatif = 252 not başlığı × 8 biçim; 95 held-out sohbet) | Sonuç |
|---|---|
| İlk aday kural (tohum ≥ 0,65, korpus mesafesi ≥ 0,5) | 53/95 yakalar ama **13/2016 yanlış** (%0,64) — hep selamlaşma önekli tek sözcüklük konu ("selam asm nedir") → plan kriteri "0" sağlanmadı |
| Seçilen tohum kuralı: benzerlik ≥ **0,78**, korpus mesafesi ≥ 0,45 | **0/2016 yanlış**, marj 0,054; sohbetin 23/95'i (%24) — tohumlar yalnızca standart selamlaşmayı ilk seferde yakalar |
| Kişisel kayıt (kullanıcının kendi ifadesi): benzerlik ≥ **0,82** | 0/2016 yanlış, marj 0,094; yalnızca önceden görülenleri/varyantlarını yakalar ("Merhabaa" 0,91, "napıyon lan" 0,89) |
| Çok turlu pencere ("türev nedir \| devam et") | 0,34 → kaynaklar korunur (kapı, birleşik sorgu vektörüne uygulanır) |
| Tur başına maliyet | ≈ 0 (ek model çağrısı yok, birkaç yüz kosinüs); sohbet turunda ≈ 1,3–1,7 sn prefill tasarrufu; tohumlar bir kez ~3 sn, arka planda |

**Öğrenme.** Tohum bir mesajı yakalarsa (yalnızca en yeni, ≤ 80 karakterlik mesaj) otomatik kaydedilir. Kaçanları ("sup dawg",
"Naber lan tipine çaktığım" — tohum eşiğinin altında) tohum yakalamadığı için otomatik öğrenilemez: cevabın altındaki **"Kaynaklar
alakasız"** düğmesi öğretir. **Geri alma:** "Yine de kaynak ara" kapıyı atlar, mesajı *onaylı soru* olarak kaydeder (benzer her
mesaj bir daha sohbet sayılmaz) ve yanlış işaretleyen **öğrenilmiş** ifadeyi kapatır — tek bir mesaj yerleşik (tohum) ifadeyi
kapatmaz. Ayarlar → "Sohbet ifadeleri": liste, tek tek silme, hepsini temizleme. Kapatma anahtarı: `CHAT_SMALLTALK_GATE=0`.

**Doğrulama.** 325/325 test, `svelte-check` 0 hata; izole sunucuda (kopya indeks, ayrı `chats.db`) gerçek `/api/chat` üzerinden 12/12
senaryo: soğuk başlangıç (ilk tur beklemez, tohum arka planda), "Merhaba" → kaynaksız, yeni slang ilk seferde sızar, öğretildikten
sonra ve varyantı ("naber lan gööt") kaynaksız, "Selam bana türev anlat" / "dijkstra algoritması nasıl çalışır" / "türev nedir →
devam et" **kaynaklı**, "Yine de kaynak ara" sonrası aynı mesaj bir daha sohbet sayılmıyor, temizleyince bellek gerçekten boşalıyor.

**Sınırlar (bilinmeli).** Yeni bir slang cümlesi ilk seferde sızar (örn. temizlenmiş bellekle "Naber lan göt" 6 kaynak getirdi ve model
kaynaklardan özet uydurdu) — öğretilene kadar. Recall sayıları iyimser (eşikler veriyi gördükten sonra seçildi); güvenilecek olan
yanlış-işaret sayıları. Yanlış işaret sessizce topraksız cevap demektir; bu yüzden "Yine de kaynak ara" ve kayıtlar var
(`retrieval` günlüğünde `gateSim`/`gateVia`/`gateOverridden`, metin yok). Yeni bir eşiği yeniden doğrulamadan gevşetme.
"Yine de kaynak ara" v1'de aynı soruyu ikinci kez bir tur olarak gönderir (kullanıcı mesajı iki kez görünür). `smallTalk` bayrağı
sohbet yüklenirken geri gelmez (`narrowScope` gibi kalıcı değil).

**Prompt kuralı (ilk seferde sızan sohbet).** Kapı yeni bir slang'i ilk seferde kaçırınca kaynaklar prompt'a girer ve
`CORE_INVARIANTS`'taki "notları kullan / kapsamıyorsa söyle" kuralları modeli onları cevaba işlemeye iter (kayıtlı örnek:
"Naber lan göt" → "Bilgi kaynağına göre, Borg sisteminin…", 3 571 karakter). Bu yüzden `prompt.ts`'e tek satır eklendi:
"Selamlaşma, sohbet, argo, hakaret, teşekkür ya da deneme gibi mesajlara yalnızca o mesajın kendisine karşılık ver; notlardan
hiç söz etme." **Ölçüm** (kapı kapalı, izole sunucu, kopya `chats.db`; 12 sohbet mesajı × 4 örnek + 10 gerçek soru; her varyantta
36 kaynaklı sohbet cevabı):

| Varyant | bozuk/uzun sohbet cevabı | kuralı/prompt'u geri yazma | ort. sohbet cevabı | gerçek soru ort. uzunluk |
|---|---|---|---|---|
| kuralsız | **16** | 1 | 451 kr | 2 451 |
| "…`<context>` bloğunu yok say… **kısa** ve doğal…" | 2 | 1 | 64 | **1 587 (−%35)** |
| aynısı, "kısa" yok | 7 | **4** ("…bloğunu yok sayarak…") | 111 | 2 499 |
| **yayınlanan** (olumlu, bu kelimeler yok) | **1** | **0** | 44 | 1 896 (−%23) |

Yorum: "kısa" gerçek soruları kısaltıyordu, "yok say / `<context>`" sözcükleri modelin cevabında kural olarak geri yazılıyordu;
yayınlanan sürüm ikisinden de kaçınır. Gerçek sorularda 10/10 kaynaklı ve konuya uygun; uzunluk farkı tek örnekli ölçümde
gürültü içinde (aynı işlevdeki iki varyantta soru başına ±%50 oynadı), gerileme olarak kanıtlanmadı. Sistem prompt'unu geri
yazma (`gerizekalı` gibi hakaret mesajlarında "Kurallar: - Tüm matematiği…") kuralsız durumda görüldü, yayınlanan varyantta bu
48 örnekte görülmedi — ayrı bir hata olarak izlenmeli. Kural kaynak listesini düzeltmez; yalnızca cevabı temizler.

**F12 aşama 5** bu tablonun üstüne kurulabilir — birlikte planlanmalı.

### F6 — Mode sistemi (§33–39) · F1 + F3'e bağımlı

`chats`'e `mode TEXT NOT NULL DEFAULT 'free_chat'` (`ensureColumns`). `prompt.ts`
moda göre farklı blok birleştirir. EXAM (§36) QUIZ'den ayrı: çok konulu, puanlı,
sonrasında hata analizi → F2'ye yazar. REVIEW (§38): due kartlar + düşük mastery
+ uzun süredir tekrarlanmamış konular.

### F7 — Epistemik etiketler + UI (§10)

`prompt.ts` etiket üretimini **ister** (bugün istemiyor); ayrıştırıcı ve rozet
bileşeni aynı anda gelir. Ayrı giderlerse ham etiket metni transkripte sızar —
`ConfidenceBadge`'in ROADMAP'te reddedilme gerekçesi buydu ("üreticisi olmayan
ayrıştırıcı ölü kod olurdu"), bu sefer üretici de var.

Teslim edilen `educational-agent` skill'i bu yüzden bugün köşeli parantezli
etiket ürettirmiyor; ayrımı dilin içinde yapıyor. F7 ile birlikte açılır.

### F8 — Context yönetimi (§47)

Bugün yalnızca `retrieval-query.ts`'te `QUERY_TURNS = 3` var; konuşma sıkıştırma
yok. §47'nin önem sıralamasına göre koruma + sıkıştırma; kayıp görev doğruluğunu
etkileyecek seviyeye gelirse kullanıcıyı bilgilendirme.
**F12 ile aynı bütçeyi paylaşıyor** — birlikte ele alınmalı.

### F9 — Değerlendirme harness'ı (§53–61)

`npm test` 20+ dosya çalıştırıyor ama spec'in 9 test kategorisinin hiçbiri bağlı
değil. `tests/eval/` altında fixture + runner: hallucination, RAG grounding,
memory, personalization, teaching, conflict, **prompt injection** (§60 — RAG
belgesine "IGNORE ALL PREVIOUS INSTRUCTIONS" koyup davranışı ölçmek), regression.

---

## 5.5. F14 — API sağlayıcı model listesi · spec dışı yan görev

**Sorun.** Groq / OpenRouter / Google AI Studio gibi kanallarda seçim listesi işlevsiz
modellerle doluyor: kullanımdan kalkmış sürümler, embedding modelleri, VLM/TTS girdileri,
eski flash'lar. Liste hardcoded olmamalı, otomatik güncellenmeli.

Kod okunarak doğrulanmış iki düzeltme — ikisi de kapsamı değiştiriyor:

> **Checkbox listesi diye bir şey yok.** İki ayar sayfasında `checkbox` geçmiyor.
> Bugünkü kontrol, sağlayıcı başına **tek seçimlik** `defaultModel` select'i
> (`settings/providers/+page.svelte:405-419`) artı dört dropdown. Yani bu iş "mevcut
> listeyi filtrele" değil; **çoklu seçim arayüzü de yazılacak.**

> **`ctx` ve `caps` ölü yük.** `ProviderModelOption.ctx`/`caps`
> (`src/lib/types.ts:489-495`) hiçbir `.svelte` dosyasında ve sunucuda okunmuyor.
> Uydurma `ctx: 8192` bugün **yanlış karar üretmiyor** — tüketicisi olmayan bir kurgu.
> Onu düzeltmek ancak `modelCaps` bu veriyi okumaya başlarsa kazanca döner (F14-5).

### F14-1 — dürüst `listModels()` + timeout · en ucuz parça

`openai-compat.ts:422-437` yanıttan yalnızca `id` alıyor; `owned_by`, `created`,
`context_length`, OpenRouter'ın `architecture.modality`/`supported_parameters`,
Gemini'nin `supportedGenerationMethods` alanları çöpe gidiyor.

Ayrıca `:426`'daki `fetch`'in **signal'i yok** — kardeşi `health()` (`:441-443`)
`AbortSignal.timeout(connectMs)` kullanıyor. `models/+server.ts:14` `Promise.all`
olduğu için **tek takılı sağlayıcı tüm model endpoint'ini süresiz kilitliyor.**
Filtrelemeden bağımsız gerçek bir hata.

### F14-2 — katalog + cache

Canlı `/models` (anahtarla gerçekten çağrılabilenler) × katalog metadatası kesişimi;
hardcoded model adı listesi tutulmaz. Kaynaklar, ham JSON çekilerek doğrulandı:

| Kaynak | Ne veriyor |
|---|---|
| OpenRouter `/api/v1/models` | 446 model; `architecture.output_modalities`, `supported_parameters`, `context_length`, `created`. **Anahtar gerekmiyor.** |
| `models.dev/api.json` | Groq, Google, Mistral, DeepSeek, Anthropic, OpenAI; `modalities`, `tool_call`, `reasoning`, `release_date`, `limit.context`, `status` (`beta`/`deprecated`) |

**TTL'li ya da diske yazan cache bu repoda hiç yok** (`ttl|maxAge|expiresAt` araması
boş) — bu yeni altyapı. Yeniden icat edilmeyecekler: `registry.ts:13-41`
mtime-anahtarlı cache deseni, `vaults.ts:92-108` atomik tmp+rename yazıcısı (Windows
EPERM retry'lı), `app-log.ts`.

### F14-3 — filtre kuralları

Metadata üzerinden, isim listesiyle değil:

- metin çıktısı olmayanlar (embedding / tts / görsel / video) elenir
- `deprecated` ve süresi geçmiş olanlar elenir
- `release_date` eşiğinden eski olanlar elenir — varsayılan 12 ay, ayarlanabilir
- katalogla eşleşmeyenler **silinmez**, kapalı bir "Diğer" grubunda kalır

Bugünkü tek filtre `!m.embeddingOnly` (`api/providers/models/+server.ts:25`) ve
`embeddingOnly` yalnızca `ollama.ts`'in 3 satırlık aile tablosunda set ediliyor —
yapısal olarak Ollama'ya özel, `ProviderModelOption`'da bile yok, yani hiçbir istemci
yeniden filtreleyemez. **Gürültünün kaynağı tam olarak burası:** şu an açık olan iki
bulut sağlayıcısı (`google-ai-studio`, `deepseek-api` — `data/providers.json`) hiçbir
filtreden geçmiyor; Google `v1beta/openai` uçtan `text-embedding-004`, TTS, görsel ve
`-vision` girdilerini `models/` önekiyle birlikte olduğu gibi döküyor.

### F14-4 — seçim durumu + UI

`providers.json`'a sağlayıcı başına `enabledModels` (`ProviderConfigEntry`,
`config-store.ts:4-26` — bugün yalnızca `defaultModel` var). Dikkat:
`config-store.ts:44` whole-file `writeFileSync` ve **atomik değil**; aynı dosyaya model
seçimleri yazılacaksa `vaults.ts`'in sağlamlaştırılmış yazıcısı buraya taşınmalı.

- `checkbox` bileşeni **mevcut** (`ui/checkbox/`, `indeterminate` destekli). Kopyalanacak
  desen: `SourceTreeNode.svelte:51-58` (üç durumlu, `onCheckedChange` + stopPropagation).
- "Diğer" grubunun kapalı durabilmesi için `collapsible`/`accordion` **yok** — elle
  yazılır ya da `printf "y\n" | npx shadcn-svelte@latest add collapsible`
  (`.claude/ROADMAP.md:354-358` bu yolu belgeliyor: CLI `init` bu ortamda interaktif
  olduğu için `components.json` elle yazılmıştı).
- Sayfanın kayıt deseni: her mutasyon **anında** `PATCH` + `await refresh()`; dirty
  state ve Save düğmesi yok (`+page.svelte:83-95`). `enabledModels` aynı desene uyar.
- **"Yenile" düğmesi yeni** — bugün sayfada refresh düğmesi yok, `refresh()` yalnızca
  `onMount` ve mutasyon sonrası çağrılıyor.
- i18n: namespace `ProvidersSettingsPage` (bugün 70 anahtar); **hem `tr.json` hem
  `en.json`** eksiksiz (0 boş değer). Yeni anahtarlar ikisine de girer — yoksa
  `FALLBACK_LOCALE='tr'` yüzünden İngilizce arayüzde Türkçe metin çıkar.

Listeyi tüketen **beş** çağrı yeri var ve hepsi mount'ta önbelleksiz çağırıyor:
`Chat.svelte:74`, `vault/[id]/+page.svelte:79`, `GenerationDialog.svelte:136`,
`settings/+page.svelte:56`, `settings/providers/+page.svelte:76`. Filtrenin **sunucu
tarafında** olması bu yüzden doğru karar.

### F14-5 — metadatayı gerçekten kullan · ana hattı ilgilendirir

`registry.modelCaps:137-150` `capsFor()`'u yalnızca `OllamaAdapter` için çağırıyor,
diğer **her** sağlayıcıya sabit `{tools:false, reasoning:false}` dönüyor (`:146`).
Sonuç: `api/chat/+server.ts:232-233` bulut modellerinde `read_skill_file`'ı **her zaman**
kapatıyor — Groq/DeepSeek tool desteklese bile klasör-skill'in ek dosyaları yalnızca
Ollama'da okunabiliyor. §1 bunu tasarım gibi yazıyor; gerçekte tek satırlık bir sabit.
Katalog `tool_call` verisini getirdiğinde bu kısıt kalkabilir — **öğrenme ajanının
6 referans dosyası o zaman bulut modellerinde de okunur.**

Ek olarak `anthropic.ts:255-274` uydurma `ctx: 200_000` + `caps:{tools:true}` dönüyor ve
`modelCaps` bunu sunucuda `false` ile çeliştiriyor. Aynı dosyanın `:256-258` yorumu
"model listesi endpoint'i yok" diyor, `:260` o endpoint'i çağırıyor, ve yorumun
bahsettiği "statik muhafazakâr fallback" **hiç mevcut değil**.

### Sınırlar

- **"Top tier" hiçbir API'de yok**, öznel bir kavram. En yakın vekiller: yenilik,
  `tool_call`, `reasoning`, context boyutu.
- `models.dev` üçüncü taraf. Kapanırsa ya da yeni model henüz eklenmemişse "Diğer"
  grubu + ham liste devreye girer. **API anahtarı hiçbir yere gönderilmez** — yalnızca
  herkese açık katalog çekilir.
- Id eşleştirmesi (Google'ın `models/` öneki gibi) sağlayıcı başına doğrulanmalı.
- Sağlayıcı/model sınırında **hiç zod yok** — her üretici şemasında ve `userSkills.ts`'de
  var. Dış katalog verisi girerken doğrulama eklenmesi tartışılmalı.
- `listModels()`'ı test eden **hiçbir test yok**.

---

## 5.6. F15 — Linklerden toplu içe aktarma · spec dışı yan görev, **en sona bırakıldı** (kullanıcı kararı, 2026-09-21)

**İhtiyaç.** Kullanıcının NotebookLM (şimdi "Gemini Notebook") ile aradığı çok sayıda kaynağın **linkleri** var; dosya sayısı çok, bir kısmı PDF değil düz web sayfası,
elle kopyalanamaz. NotebookLM'den orijinal dosyaları geri indirmek mümkün değil (yalnızca çıkarılmış metin tutuyor), o yüzden linkler asıl kaynak.

**Önerilen tasarım (uygulanmadı).** Link listesi → içerik türüne göre yol:
- **PDF** (`%PDF` imzası doğrulanır) → olduğu gibi kaydedilir, mevcut `ingest/convert.py` hattı çevirir.
- **Web sayfası** → **ham HTML değil, ana içerik** (`trafilatura`: menü/reklam/alt bilgi atılır) Markdown olarak, başlık/yazar/tarih ve `source_url` frontmatter'da; gerekirse ham HTML `_meta/originals`'a.
  JavaScript ile çizilen sayfalar için yedek: başsız tarayıcı (Playwright), yalnızca çıkmayanlarda.
- **Paralel ama nazik:** ~6 eşzamanlı, aynı siteye ≤ 2, zaman aşımı + yeniden deneme + `robots.txt`; yönlendirme sarmalayıcı linkler çözülür; içerik sha256 ile tekilleştirilir.
- **Manifest** (`manifest.jsonl`: url, son url, durum, tür, yol, sha256, hata): yarıda kalırsa kaldığı yerden devam, başarısızlar sessizce kaybolmaz.
- **Arayüz:** uygulama içinde "Linklerden içe aktar" (link kutusu, ilerleme, başarısız linkler); mevcut `api/import/youtube` deseni ve `convertQueue` yeniden kullanılır; çekirdek modül komut satırından da çalışacak şekilde ayrı tutulur (Python `ingest/fetch_url.py`, `convert.py` gibi JSON satırları sözleşmesi).
- **Önce küçük örnek:** 20–30 link, izole kütüphanede; başarı oranı ve çeviri kalitesi ölçülür, sonra tamamı.

**Bilinen sınırlar.** Ağır/matematikli PDF'lerde MarkItDown zayıf (`needs_review`; Marker/Docling kurulu değil); ödeme duvarı/giriş isteyen/bot engelleyen siteler indirilemez (manifest listeler);
site şartları ve telif kullanıcının değerlendirmesi; binlerce parçanın gömülmesi Ollama'yı uzun süre meşgul eder (deney/ölçüm dışında yapılmalı).
**Sıra:** F14'ten sonra, en son.

---

## 6. Sıra

```
F12 aşama 1-2   ← HER ŞEYDEN ÖNCE. İki env değişkeni + bir satır serveCtx.
                  %46 CPU offload çözülmeden hiçbir ölçüm anlamlı değil,
                  ve her yeni özellik bu yavaşlığın üstüne biniyor.
   └─> F12 aşama 3-4   (k düşür, ölçümü kalıcılaştır)

F4, F13-1/2     ← küçük, bağımsız   (F5 ✅ yapıldı; FTS'i F12-5'i de besleyebilir)
   └─> F1 (temel)
         ├─> F2 ─┐
         └─> F3 ─┴─> F6

F11 (ayrı hat, VLM geçişi) ──> F13-3 gerçek görsel kolu
F7        F8 + F12-5 (birlikte)        F9 (erken başla)

F14 ← Ana hattan bağımsız; F14-1 (timeout hatası) istenirse
      tek başına öne alınabilir.
F15 ← EN SON (linklerden toplu içe aktarma, §5.6; kullanıcı kararı).
```

---

## 7. Doğrulama

- `npm test` yeşil kalmalı; her yeni saf modül kendi `*.test.ts`'iyle gelir
  (mevcut desen: `schedule.test.ts`, `select-chunks.test.ts`).
- **F12-1/2:** ~~`ollama ps` %100 GPU göstermeli~~ — **ulaşılamaz bir kriterdi**
  (`qwen3:8b Q4_K_M` ağırlıkları Ollama'nın bu karttaki ~4.5 GiB bütçesini tek başına
  aşıyor, bkz. §3 ölçüm bulgusu 1). Yeni kriter: `ollama ps`'te GPU payı **≥ %70** ve
  gerçek chat'te decode **≥ 12 tok/s** (eski hal: %54 / 7.2). %100 GPU ancak aşama 6
  (quantization) ile gelebilir.
- **F12-4:** bir sohbetten sonra `app-log.jsonl`'da `kind: 'llm_timing'` kaydı görünmeli
  (`promptTokens`, `completionTokens`, `promptMs`, `completionMs`, `numCtx`); prefill ve
  decode hızı hesaplanabilmeli; kayıtta metin gövdesi **bulunmamalı**. *(2026-09-20'de
  izole ortamda doğrulandı.)*
- **F4:** `npm run index -- --full` sonrası
  `select prerequisites_json from files limit 5` dolu dönmeli.
- **F5:** vektörün boş döndüğü bilinen bir sorguda FTS sonucu gelmeli,
  `reason='keyword'` işaretlenmeli.
- **F1:** backfill önce `--dry-run`; 27 kaynak / 97 cevaptan kaç skill node ve
  kaç state satırı çıktığı raporlanmalı, yazmadan önce gözden geçirilmeli.
- **F11:** yeniden adlandırma sonrası her `](...)` referansının diskte karşılığı
  olmalı — kırık referans sayısı **sıfır**.
- **F13:** üretilen deck'te `layout` çeşitliliği görünmeli, Marp render'ı hata
  vermemeli, `$...$` matematik hâlâ KaTeX ile çizilmeli.
- **F14:** elenen model sayısı raporlanabilmeli (kaç model hangi kuralla düştü);
  katalog çevrimdışıyken liste **boş dönmemeli** (eski cache ya da ham liste);
  takılı bir sağlayıcı diğerlerinin listesini **bloklamamalı** (F14-1 timeout);
  `ctx` artık her modelde 8192 sabiti olmamalı; `google-ai-studio` listesinde
  `text-embedding-004` ve `-vision` girdileri görünmemeli.

---

## 8. Açık kararlar

| Konu | Karar gerekiyor |
|---|---|
| **F11 / `raw/` dokunulmazlığı** | Vault `CLAUDE.md` invariant 1 `raw/`'u salt okunur ilan ediyor; yeniden adlandırma bunu ihlal eder. İstisna açıkça yetkilendirilecek mi, yoksa çıktı ayrı dizine mi yazılacak? Karar verilmeden F11 başlamamalı. |
| **F11 / önce teşhis** | `raw/` altında hiç görsel yok. MinerU'nun neden figür üretmediği bulunmadan adlandırma işine girmek erken. |
| **F12-1 / kalıcı env** | ✅ **Uygulandı** (bkz. aşağıdaki satır). |
| **F12 / tur başına iki model yüklemesi** | En büyük tek gecikme kalemi (ilk tokenın ~%40'ı, ~5 sn/tur). Aday çözüm: sorgu embed'ini GPU dışında çalıştırmak (`num_gpu: 0`) ki `bge-m3` VRAM'de yer tutup qwen3'ü atmasın. **Denenmedi** — retrieval'ın embed hızına etkisi ve Ollama'nın bunu gerçekten uygulayıp uygulamadığı ölçülmeli. Bu turun kapsamı dışındaydı. |
| **F12-6 / quantization** | **Ölçüldü (§3 "Kuantizasyon ölçümü").** `IQ3_M` +%69 (kısa) / +%130 (uzun) hız, kalite bedeli yayınlanmış KLD'ye göre ~2× ama yerel testte tespit edilemedi; `IQ4_XS` +%33 / +%49, kalitesi Q4_K_M'e yakın; `Q3_K_M` elenir (dominated). **Hangisinin varsayılan olacağı kullanıcının kararı** — modeller Ollama'da kurulu, uygulama değişmedi. Seçilirse `serveCtx` (8192, yalnızca Q4_K_M için ölçüldü) yeniden ölçülmeli: daha çok VRAM boşluğu var. |
| **Kurulu aday modeller** | `qwen3:8b-bart-iq4xs`, `qwen3:8b-bart-iq3m`, `qwen3:8b-bart-q3km` model deposunda (~12.6 GB). `q3km` dominated olduğu için silinmesi önerilir; karar kullanıcıda. Ayrıca `ollama create`, her GGUF'un ham kopyasını da bıraktı: **4 yetim blob, 11.76 GiB**, hiçbir manifest başvurmuyor (doğrulandı). Ollama bunları bir sonraki başlatılışında kendi temizler; elle silinmedi. |
| **F12-3 / `k=6` kalitesi** | `CHAT_K` 12 → 6 gecikmeyi ölçülebilir düşürür ama cevap kalitesine etkisini log ölçemez. Kullanıcı gerçek sorularla karşılaştırmalı; kalite düşerse `CHAT_K` tek satırda geri alınır (o zaman `serveCtx` ile birlikte yeniden dengelenmeli). |
| **`LLAMA_ARG_FIT_TARGET=256` (kalıcı)** | En büyük kaldıraç (§3 "Motorun VRAM güvenlik payı"). Kullanıcı düzeyinde kalıcı ortam değişkeni + Ollama yeniden başlatması — **uygulandı ve doğrulandı (2026-09-20)**. Ayrıca makinedeki tüm llama.cpp tabanlı programları etkiler. `OLLAMA_FLASH_ATTENTION=1` ve `OLLAMA_KV_CACHE_TYPE=q8_0` ile birlikte ölçüldü; hızlar üçüne bağlı. Belgelenmemiş bir geçiş: Ollama güncellemesi kırabilir. |
| **Bozuk çıktıdan kaldığı yerden devam** | ✅ **Uygulandı** (§3). Yalnızca Ollama + qwen3 ailesi; başka aileye açmadan önce o modelde devam davranışı ayrıca deneyle doğrulanmalı (`prefixResume` bayrağı). Bulut sağlayıcılarda eski davranış. |
| **F5 / gerçek indekse `--fts`** | `npm run index -- --fts` gerçek indeksi değiştirir (yalnızca `chunks_fts` ekler, gömme yok). **Kullanıcı onayı** bekliyor; onaylanana kadar yedek kapalı. Ölçüm tetikleyicinin nadir olduğunu gösterdi — acele yok. |
| **Skill prompt yükü** | Ölçüldü: `educational-agent` chat başına **+1 708 token / +0.96 sn prefill** (§3). Açık bırakmak bu bedeli her turda ödemek demek; kalıcı karar kullanıcıya ait. Dosya bugün ikisi de `enabled: false` (kullanıcı arayüzden kapattı). ~700 token'ın kaynağı henüz ayrıştırılmadı. |
| **F14 / yenilik eşiği** | `release_date` eşiği 12 ay mı olsun? Daha kısa eşik hâlâ kullanılan modelleri de düşürür, daha uzun eşik gürültüyü bırakır. |
| **F14 / tool filtresi** | "Sadece tool destekleyenleri göster" anahtarı gelsin mi? Listeyi belirgin daraltır ama üreticilerin çoğu tool kullanmıyor. |
| **F14 / ROADMAP kaydı** | F14 ayrıca `.claude/ROADMAP.md`'ye `Faz 20` olarak girsin mi? Repoda iki bağımsız numaralandırma var (`Faz N` ROADMAP'te, `F<N>` bu belgede) ve birbirlerine hiç atıf vermiyorlar. Not: Faz 17-19 kodda var ama ROADMAP'te yok, ilk boş numara 20. |
| **Donanım sınırı** | 6 GB VRAM'de aynı anda iki modeli GPU'da tutmak mümkün değil — router + uzman model mimarisi (1.7B routing + 8B generation) şimdilik kapsam dışı. |

---

## Ekler

- Skill paketleri: `educational-agent.zip`, `learning-generators.zip` (masaüstü)
- Kaynak spec: `Local Educational Agent — Agent Specification v1.md` (63 bölüm)
- Önceki analiz: `docs/ollama-latency-analysis.md` — **kaldırıldı** (2026-09-20);
  hâlâ geçerli varsayımları §2 ve §3 aşama 4'e devşirildi, gerisi ölçümle aşıldı
- F14 kaynakları: `https://openrouter.ai/api/v1/models`, `https://models.dev/api.json`
