# TODO

Vault Chat'in hedef listesi. Her çalışma oturumunda denetlenir ve güncellenir.

**Son güncelleme:** 2026-10-15 · #2 Fizik 10/11 yeniden içe aktarıldı ve elle denetlendi; Likharev QM sürüyor

## Kurallar

- **Öncelik sırası:** Acil → Yapılabilir → Daha sonra. "Daha sonra" her zaman en sonda durur.
  - **Acil:** önce yapılacak iş. Konuya göre gruplanır.
  - **Yapılabilir:** kararı verilmiş, sırası Acil'den sonra gelen iş. Aynı biçimde gruplanır.
  - **Daha sonra:** zamanı ya da ön koşulu gelmemiş iş. Gruplanmaz; en sonda "en son" işaretli madde durur.
  - **Öneriler:** Claude'un kendi bulduğu hata ya da fikir. Kullanıcı bir kategoriye koyana kadar burada bekler.
- **Sıralama (Acil ve Yapılabilir):** Gruplar toplam süreye göre en kısadan en uzuna dizilir. Grup içinde de maddeler en kısadan en uzuna dizilir.
  - Süre etiketi: `K` küçük, `O` orta, `B` büyük (`K–O`, `O–B` ara değerler).
  - Grup sırası için kaba ağırlık: K=1, K–O=2, O=3, O–B=5, B=8.
- **Madde biçimi:**
  ```
  - [ ] **Kısa ad.** Bir cümlelik açıklama. `K` · ertelenenler #N
  ```
  - Bir madde başka bir maddeyi bekliyorsa sona `← <kısa ad>` yazılır.
  - Yapılabilir'den Acil grubuna çekilen maddede `(çekildi)` yazar.
- **Her oturumda denetim:**
  1. Oturum başında Acil ve Yapılabilir maddelerini kod ve git geçmişiyle karşılaştır. Biten maddeyi listeden çıkar ve "Son tamamlananlar"a commit hash'iyle taşı. Bunun için sormaya gerek yok.
  2. Kısmen biten maddenin açıklamasını kalan işe göre kısalt.
  3. Oturum sonunda: bu oturumda biteni taşı, yeni bulguları "Öneriler"e ekle, "Son güncelleme" satırını yenile.
- **Eleme.** Bitmemiş bir maddeyi silmeden ya da kategorisini değiştirmeden önce kullanıcıya sor.
- **Ayrıntı nerede tutulur:** Uzun bağlam bu dosyada tutulmaz. Ayrıntı `docs/dev/ertelenenler-2026-10-10.md` ve ölçüm raporlarındadır; madde oraya numarasıyla işaret eder.

## Acil

### 1. Kurulum ve veri sağlamlığı

### 2. Test ve doğrulama

### 3. Sohbet ve dil tutarlılığı

### 4. Düzenleyici ve sohbet görünümü

### 5. Büyük belgelerde bellek ve hız
- [ ] **Uzun PDF'leri parçalı dönüştür.** docling her sayfanın görüntüsünü/arka ucunu/hücrelerini sonuna kadar tutuyor: 2,4 GB + 20 MB/sayfa, 32 GB'ta ~1300 sayfa üstü sığmaz. 150 sayfalık aralıklarla çevir, Markdown'u birleştir. `docs/dev/bellek-olcum-2026-10-15.md` `O` · #83 devamı
- [ ] **Formül yoğun klasörlerin hızı.** Sayfa başına 15–25 sn; 200+ saatlik klasörler. `B` · #82

### 6. İçe aktarmada sessiz bozulma

### 7. MCP araçları ve belgeleri
- [ ] **Yerel modellerle MCP deneyi.** Qwen3 8B/4B, LM Studio. `O` · #39 (çekildi)

### 8. Formül doğruluğu
- [ ] **MinerU KaTeX: elle bakılacak formüller.** Mekanik olanlar bitti (2026-10-13, 367 formül). Kalan: ~73 formül sanılmış kod (kod bloğuna çevir), 14 anlamı belirsiz makro, 7 bozuk MathType kesri, ~15 çift üst/alt simge, dengesiz \left/\right; 19 kesik \quad döngüsü #3 ile. `O` · #5 (çekildi)
- [ ] **Fizik #2: Likharev QM'yi incele.** 11 notun 10'u yeniden içe aktarıldı (KaTeX 45 → 0) ve elle PDF ile karşılaştırıldı; QM (465 s., 3 hata) dönüşümde. Bittiğinde aynı yöntem: değişen formül bloklarını eskiyle eşle, LaTeX'e dönenleri PDF sayfasıyla karşılaştır, yanlışı elle düzelt. `K` · #2
- [ ] **"Yalnız hatalı formülü onar".** Sayfa + kutu; belgenin tamamını yeniden okumadan. `B` · #3

