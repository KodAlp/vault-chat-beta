# TODO

Vault Chat'in hedef listesi. Her çalışma oturumunda denetlenir ve güncellenir.

**Son güncelleme:** 2026-10-18 · Acil boşaldı. main origin'e push edildi (`e4b2729`): #30, #33, #37, #3, #5, #43. #53 (Windows paketinde gömülü Node 22 + Python, WebView2 önyükleyicisi) `claude/devam-edelim-0a885a` dalından yerel main'e alındı (`e18335d`), kurulum dosyası kuruldu; push yok.

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

### 6. İçe aktarmada sessiz bozulma

### 7. MCP araçları ve belgeleri

### 8. Formül doğruluğu

### 9. MCP paketleme ve kurulum

## Yapılabilir

### 1. İçe aktarma
- [ ] **F15 tam kapsamı.** Playwright ile JS sayfa yedeği, `manifest.jsonl`, paralel link indirme. `O` · #18

### 2. Öğrenme ajanı
- [ ] **Kapsam daraltma ve eşzamanlı üretim bildirimleri.** Canlı Ollama ile dene. `K` · #79
- [ ] **F8: 12.000 karakter bütçesi ve `nearCtxLimit` eşiği.** Yeniden ölç. `K` · #78
- [ ] **F6: otomatik mod geçişi.** v1 yalnız elle. `O` · #77

### 3. Arayüz
- [ ] **LauncherPanel görsel denetimi.** `K` · #68
- [ ] **Kalan lucide ikonları ve özel pencere çubuğu.** Yeni ikonlar geldi; önce onlara bak. `O` · #67

### 4. Güvenlik ve CI
- [ ] **CI'da `npm audit` / `cargo audit` / gitleaks.** `K` · #52
- [ ] **Public öncesi hazırlık.** Geçmişte sır taraması, `desktop.yml` tetikleyicisi, Windows ARM, fork PR güvenliği. `O` · #51
- [ ] **İçe aktarılan dosyalarda antivirüs taraması.** `O` · #60
- [ ] **ollama-gate'te olası kilitlenme.** Akış içinde farklı model + evict beklemesi. `O` · #63

### 5. RAG ve benchmark
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
- [ ] **İçe aktarmada sayfa ilerlemesi göster.** convert.py artık her parça sonunda `pagesDone`/`pagesTotal` yayıyor; SingleFileImport ve BatchImport yalnız aşama etiketi gösteriyor. Uzun kitapta "450/1151 sayfa" ve kalan süre. `K–O`
- [ ] **Parçalı dönüştürmede kalan bellek artışı.** 1151 sayfada parça başına ~0,15 GB birikiyor (birleşik belgedeki görseller, formül kırpımları); 5000 sayfalık Intel SDM ile ölç, gerekirse görselleri parça sonunda diske yaz. `O`
- [ ] **MCP: `search_library` için `k` alt sınırı.** Yerel modeller `k=1` istiyor ve yanlış notu alıyor (Einstein sorusunda kozmoloji notu). Alt sınır 3 ölç. `K`
- [ ] **MCP: `get_note` varsayılanı.** Notun tamamı dönüyor (yüz binlerce karakter), 8K bağlamlı yerel model aradığını bulamıyor; bölüm/sayfa parametresini hiçbir model kullanmadı. Varsayılan olarak başlık listesi + ilk bölüm ya da büyük notta ipucu. `O`
- [ ] **"MCP istemcisine bağla" kartına yerel model notu.** qwen3:4b, düşünme açık, bağlam ≥ 8K; 8b bu araç setinde uyduruyor. `K`
- [ ] **CUDA grafikli decode'u paketli sürümde dene.** Kurulu uygulamanın Python'unda (aynı torch/transformers mi?) ve sohbet modeliyle eşzamanlı içe aktarmada. `K`
- [ ] **MinerU HTML tabloları sohbet/not görünümünde.** `markdown.ts` `html: false`; MinerU tabloları `<table><tr><td>` olarak yazıyor (MIPS kitabında 567). Uygulamada ham HTML metni olarak mı göründüğü denenmedi; aynı soru MinerU'nun `<div class="mineru-algorithm">` sözde kod bloklarında da var (Nocedal). Ayrıca tablo hücrelerindeki `$s0 … $sp` yazmaçları satır içi formül gibi eşleniyor (23 KaTeX hatası): tabloyu GFM'e çevirmek ya da `$`'ı kaçırmak ikisini birden çözer. `O`

