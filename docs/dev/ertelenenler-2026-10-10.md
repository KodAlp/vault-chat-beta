# Ertelenen ve açık kalan işler — 2026-10-10

Bu liste şunlardan toplandı:
- bellek notları
- `~/.claude/plans/` altındaki 35 plan dosyası
- `docs/dev/ROADMAP.md`, `docs/yol-2026-09-23.md`, `docs/plan-ogrenme-ajani-ve-performans.md`
- kod içi TODO işaretleri (anlamlı bir TODO çıkmadı)

Her madde git geçmişi ve kodla karşılaştırıldı.

**Durum:**
- **açık**: yapılmamış.
- **yapıldı?**: büyük olasılıkla yapıldı; kanıt yanında.
- **belirsiz**: kayıtlardan anlaşılamıyor.

**Büyüklük:** K = küçük, O = orta, B = büyük.

**README:** Madde README'de anlatılıyor ya da vaat ediliyorsa işaretli. Eleme kararı README'yi değiştirebilir.

**Karar sütunu:** tut / ele / yapıldı say. Gözden geçirmede doldurulur.

## 1. Formül / LaTeX doğruluğu

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 1 | Okunamayan formül görselinin altındaki ham ```latex bloğunu gizle, yerine "⚠ … s. N" bilgi satırı | formul-dongu notu (GECE 1) | açık (`ingest/formula_fallback.py:540`) | K | — | |
| 2 | Fizik'te kalan 48 KaTeX-geçersiz formül: önce onarım betiği, sonra 0.3.0 ile yeniden içe aktarma | formul-dongu notu (GECE 2) | belirsiz | O | — | |
| 3 | "Yalnız hatalı formülü onar" özelliği (sayfa + kutu, belgenin tamamını yeniden okumadan) | formul-dongu notu | açık | B | — | |
| 4 | Model kapasitesi hataları (♯, ∝): MinerU yedeğiyle düzeldi mi, ölçülmedi | formul-dongu notu | belirsiz | O | dolaylı | |
| 5 | MinerU ham kitaplarındaki KaTeX hataları (çift `\tag`, sözde kod, `\Ss`) için mekanik temizlik betiği | latex-2048 notu | açık (öneri) | K–O | — | |

## 2. İçe aktarma / dönüştürme

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 6 | Sessiz glif bozulması: docling virgülü ↪, `\|` işaretini ♣ yapıyor ve uyarı yok; pypdf ile karşılaştırma | Kolay Matematik notu | açık | O | — | |
| 7 | Taranmış PDF'e yanlış `PDF_DAMAGED` (`convert.py` sayfa sayısı kontrolü) | aynı | açık | K | — | |
| 8 | OCR Türkçe karakterleri bozuyor; OCR dil seçimi yok (Bengalce çöp çıktı) | aynı + sonraki-oturum notu | açık | O | — | |
| 9 | OCR'da geçerli ama yanlış LaTeX (Σ → `\S`), uyarı yok | aynı | açık | O | — | |
| 10 | Anlamsız önerilen başlıklar ("******", "PowerPoint Sunusu") | aynı | açık | K | — | |
| 11 | Uzun taramada `updatedAt` güncellenmiyor; görsel sayacı tutarsız (538 ≠ 486) | aynı | açık | K | — | |
| 12 | `.vhd` desteği | aynı | açık | K | — | |
| 13 | DOCX'teki Word denklem görselleri 48 px süzgecine takılıyor (`ingest/images.py:51`) | görsel-VLM notu | açık | K | — | |
| 14 | CPU yolunda kısa, kısmen taranmış PDF'te markitdown hâlâ önce çalışıyor | mcp-yazma notu | kısmen (cad513b, GPU'da düzeldi) | K | — | |
| 15 | PPTX kapı deneyi | mcp-yazma notu | belirsiz | K | — | |
| 16 | Joplin dışa aktarım düzenini gerçek bir Joplin dışa aktarımıyla doğrula | çok-dil notu, peaceful-falcon planı | açık | K | **evet** ("Ne yapar?") | |
| 17 | Yeni not uygulaması adaptörleri (Notion zip, Evernote ENEX, Bear, Logseq DB, Joplin RAW/JEX/API); arayüzde "yakında" kartları | peaceful-falcon planı | açık | B | — | |
| 18 | F15 tam kapsamı: Playwright ile JS sayfa yedeği, `manifest.jsonl`, paralel link indirme | f15 notu, plan §5.6 | açık | O | — | |
| 19 | Ses/video → metin (Whisper, .vtt/.srt) | open-notebook planı | açık (kapsam dışı sayılmıştı) | B | — | |

## 3. Notebook verileri / veri işleri

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 20 | Notebook verileri dönüşümü: 12 klasör → ayrı kasalar. Fizik bitti, dil ve bilim klasörleri kaldı | sonraki-oturum notu, durum notu | açık | B | — | |
| 21 | Rusça kasası onarımı (14 uyarılı bekleyen); İngilizce/Mandarin/İspanyolca kasa sorusu | formul-dongu notu | açık | O | — | |
| 22 | Test artıkları: "Formül Testi" kasası ve `Notebook verileri/_formul-testi/` silinsin mi | aynı | açık (karar) | K | — | |
| 23 | Yanlış adlı arXiv PDF'leri (SystemsControl, Probabilistic, TeoBanica) | aynı | belirsiz | K | — | |
| 24 | İspanyolca kasa kimliğinde yazım hatası (`isoanyolca`) | durum notu | açık | K | — | |
| 25 | Chollet docling çıktısını `yapay-zeka` kasasında yeniden indeksle | f5 notu | belirsiz | K | — | |
| 26 | Kolay Matematik kasasındaki 16 "ready" içe aktarmanın onayı | Kolay Matematik notu | açık (karar) | K | — | |

## 4. RAG / benchmark / retrieval

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 27 | Tam altın set (330 soru) koşusu | rag-benchmark notu | açık | O | — | |
| 28 | İstem/skill dili A/B (qwen3:8b için İngilizce çekirdek istem; educational-agent açık/kapalı) | aynı | açık | O | — | |
| 29 | Reranker'ı üretime al (pilotta R@5 0,74 → 0,80; ONNX int8 ölçülmedi) | aynı + pilot raporu | açık | O | — | |
| 30 | `bench/` hâlâ bge-m3'e sabit | güvenlik notu | açık | K | — | |
| 31 | Small-talk eşikleri yalnız bge-m3 için kalibre (diğer modellerde kapı kapalı) | yerel-sunucu notu | açık (bilinçli) | K | — | |
| 32 | Yalnız-FTS geri getirmesi zayıf (R@5 0,398); kök bulma yok | aynı | kısmen (0036842) | O | — | |
| 33 | Alıntı bağlantısına başlık çapası (`sourceLink.ts`) | cozy-booping planı | açık | K–O | — | |
| 34 | open-notebook'tan önerilenler: kaynak başına bağlam seviyesi, çok adımlı soru, sohbetten not kaydetme, OpenAPI, podcast | open-notebook planı | açık | B | — | |
| 35 | **Yeni (bu oturum):** kaynaklar doğru olduğu hâlde "Kaynaklar alakasız" rozeti çıkıyor (küçük kasada iki kez görüldü) | README çekimleri | açık | K–O | — | |
| 36 | **Yeni (bu oturum):** sohbet başlığı, İngilizce soruda Türkçe üretiliyor ("Binary Search ve Zaman Karmaşıklığı") | README çekimleri | açık | K | — | |

## 5. MCP

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 37 | MCP sunucusunu Tauri paketine dahil et (tek dosya ya da gömülü Node) | sonraki-oturum 4a, ROADMAP 10.5 | açık | O–B | **evet** ("Faz 10.5'e bırakıldı") | |
| 38 | Ayarlar'da "MCP istemcisine bağla" bölümü (Claude Desktop, LM Studio, Jan, genel JSON) | sonraki-oturum 4b | açık | K–O | **evet** (yalnız Claude anlatılıyor) | |
| 39 | Yerel modellerle MCP deneyi (Qwen3 8B/4B, LM Studio) | sonraki-oturum 4c | açık | O | — | |
| 40 | `edit_note` aracı + geliştirici anahtarı (varsayılan kapalı) | mcp-yazma notu, araştırma C4 | açık | O | — | |
| 41 | MCP okuma iyileştirmeleri | araştırma C5 | açık | O | — | |
| 42 | MCP'de `generate_quiz` / `generate_flashcards` | ROADMAP | açık (bilinçli ertelendi) | B | **evet** | |
| 43 | `npx` ile tek komut MCP kurulumu + örnek kasa | ROADMAP 10.5 | açık | O | — | |
| 44 | `search_library` açıklaması "v1 vector-only" diyor, oysa FTS yedekli | `mcp/tools/search-library.ts:22` | açık (eski metin) | K | — | |
| 45 | Paketli Tauri'de `mcp-endpoint.json` kapı deneyi | araştırma | belirsiz | K | — | |
| 46 | README "MCP Sunucusu (Faz 10)" bölümü salt-okunur v1'i anlatıyor; "Ne yapar?" ve AppData kaydıyla çelişiyor | tarama | açık | K | **evet** | |

## 6. Paketleme / platform / CI

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 47 | Gerçek Mac denemesi (`docs/macos-deneme-listesi.md`) | linux-macos notu | açık | O | **evet** ("beta, denenmedi") | |
| 48 | Gerçek Linux masaüstünde GUI denemesi | aynı | açık | K–O | **evet** | |
| 49 | macOS imza + notarization (yıllık 99 $) | aynı, ROADMAP | açık | O | **evet** (Gatekeeper bölümü) | |
| 50 | macOS klasör seçicinin Mac'te denenmesi | çoklu-içe-aktarma notu | belirsiz | K | — | |
| 51 | Public öncesi: geçmişte sır taraması, `desktop.yml` tetikleyicisini açma, Windows ARM, fork PR güvenliği | açık-kaynak notu | açık | O | **evet** ("yalnız `ci` dalı") | |
| 52 | CI'da `npm audit` / `cargo audit` / gitleaks | güvenlik planı P3-8 | açık | K | — | |
| 53 | Node'u (ve Python'u) pakete gömme; WebView2 çevrimdışı yükleyici | logical-penguin planı | açık (bilinçli) | B | **evet** ("Node gömülü değil") | |
| 54 | Sürüm artırma betiği (package.json + tauri.conf.json + Cargo.toml) | durum notu | açık | K | — | |
| 55 | Otomatik güncelleme; "tarayıcı / masaüstü / ikisi" kurulum seçimi | ROADMAP | açık | O | — | |
| 56 | Faz 11 canlı doğrulamaları (paketli sürümde sağlayıcı aç/kapa, `chats.db` bozma testi) | ROADMAP | belirsiz (eski) | K | — | |
| 57 | stage-server her derlemede `npm ci` çalıştırıyor | ROADMAP Faz 11 #8 | belirsiz | K | — | |
| 58 | Disk ve dal temizliği: 16 worktree, eski `claude/*` ve `feat/*` dalları, `target` ~17,5 GB | çoklu-içe-aktarma + durum notları | açık | K | — | |

## 7. Güvenlik

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 59 | Paketli sürümde negatif testler (`invoke('check_and_start')` reddi, `curl` 401) | güvenlik notu | açık | K | — | |
| 60 | İçe aktarılan dosyalar için antivirüs taraması | yol belgesi, araştırma | açık (ertelendi) | O | — | |
| 61 | "Veriyi yedekle" ayarı (şu an yalnız CLI betiği var) | güvenlik planı P3-7 | açık | O | — | |
| 62 | Erişilebilirlik denetimi, e2e form testleri, kırık link taraması | güvenlik planı P3-9 | açık | O | — | |
| 63 | ollama-gate'te olası kilitlenme (akış içinde farklı model + evict beklemesi) | çoklu-içe-aktarma notu | belirsiz | O | — | |
| 64 | Sihirbaz atlanınca `providers.json` yoksa indeksleme ENOENT veriyor | aynı | belirsiz | K | — | |

## 8. Arayüz

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 65 | Tıklanarak hiç denenmemiş arayüzler: WYSIWYG düzenleyici, MCP otomatik onay, kurulum sihirbazı, onay diyalogları, link tarama paneli, slayt destesi | durum notu, yol belgesi | belirsiz | O | — | |
| 66 | Seviye seçici ham İngilizce gösteriyor | çoklu-içe-aktarma notu | belirsiz | K | — | |
| 67 | Kalan lucide ikonlarını Material'e geçir; özel pencere çubuğu | partitioned-ember planı | açık | O | — | |
| 68 | LauncherPanel görsel denetimi | yeni-dizayn notu | belirsiz | K | — | |
| 69 | `@milkdown/plugin-math` npm'de deprecated | görsel-VLM notu | açık | O | — | |
| 70 | Düzenleyicide görsel yükleme API'si yok (görsel düğmesi yalnız bağlantı ekliyor) | aynı | açık | K–O | — | |
| 71 | CodeMirror kaynak modu CRLF'yi LF'ye çeviriyor | aynı | açık (bilinen) | K | — | |
| 72 | **Yeni (bu oturum):** sohbetteki kod bloğunda her satırın arkasında gri şerit ve sonda bir artık var; kaynak görüntüleyicide sorun yok | README çekimleri | açık | K | — | |
| 73 | **Yeni (bu oturum):** sağlayıcı etiketi "Ollama (yerel)" `providers.default.json`'da sabit Türkçe; İngilizce arayüzde de Türkçe görünüyor | README çekimleri | açık | K | — | |

## 9. Çalışma araçları / öğrenme ajanı

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 74 | Slaytta quote ve two-column düzenlerinin uygun içerikle denenmesi | yol belgesi | kısmen | K | — | |
| 75 | F7: 6 sınıflı epistemik etiket ve rozet; yeni kuralların A/B ölçümü | öğrenme-ajanı planı | açık | O | — | |
| 76 | F9'da ertelenen değerlendirme kategorileri (Memory, Personalization, Teaching) | aynı | açık | O | — | |
| 77 | F6: otomatik mod geçişi (v1 yalnız elle) | aynı | açık (bilinçli) | O | — | |
| 78 | F8: 12.000 karakter bütçesi ve `nearCtxLimit` eşiğinin yeniden ölçülmesi | aynı | açık | K | — | |
| 79 | Kapsam daraltma ve eşzamanlı üretim bildirimlerinin canlı Ollama ile denenmesi | ROADMAP | belirsiz (eski) | K | — | |
| 80 | Profil/parola kilidi ve "Coder" sayfası | scalable-parrot planı | açık (fikir) | B | — | |
| 81 | Kota defteri; sabitlenmiş sağlayıcı tercih mi kısıt mı | aynı | belirsiz (eski) | O | — | |

## 10. Performans

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 82 | Formül yoğun klasörlerin hızı (sayfa başına 15–25 sn; 200+ saatlik klasörler) | durum notu | açık | B | — | |
| 83 | 1000+ sayfalık kitaplarda bellek ölçümü | sonraki-oturum notu | açık | K | — | |
| 84 | F12 aşama 5–6 ve quantization kararı (qwen3:8b mi, iq4xs mi) | öğrenme-ajanı planı, f5 notu | belirsiz | K | **evet** (küçük GPU §3) | |

## 11. VLM / görsel

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 85 | Görsel açıklamalarını yerel VLM ile üretme (`vc:gorsel` yuvası hazır); Qwen4'e kadar ertelendi | görsel-VLM notu | açık | B | — | |

## 12. Diğer

| # | Madde | Kaynak | Durum | B. | README | Karar |
|---|---|---|---|---|---|---|
| 86 | Bedrock ve Vertex sağlayıcıları (Azure yapıldı: e61d6fd) | adaptive-frost planı | açık | O | — | |
| 87 | Uygulama yeniden açılınca Ollama ilk sohbete kadar başlamıyor; dış betikler `indexPending` alıyor | formul-dongu notu | açık (davranış) | K | — | |
| 88 | Çoklu içe aktarma ölçüm belgesi (`docs/coklu-ice-aktarma-olcum-2026-10-04.md`) yazılmadı | çoklu-içe-aktarma notu | açık | K | — | |

## Bayatlamış maddeler (yalnız kayıtlardan düşülecek)

Bu maddeler sonradan yapıldı ya da başka bir kararla geçersiz kaldı. Karar gerekmiyor; bellek notlarında ve eski belgelerde düzeltilecekler.

- **Hızlı PDF profili (`VC_PDF_PROFILE=fast`):** bırakıldı, yerine sayfa bazlı OCR geldi (b38f0e9).
- **Model açık tutma:** yapıldı (a23c4f0, 6ee3a1f).
- **"Kaynakları görüntüle" düğmesi:** yapıldı (42a377b, 8175d9c).
- **Gece işleri** (embedding CPU runner, MinerU fallback, okunamayan formül görseli): yapıldı (70589f8, 3c7ab1e, ba120ec, af3fdf1).
- **Likharev `=` glifi kaybı:** yapıldı (9d4212b); CodeFormula KaTeX hataları için de bkz. 61abccd.
- **Toplu içe aktarmada "retrying" etiketi:** yapıldı (`BatchImport.svelte`).
- **Yanıltıcı "no-embedding-match" sebebi:** yapıldı (`retrieve.test.ts`).
- **Kaspersky SELF_SIGNED hatası:** yapıldı (95ddc74, 236db8b).
- **Bellek notlarındaki "push yok / birleşmedi" ifadeleri:** artık yanlış; hepsi main 822a1dd'de ve push edildi.
- **Güvenlik sertleştirmenin "commitsiz" olduğu notu:** yanlış; a5c48e2 ile main'de.
- **Linux ACL ve `mainBinaryName` bulguları:** yapıldı (c10e711).
- **F15 "kod yazılmadı" notu ve PyMuPDF/AGPL riski:** kapandı (9faaa99).
- **MCP kaydının eski `İlter` yolunda kalması:** düzeldi (2026-09-25).
- **`coklu-ice-aktarma` dalı (7e5211c):** yerine 47e2d4c ve 77606ec geldi.
- **F11 (MinerU görsellerine VLM ile ad verme):** yerini attachments ve `vc:gorsel` aldı; VLM kısmı madde 85'te.
- **ROADMAP Faz 10'daki "salt-okunur, yazma aracı yok" çizgisi:** create_vault, import_source ve otomatik onayla aşıldı.
- **Gitea, Debian CI VM'i, macOS VM yolları:** bırakıldı (2026-10-07).
- **`.mailmap` ve lisans kararı:** yapıldı (f9d4a1d, aa83190 MIT).
- **`docs/UI-PLAN.md`, `docs/FAZ9-ADIM-1-4.md`, `docs/dev/tasks/bugfix-brief.md`:** tarihsel kayıt.
- **`plan-ogrenme-ajani-ve-performans.md` durum satırı** ("F1–F9 henüz uygulanmadı"): eski; F1–F9 ve F14 yapıldı.