### 9. MCP paketleme ve kurulum
- [ ] **`npx` ile tek komut MCP kurulumu + örnek kasa.** `O` · #43
- [ ] **MCP sunucusunu Tauri paketine dahil et.** Tek dosya ya da gömülü Node. `O–B` · #37
- [ ] **Node'u (ve Python'u) pakete gömme; WebView2 çevrimdışı yükleyici.** Node kısmı #37 ile ortak. `B` · #53 (çekildi) ← MCP sunucusunu Tauri paketine dahil et

## Yapılabilir

### 1. İçe aktarma
- [ ] **F15 tam kapsamı.** Playwright ile JS sayfa yedeği, `manifest.jsonl`, paralel link indirme. `O` · #18

### 2. Öğrenme ajanı
- [ ] **Kapsam daraltma ve eşzamanlı üretim bildirimleri.** Canlı Ollama ile dene. `K` · #79
- [ ] **F8: 12.000 karakter bütçesi ve `nearCtxLimit` eşiği.** Yeniden ölç. `K` · #78
- [ ] **F6: otomatik mod geçişi.** v1 yalnız elle. `O` · #77

### 3. Arayüz
- [ ] **LauncherPanel görsel denetimi.** `K` · #68
- [ ] **Alıntı bağlantısına başlık çapası.** `sourceLink.ts` hâlâ yalnız `path` ve `vault` veriyor; başlık çapası yok. `K–O` · #33
- [ ] **Kalan lucide ikonları ve özel pencere çubuğu.** Yeni ikonlar geldi; önce onlara bak. `O` · #67

### 4. Güvenlik ve CI
- [ ] **CI'da `npm audit` / `cargo audit` / gitleaks.** `K` · #52
- [ ] **Public öncesi hazırlık.** Geçmişte sır taraması, `desktop.yml` tetikleyicisi, Windows ARM, fork PR güvenliği. `O` · #51
- [ ] **İçe aktarılan dosyalarda antivirüs taraması.** `O` · #60
- [ ] **ollama-gate'te olası kilitlenme.** Akış içinde farklı model + evict beklemesi. `O` · #63

### 5. RAG ve benchmark
- [ ] **`bench/` bge-m3'e sabit.** `K` · #30
- [ ] **Tam altın set (330 soru) koşusu.** `O` · #27
- [ ] **Reranker'ı üretime al.** Pilotta R@5 0,74 → 0,80; ONNX int8 ölçülmedi. `O` · #29
- [ ] **İstem/skill dili A/B.** qwen3:8b için İngilizce çekirdek istem; educational-agent açık/kapalı. Kullanıcı notu: "olabilir". `O` · #28

### 6. Notebook verileri
- [ ] **Rusça kasası onarımı.** 14 uyarılı bekleyen; İngilizce/Mandarin/İspanyolca kasa sorusu. `O` · #21
- [ ] **Notebook verileri dönüşümü.** 12 klasör → ayrı kasalar; Fizik bitti, dil ve bilim klasörleri kaldı. `B` · #20

## Öneriler