- [ ] **`npx vault-chat-mcp setup`'ı gerçek istemcilerle dene.** Ana klasörden (worktree'den değil) çalıştır; Claude Code yolu (`claude mcp add`, var olan kayıtta "already exists" → kaldır + ekle) ve Microsoft Store Claude Desktop'ın sanal yapılandırma yolu yalnız birim testte. Yerel kasada gömme sunucusu (Ollama) kapalıyken indeksleme hatası ve ipucu da denenmedi. `K`
- [ ] **Paketli MCP'yi kurulu uygulamada dene.** Tauri derlemesi yapılmadı; kurulumdan sonra kartın verdiği yol (`%LOCALAPPDATA%\vault-chat\_up_\dist-server\mcp\vault-chat-mcp.mjs`) ile Claude Desktop/Code'a bağlan. Bu makinedeki genel MCP kaydı hâlâ kaynak klasörü (`mcp/launch.mjs`) gösteriyor; pakete çevrilebilir. Vektör/hibrit arama pakette denenmedi (gömme sağlayıcısı yoktu). `K`
- [ ] **Gömülü Node/Python'lu kurulumu dene (#53).** 2026-10-18'de kuruldu: sunucu `_up_\dist-server
ode
ode.exe` ile açılıyor, Ollama'yı uygulama başlatıyor (`ollama serve`, üst süreç vault-chat.exe). Kalan: uygulamada sohbetle Ollama yanıtı, Python durumunda docling'li sistem Python'u, Node/Python'suz temiz bir hesapta "Şimdi kur"un gömülü Python'dan venv açması, WebView2 önyükleyicisi. `K`
- [ ] **Uygulama venv'i kurulum klasörüne bağlı.** `pyvenv.cfg` gömülü Python'un mutlak yolunu tutuyor; uygulama başka klasöre kurulursa venv bozulur. Açılışta venv Python'u çalışmıyorsa yeniden oluştur. `K`
- [ ] **Doğrulanamayan 3 KaTeX formülü.** Ters basılmış ipucu (book (2) s.364), Proakis'te sayfası bulunamayan 600 karakterlik OCR çöpü (satır 6232), Valvano'da PDF'te görsel olan bayrak formülü (satır 13312). Gözle bakılıp yazılabilir. `K`
- [ ] **"Yeniden oku"yu paketli sürümde dene.** Geliştirme sunucusunda uçtan uca denendi (String Theory s. 87); kurulu uygulamada Python/KaTeX yolu, GPU sırası (sohbet modeli yüklüyken) ve görsel düzenleyici modundaki liste denenmedi. `K`
- [ ] **İşaretsiz eski KaTeX-geçersiz `$$` formüller için onarım.** Kasada kalan 19 kesik `\quad` döngüsü/dev dizi: sayfa yok; PDF'te çevre metniyle sayfa bulunup aynı `formula_repair.py` akışına verilebilir. `O`
- [ ] **Fizik'teki 19 işaretli formülü "Yeniden oku" ile onar.** Eski işaretlerde kutu yok; kutu şablon eşlemeyle bulunuyor (iki örnekte skor 0,88–0,89). Kullanıcının uygulamada yapması gerekir. `K`