- [ ] **#61 ve #40'ı uygulamada dene.** Yedek kartı (klasör seçici, ilerleme) ve edit_note anahtarı tarayıcıda denenmedi. `K`
- [ ] **#31'i gerçek bir modelle doğrula.** Kalibrasyon yalnız sentetik vektörlerle sınandı; nomic/qwen3 embedding ile 2016 negatiflik setinde yanlış pozitif ölç. `O`
- [ ] **#7'yi asıl dosyayla dene.** 34 sayfalık taranmış Sinyaller final PDF'i (Kolay Matematik testi). `K`
- [ ] **Elle: 7 `\circ c` ve 1 `\underset{X}{\, \infty}` (Likharev).** ∝ kuralı bunlara bilerek dokunmuyor. `K`
- [ ] **#8: `use_cls=False` tüm OCR sayfalarında.** Yan/ters taramada döndürme düzeltmesi kayboldu; yalnız kodlu sayfalarda kapatmak ikinci geçiş ister. Ayrıca eşit genişlikli yazı tipi varsayımı, `code_language` etiketi kaybı, kod alanındaki el yazısı OCR çöpü. `O`
- [ ] **Yeniden içe aktarma kapısı formül düzeyinde olmalı.** KaTeX "hata azaldı" ölçütü yanlış-ama-geçerli formülü yakalamıyor: 2026-10-15'te 10 notta eski 42 hatanın 32'si görsel (doğru), 10'u LaTeX (2 doğru, 4 yarım, 4 yanlış); ayrıca 3 regresyon (eskisi neredeyse doğruydu). Notun tamamı yerine yalnız değişen formülleri göster/onaylat ya da eskisi yalnız sözdiziminden düşüyorsa onu onar. #3 ile birlikte. `O`
- [ ] **MinerU çıktısında formüle karışmış düzyazı.** `	ext{where the constant in…}`, `	ext{ a n d   m a n g n e t i c …}` gibi satırlar KaTeX'ten geçiyor ama yanlış; postprocess'te ayıklanabilir (uzun `	ext{}` + düzyazıda aynı cümle). `O`
- [ ] **Sessiz kurulum eski exe'yi bırakabiliyor.** 2026-10-15'te ilk `/S` kurulum çıkış 0 verdi ama `vault-chat.exe`'yi değiştirmedi (yalnız dist-server güncellendi); süreçler tam kapanınca ikinci kurulum düzeldi. Kurulumdan sonra exe'yi doğrula; uygulama `taskkill` (zorlamasız) ile de kapanmıyor. `K`

## Daha sonra

- [ ] **PPTX kapı deneyi.** #15
- [ ] **Joplin dışa aktarım düzenini gerçek bir dışa aktarımla doğrula.** README "Ne yapar?" bölümü bunu anlatıyor. #16
- [ ] **Ses/video → metin.** Whisper, .vtt/.srt. #19
- [ ] **Chollet docling çıktısını `yapay-zeka` kasasında yeniden indeksle.** #25
- [ ] **Kolay Matematik'teki 16 "ready" içe aktarmanın onayı.** #26
- [ ] **Yalnız-FTS geri getirmesi zayıf.** R@5 0,398; kök bulma yok. #32
- [ ] **open-notebook önerileri.** Kaynak başına bağlam seviyesi, çok adımlı soru, sohbetten not kaydetme, OpenAPI, podcast. #34
- [ ] **MCP'de `generate_quiz` / `generate_flashcards`.** #42
- [ ] **Gerçek Mac denemesi.** `docs/macos-deneme-listesi.md`. #47
- [ ] **Gerçek Linux masaüstünde GUI denemesi.** #48
- [ ] **macOS klasör seçicinin Mac'te denenmesi.** #50
- [ ] **Otomatik güncelleme; "tarayıcı / masaüstü / ikisi" kurulum seçimi.** #55
- [ ] **F7: 6 sınıflı epistemik etiket ve rozet; A/B ölçümü.** #75
- [ ] **F9'da ertelenen değerlendirme kategorileri.** Memory, Personalization, Teaching. #76
- [ ] **Profil/parola kilidi ve "Coder" sayfası.** #80
- [ ] **Kota defteri; sabitlenmiş sağlayıcı tercih mi kısıt mı.** #81
- [ ] **Görsel açıklamalarını yerel VLM ile üretme.** `vc:gorsel` yuvası hazır; Qwen4'e kadar ertelendi. #85
- [ ] **Bedrock ve Vertex sağlayıcıları.** Azure yapıldı (e61d6fd). #86
- [ ] **Çoklu içe aktarma ölçüm belgesi.** `docs/coklu-ice-aktarma-olcum-2026-10-04.md`. #88
- [ ] **macOS imza + notarization (yıllık 99 $).** En son. #49

---

## Son tamamlananlar

Yalnız son iki haftanın kaydı tutulur; daha eskisi git geçmişindedir.

- 2026-10-15: #2 Fizik yeniden içe aktarma (10/11 not, Likharev QM sürüyor): KaTeX hataları 45 → 0; kozmolojide ~20 `∞`→`∝` düzeldi. Elle PDF karşılaştırması: 42 eski hata noktasının 32'si sayfa numaralı görsel, 10'u LaTeX; yanlış/yarım 8 formül + 3 regresyon PDF'ten elle yazıldı (adaptive (2.16)/(3.41)/s.26/s.32, motivic (5.1.8.a) ve 64 `𝕀`→`𝟙`, Carroll Maxwell, string (3.36)/(6.17) yeri, optik (11.21), SM (2.69), loop-QG yinelenen düzyazı, EM kenar etiketi). Hepsi revizyonlu.
- 2026-10-15: bozuk `chats.db` artık tek hata olayı veriyor (`CHAT_SAVE_FAILED`), önce `UNKNOWN` yok. `2d27a10`
- 2026-10-15: #56 paketli sürümde: sağlayıcı aç/kapa `AppData\providers.json`'a yazılıyor (kurulumdaki varsayılan dokunulmuyor), API ile disk tutarlı; bozuk `chats.db` (kopyada, paketli sunucu) istemciye `error` olayı + `app-log.jsonl`'e `db_error`, sunucu ayakta kalıyor.
- 2026-10-15: f2d78d9 kuruldu; Fizik (34.595 → 7.854 parça, 18 not) ve Rusça (16 → 2 dosya) revizyonsuz yeniden indekslendi; diğer kasalarda `_meta` satırı yoktu ya da indeks hiç yoktu.
- 2026-10-15: `_meta` (revizyonlar) artık indekslenmiyor; Fizik'te indeksin 50/68'i revizyondu. `c2f2b49`
- 2026-10-15: #87 paketli sürümde doğrulandı: launcher kaydı yokken Ollama açılışta başlıyor ("starting it for this session"), launchers.json'a yazılmıyor; açılıştan hemen sonra MCP search_library yanıt veriyor.
- 2026-10-15: #45 paketli sürümde: `mcp-endpoint.json` her açılışta yeni pid/port ile yazılıyor, pid canlı sidecar; MCP jetonu yalnız /api/mcp/*'yi açıyor.
- 2026-10-15: #59 paketli sürümde: sidecar kökenli sayfadan `check_and_start` / `save_vault_config_and_start` / `recheck_node` ACL ile reddediliyor (CDP ile denendi); jetonsuz, yanlış jetonlu, MCP jetonuyla MCP dışı istek 401, yabancı Origin 403.
- 2026-10-15: büyük PDF bellek ölçümü: 150/300/600 sayfa → 5,5/8,7/14,6 GB RAM, GPU ~4,3 GB sabit (#83). `docs/dev/bellek-olcum-2026-10-15.md`
- 2026-10-15: yedek bildirimleri sağlayıcıyı etiketiyle anıyor, yerleşik "Ollama (yerel)" her dilde yerelleşiyor (#73 devamı). `39a9367`
- 2026-10-15: kısa gerçek başlıklar ("Go", "R", "C", "Qt") artık reddedilmiyor; yalnız bölüm numarası ("I", "XIV", "12") eleniyor (#10 yan etkisi). `d9bb0da`
- 2026-10-15: `python -m pytest ingest` tek komutla 16 dosyayı koşuyor (conftest, her dosya kendi sürecinde). `a91000b`
- 2026-10-15: `npx tsc --noEmit -p mcp` temiz (App.Error tipi mcp tsconfig'e eklendi). `2a3ab32`
- 2026-10-15: Fizik kasası ∝/Symbol onarımından sonra uygulamada yeniden indekslendi (kullanıcı).
- 2026-10-13: taranmış kod blokları OCR kutularından satır ve girintiyle kuruluyor; CodeFormula OCR'da her dilde kapalı, RapidOCR `use_cls=False`; fonk1 0,93/49 ve 0,95/47, dic1 0,96/52 (#8 devamı). `c242bc8`
- 2026-10-13: ∝ kuralı ve Adobe Symbol özel kod eşlemesi içe aktarmada; Fizik'te 7 not onarıldı (35 ∝, 12.937 Symbol karakteri; revizyon yedekli). Araştırmadaki 71 aday yerine 35: notlar sonradan yeniden içe aktarılmış (#4). `48aa5d9`
- 2026-10-13: karar: edit_note kapalıyken listede görünür, uygulama reddeder (olduğu gibi kalsın).
- 2026-10-13: OCR dili kasa dilinden; desteklenmeyen dilde uyarı; Türkçe taramada CodeFormula kapalı (bozulmanın asıl nedeni oydu) (#8). `ebe763e`
- 2026-10-13: MCP search_library mode (hibrit RRF), list_domains, get_note bölüm/sayfa (#41). `8e56d34`
- 2026-10-13: Playwright e2e (36 test, `npm run test:e2e`), axe denetimi ve düzeltmeleri, kırık link yok (#62). `5e12e74`
- 2026-10-13: sessiz glif bozulması (#6) ve OCR formül şüphesi (#9) uyarıları; gerçek veride 15 temiz PDF'te yanlış alarm yok, bozuk slayt dosyasında ↪→, ▷→. ♣→| doğru eşlendi. `e36bade`
- 2026-10-13: eskimiş @milkdown/plugin-math projeye alındı, bağımlılık kaldırıldı (#69). `d37db0c`
- 2026-10-13: alıntı ve iki sütun slaytları denendi, taşmalar düzeltildi (#74). `d73e0f2`
- 2026-10-13: Ayarlar'da "Veriyi yedekle" (#61) ve varsayılan kapalı MCP edit_note (#40). `f4433c0`
- 2026-10-13: default kasasında 367 formül KaTeX uyumlu hale getirildi: html-entity 212, çift \tag 37, makro tablosu 115 (font-switch, macro-arg, mleftright dahil), MathType kesri 3. Yedekler `Desktop\vault-chat-yedek\katex-2026-10-13*` (#5). `09778ba`
- 2026-10-12: "Kaynaklar alakasız" düğmesi yalnız güçlü kaynak yoksa çıkıyor (#35; eşik 0,5 ölçülmedi). `b012c15`
- 2026-10-12: düzenleyicide görsel yükleme (#70) ve Ayarlar → Kasalar'da "MCP istemcisine bağla" kartı (#38). `46c4994`
- 2026-10-12: KaTeX temizlik betiği, yalnız deneme modunda çalıştırıldı (#5'in ilk yarısı). `30e0e86`
- 2026-10-12: Word denklemi gibi geniş-alçak görseller süzgeçten geçiyor (#13). `51b868f`
- 2026-10-12: taranmış PDF'e yanlış PDF_DAMAGED yok (#7, savunmacı; asıl 34 sayfalık dosyayla denenmedi), anlamsız başlıklar eleniyor (#10), MCP içe aktarmada updatedAt nabızla güncelleniyor ve görsel sayacı tutarlı (#11). `84f822f`
- 2026-10-12: içe aktarmadaki seviye seçici 23 dilde (#66). `18d84d8`
- 2026-10-12: sohbet kapısı bge-m3 dışı modellerde çalışırken kalibre ediliyor (#31). `d029955`
- 2026-10-12: launcher kaydı yoksa da Ollama açılışta başlıyor; açılışta embedding 30 sn'ye kadar bekliyor (#87). `5576744`
- 2026-10-12: sohbetteki kod bloğunda şerit/artık yok (#72, koyu ve açık temada denetlendi); CodeMirror CRLF'yi koruyor (#71). `d65894d`
- 2026-10-12: "Formül Testi" kasası ve `_formul-testi/` silindi (#22). #23 elendi.
- 2026-10-12: disk temizliği; 14 worktree, 7 yarım kalmış worktree klasörü ve ana `src-tauri/target` silindi, ~25 GB. Dallar yer kaplamadığı için kaldı (#58).
- 2026-10-12: sürüm artırma betiği `npm run version:bump -- 0.3.1` (#54). `49f343b`
- 2026-10-12: stage-server package-lock değişmediyse `npm ci`'yi atlıyor; `STAGE_FORCE_INSTALL=1` ile zorlanır (#57). `628fa74`
- 2026-10-12: okunamayan formülde ham latex bloğu yerine "⚠ Formül okunamadı — s. N"; latex `vc:formul-latex` yorumunda (#1). `68cbc93`
- 2026-10-12: README ve KURULUM-REHBERI MCP bölümü, `search_library` açıklaması güncel (#44, #46). `660ba05`
- 2026-10-12: providers.json yoksa varsayılanlara düşülüyor, doctor da (#64); "Ollama (yerel)" 23 dilde yerelleşti (#73). `6714eaa`
- 2026-10-12: sohbet başlığı sorunun dilinde (#36). `39f20d1`
- 2026-10-12: ertelenenler dökümü kullanıcı kararlarıyla Acil / Yapılabilir / Daha sonra'ya dağıtıldı. Listeden düşenler: yapıldı #17, #84; gereksiz #12, #14, #24, #65.
- 2026-10-10: dil seti 23 dile çıktı (pcm, ar-EG çıktı; ko, it, nl, pl, cs, sv, nb, da, fi girdi). `6af6b6c`
- 2026-10-10: README için İngilizce demo görselleri ve markaya uygun mimari şema. `b09c434`
- 2026-10-10: ertelenen işler toplandı (88 madde). `docs/dev/ertelenenler-2026-10-10.md`