- [ ] **#33 çipini gerçek sohbette dene.** Görüntüleyicinin başlığa kayması geçici kasada denendi (aynı adlı iki "Örnek", `**…**` `` `…` `` başlık); sohbetteki kaynak çipi, önizlemedeki bölüm bağlantıları, bilgi kartı ve test sonucu bağlantısı model olmadan tıklanmadı. `K`
- [ ] **bench `prod` varyantı gömmesiz 30 sn bekliyor.** Ollama kapalıyken `prod` her soruda `embedding-unavailable` ile 0 veriyor, diğer varyantlar önbellekten geliyor; koşu başında gömme sağlayıcısına bir kez ulaşıp erken durmalı. #30'un önbelleği boş canlı yolu (Ollama açık) da denenmedi. `K`

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

- 2026-10-18: main origin'e push edildi (`893e2f8` → `e4b2729`, 17 commit): #3, #37, #43, #5 elle düzeltmeler, #30 ve #33 artık uzak depoda.
- 2026-10-17: alıntı bağlantısı kaynaktaki başlığa kayıyor (#33): `libraryViewerUrl`'e `heading` (parçanın `heading_path`'i); not görünümü başlığı metniyle bulup (`heading-target.ts`: Markdown işaretleri ayıklanır, aynı adlı başlıkta üst başlıklar eşleşen seçilir) kayıyor ve kısa vurguluyor. Sohbet çipi (önizlemedeki her bölüm ayrı bağlantı), bilgi kartı ve test sonucu geçiriyor. Geçici kasada geliştirme sunucusunda denendi. `8bdaabc`
- 2026-10-17: `bench/` sorgu gömmesi uygulamanın `embedTexts()`'i ve providers.json'daki sağlayıcıyla; indeksin `index_meta`'sıyla uyuşmazlıkta açık hata (#30). Önbellek anahtarı `embeddingKey()`, varsayılanda yine `bge-m3`: eski önbellek geçerli, 3 soruluk koşu eski kodla birebir aynı. `f56863b`
- 2026-10-17: Windows paketinde gömülü Node 22 ve Python (#53): stage-server derlemeyi yapan Node 22'yi `dist-server/node/node.exe`'ye kopyalıyor (better-sqlite3 aynı Node'la derlendiği için ABI uyumlu), lib.rs Windows'ta hep onu kullanıyor; `scripts/fetch-python-runtime.mjs` python-build-standalone CPython 3.12.15'i (SHA256 sabit) `dist-server/python`'a koyuyor; hafif paketler "Şimdi kur" ile bu Python'dan açılan venv'e. Python seçiminde docling'li yorumlayıcı asla docling'siz biri yüzünden geride kalmıyor. WebView2 `embedBootstrapper`. Kurulum dosyası 36 → 76 MB; NSIS derlemesi ve kaynak düzeni doğrulandı, sahnelenmiş sunucuda üç Python senaryosu ve "Şimdi kur" denendi. `6417b05`
- 2026-10-17: MCP sunucusu Tauri paketinde (#37): `scripts/build-mcp.mjs` `mcp/bundle-entry.mjs`'i esbuild ile tek ESM dosyaya paketliyor (1,4 MB; SDK dahil, better-sqlite3/sqlite-vec dist-server/node_modules'tan), `stage-server` her sahnelemede üretiyor, `stage-verify` denetliyor. DATA_DIR verilmezse kurulu uygulamanın veri klasörü. "MCP istemcisine bağla" kartı paketli dosyayı gösteriyor; eskiyen "paketli değil" metni 23 dilde "bu kurulumda bulunamadı" oldu. Tam sahnelemede (npm ci + build + stage-server) tsx'siz dist-server'da gerçek MCP istemcisiyle tools/list, list_vaults, get_note çalıştı. `5ce6a7c`
- 2026-10-17: "Yalnız hatalı formülü onar" (#3): not görünümünde her "⚠ Formül okunamadı" satırında "Yeniden oku"; `ingest/formula_repair.py` asıl PDF'in o sayfasını pdfium ile çizip kutuyu (yeni işaretlerde `k=l,b,r,t`, eskilerde saklı kırpımın şablon eşlemesi) dört kırpımla MinerU2.5-Pro'ya okutuyor, KaTeX'le sınıyor; diyalogda kırpım + önizlemeli adaylar, seçilen kaydedilmemiş taslağa yazılıyor (kaydet = revizyon + indeks). GPU işi `sharedJobMutex` özel yuvasında, dönüştürücü işçisi ve boşta Ollama boşaltılarak. String Theory s. 87 ve 89'da ilk aday PDF'le birebir ve KaTeX-geçerli (eski deneme geçersiz), ~25 sn, 2,4 GB VRAM. Görünüm artık `<!-- vc:… -->` satırlarını düz metin göstermiyor. `12123b3` `b86d006`
- 2026-10-17: KaTeX'te kalan formüllerin elle düzeltmesi (#5): 139 formülün her biri kaynak PDF'in sayfa görüntüsüyle karşılaştırıldı (PyMuPDF ile sayfa bulma); 134'ü için karar `docs/dev/katex-elle-2026-10-17.json`'da (kod/asm/SML/MATLAB blokları kod bloğuna, `\neqq`→`\not\equiv`, `\llangle`→`\angle`, Alexander cevap anahtarındaki fazörler `\angle`'a, `\text{}` içinde kalan matematik dışarıya, tırnakların formül sanılması düzyazıya; kesik `\quad` döngüsüyle kaybolan 9 kod bloğu PDF'ten yeniden yazıldı). Uygulayıcı `scripts/katex-manual-fix.mjs` (kuru çalışma varsayılan, yedekli, KaTeX kapısı, CRLF korunur). 37 dosyanın kopyasında düzeltilemeyen 139 → 41, kod sanılmış 36 → 0. Kullanıcı kasaya yazdı (yedek `vault-chat-yedek\katex-2026-10-17c`): kasada düzeltilemeyen 145 → 47, kod sanılmış 36 → 0. Kalan 47: 23 MIPS HTML tablo hücresi (Öneriler), 19 kesik `\quad` döngüsü/dev dizi (#3), 3 doğrulanamayan (Öneriler). `961b817`
- 2026-10-17: tek komut MCP kurulumu (#43): `npx vault-chat-mcp setup` (ya da `npm run mcp:setup`) veri klasörünü seçiyor, Claude Desktop / Claude Code / LM Studio'ya yedek alarak kaydediyor (başka anahtarlar ve sunucular korunuyor, geçersiz JSON'a dokunmuyor), 5 notluk "Örnek Kasa"yı oluşturup MCP'ye açıyor ve indeksliyor; `--dry-run`, `--client`, `--data-dir`, `--no-sample`. Geçici klasörde uçtan uca: yapılandırma birleşti, ikinci çalıştırma "zaten güncel", gerçek MCP çağrısıyla `list_vaults` / `search_library` / `get_note` doğru not ve bölümü döndürdü. README'de "Tek komutla kurulum".
- 2026-10-17: KaTeX temizliğine kesin karşılıklı kurallar (#5): parantezsiz `\pmb \mathbb Z` → `\pmb{\mathbb Z}`, `\muA` → `\mu A`, sondaki tek fazla `}`, `\sb` → `_`, `\framebox` → `\fbox`. Geliştirme kasasında 20 formül (20'si elle gözden geçirildi), düzeltilemeyen 165 → 145; kullanıcı yazdı (yedek `vault-chat-yedek\katex-2026-10-17b`). `2687a96`
- 2026-10-17: yalnız `\text{}` satırlarından oluşan 6 formül ```text bloğuna çevrildi (MIPS 5, Horowitz 1; kullanıcı yazdı, yedek `vault-chat-yedek\katex-2026-10-17`) (#5). `893e2f8`
- 2026-10-17: formül modelinin grafikli decode'unda `repeat_kv`'siz GQA dikkati (#82 son madde): adım 10,3 → 8,3 ms (Carroll), uçtan uca Likharev 30 s. 87 → 73 sn, bgnet 47 → 36, Carroll 86 → 78, JeffE 52 → 48; 4 belgede Markdown ve 152 formül birebir aynı. `VC_FORMULA_GQA=0` kapatır. `docs/dev/formul-hiz-olcum-2026-10-16.md`
- 2026-10-16: formül grubunun kırpımı ve işlemcisi GPU decode'la örtüşüyor (#82): zenginleştirme Carroll 30 s. 54,7 → 45,4 sn, Likharev 52,3 → 40,5; iki belgede Markdown birebir aynı. `VC_FORMULA_PREFETCH=0` kapatır. Genişliğe göre sıralama denendi: kazanç yok, bir formülde çıktı değişti; bırakıldı. `d1b81c6`
- 2026-10-16: MinerU yedeğinin grup boyutu varsayılanı 4 → 12 (kullanıcı kararı, #82): Carroll 30 s. yedek 36 → 21 sn, +0,5 GB VRAM; 25 formülün 3'ünde tek-token farkı, biri 12'de daha doğru. `VC_FORMULA_FALLBACK_BATCH=4` eskiye döndürür. Uçtan uca yeniden ölçülmedi.
- 2026-10-16: yerel modellerle MCP deneyi (#39): `bench/mcp-yerel-model.mjs`, 10 görev × qwen3 8b/4b × düşünme açık/kapalı (Ollama). En iyisi qwen3:4b düşünme açık (8/10); 8b kasa kimliğini tahmin ediyor ve uyduruyor (3–4/10); 4b düşünme kapalıyken akıl yürütmeyi cevaba sızdırıyor. MCP sunucusu kasa adını da kabul ediyor, hatada erişilebilir kasaları listeliyor, `npm run index` yerine uygulamadaki yolu söylüyor: araç hataları 6 → 2, başarı oranı değişmedi. `docs/dev/mcp-yerel-model-2026-10-16.md` `daac314` `553cbe6`
- 2026-10-16: formül/kod modelinin decode'u CUDA grafiğiyle (#82): token başına 33 → 7–10 ms, toplam dönüşüm 1,3–1,8 kat (Carroll 30 s. 221 → 144 sn, Likharev 198 → 135, bgnet 88 → 49). Stokla 320 blokta 6 tek-token farkı, PDF'le elle bakıldı, hiçbiri içerik hatası değil; KaTeX iki modda 0 hata. `VC_FORMULA_CUDA_GRAPH=0` kapatır. `6f5297d`
- 2026-10-16: formül kırpımında parça bulma ızgarayla (#82): `prepare_element` 25,5 → 5,3 sn (Carroll 30 s.), çıktı birebir aynı (300 rastgele + 108 gerçek sayfa çağrısı, Markdown). MinerU yedeğinin grup boyutu `VC_FORMULA_FALLBACK_BATCH` ile ayarlanabilir, varsayılan 4. `e172d97` `9a3ac39`
- 2026-10-16: uzun PDF'ler 150 sayfalık parçalarla dönüştürülüyor (#83): AIMA 1–300 tepe RAM 8,7 → 5,4 GB, 1151 sayfanın tamamı 6,7 GB / 35 dk (parçasız ~25 GB olurdu); Markdown'da tek fark parça sınırındaki kenar notu. Parça birleştirmede kayan sayfa numaraları da düzeldi. `217e901`
- 2026-10-15: #2 Fizik yeniden içe aktarma bitti: 11 not, KaTeX hataları 48 → 0 (kasanın 18 notunda 0); kozmoloji/QM'de ~22 `∞`→`∝` düzeldi. Elle PDF karşılaştırması: 45 eski hata noktası → çoğu sayfa numaralı görsel; yanlış/yarım/regresyon olan 11 formül PDF'ten elle yazıldı (adaptive (2.16)/(3.41)/s.26/s.32, motivic (5.1.8.a) ve 64 `𝕀`→`𝟙`, Carroll Maxwell, string (3.36)/(6.17) yeri, optik (11.21), SM (2.69), QM (4.122–123) ve 2 kenar etiketi, loop-QG yinelenen düzyazı, EM kenar etiketi). Hepsi revizyonlu; indeks güncel. Aynı kalan formüllerin eski hataları (ör. `\dot ν`) taranmadı.
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
