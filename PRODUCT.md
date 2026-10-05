# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Yazılım geliştiriciler ve öğrenciler — genel olarak, kişisel bir not/belge
kütüphanesi (notlar, öğrenme malzemesi) tutan herkes. Her kullanıcı kendi
yerel örneğini kendi makinesinde çalıştırır (tek-kullanıcılı kurulum,
çoklu-kiracı bir SaaS değil). Bugünkü referans kullanım/dogfooding: bu
repodaki "First brain(Software based)" vault'u — matematik, veri
yapıları&algoritmalar, işletim sistemleri, gömülü sistemler, elektronik,
veritabanları, sistem tasarımı, SvelteKit, C, Rust, Assembly domainlerini
kapsayan 12 alanlı bir yazılım/CS bilgi tabanı.

## Product Purpose
Kullanıcının kendi kütüphanesini (notlar, belgeler, kaynaklar), yerel çalışan (Ollama önerilir ama
zorunlu değil — herhangi bir yerel model sunucusu olur), etkileşimli bir
öğrenme/çalışma asistanına dönüştürmek — kaynak temelli
RAG sohbet + üretken çalışma materyalleri (quiz, SM-2 aralıklı tekrar
kartları, zihin haritası, rapor, sunum). Başarı: kullanıcı kendi
notlarından güvenilir, kaynağı gösterilebilir cevaplar alabiliyor ve aktif
hatırlama/tekrar döngüsüyle gerçekten öğreniyor — jenerik bir sohbet
arayüzü değil.

## Positioning
Tamamen yerel/gizlilik-öncelikli (yerel model sunucusu — Ollama, LM Studio,
llama.cpp...; bulut sağlayıcı isteğe bağlı ve varsayılan kapalı) — komşu ürünler (gerçek NotebookLM, bulut RAG chat
araçları, not uygulaması eklentileri) bunu aynı derinlikte veremez: (1)
hiçbir not buluta gitmeden çalışır, (2) yanıtlar SADECE retrieve edilen
kaynak parçalarına dayanır (kaynak dışı bilgi/halüsinasyon disiplinle
engellenir — distance-threshold + narrowScope mantığı), (3) tek bir
sohbet kutusunun ötesine geçip derin çalışma materyali üretimine
(quiz/kart/mindmap/rapor/slayt, hepsi kaynak atıflı) gidiyor.

## Operating Context
Kullanıcı notlarını ve belgelerini uygulamanın kendi kütüphanesine alıyor;
Obsidian, Logseq, Joplin, Zettlr gibi not uygulamalarındaki Markdown klasörleri
birer içe aktarma kaynağıdır (tek yönlü kopya). Uygulama iki modda çalışıyor:
`npm run dev` ile doğrudan SvelteKit dev sunucusu, ya da paketlenmiş bir
Tauri masaüstü uygulaması (`npm run desktop:build`) — ikisi de tek bir
localhost'a bağlı Node sürecini sarmalıyor, harici sunucu/Docker yok.
Model sunucusu (önerilen: Ollama; LM Studio, llama.cpp, vLLM, Jan gibi herhangi
bir OpenAI uyumlu yerel sunucu da olur) ayrıca kurulu/çalışır olmalı; ilk
açılıştaki kurulum sihirbazı bulup kurmaya, model seçmeye yardım eder.

## Capabilities and Constraints
- Tamamen yerel-öncelikli mimari: varsayılan yol yerel bir model sunucusu
  (Ollama önerilir, zorunlu değil), bulut sağlayıcı (örn. DeepSeek)
  yapılandırılabilir ama varsayılan kapalı — performans tercihi değil,
  ürünün temel sözleşmesi. Embedding de isteğe bağlı: yoksa arama yalnızca
  anahtar kelimeyle çalışır (anlamsal arama kapalı).
- Tek kullanıcı / localhost: kimlik doğrulama yok, çoklu kullanıcı/kiracı
  yok — kasıtlı bir kapsam sınırı.
- İkili çalıştırma modu: `npm run dev` ve paketlenmiş Tauri masaüstü
  uygulaması — ikisi de korunmalı, ikisi de aynı `build/`'dan üretiliyor.
- Çoklu-vault desteği var — kullanıcı birden fazla kütüphaneyi (vault)
  ayrı ayrı oluşturabilir.
- Üretken materyaller yalnızca retrieve edilen kaynaklara atıfla üretilir;
  boş/kapsam-dışı sonuçlarda halüsinasyon yerine "kapsamı genişlet"
  önerisi sunuluyor.
- **Açık karar**: arayüz dili bugün tamamen Türkçe (mevcut kod tabanında)
  ama bu, genel geliştirici/öğrenci hedef kitlesi göz önüne alındığında
  kalıcı bir kısıt olarak teyit edilmedi — çok dilli destek gelecekte
  gündeme gelebilir, henüz karar verilmedi.
- Salt-okunur MCP sunucusu (`npm run mcp`) Claude Code/Desktop ve diğer
  MCP istemcilerine 4 araç sunuyor: `list_vaults`, `search_library`,
  `get_note`, `list_sources`. Bu yalnızca bir erişim katmanı — uygulamanın
  kendi davranışını değiştirmiyor; yazma/üretim araçları
  (`generate_quiz`, `generate_flashcards`) v1 kapsamı dışında bırakıldı.

## Brand Commitments
Ürün adı: "Vault Chat" (eski çalışma adı "Vault Agent Toolkit" artık kullanılmıyor). Marka kimliği
DESIGN.md'de tanımlı: koyu gözlemevi sistemi, tek canlı yeşil accent,
Fraunces/Schibsted Grotesk/IBM Plex Mono üçlü tipografi. Bu, mevcut kod
tabanındaki varsayılan shadcn görünümünün (bkz. src/app.css) kasıtlı bir
yeniden tasarım hedefi — henüz uygulanmadı.

Açık kaynak/hukuki olgunluk (PRODUCT.md'nin ilk yazımından sonra teyit
edildi): MIT Lisansı (Copyright © 2026 Alp Ökmen), kamuya açık repo.
Yönetişim/hukuki dosyalar mevcut: PRIVACY.md, SECURITY.md (özel GitHub
Security Advisory ile bildirim, açık issue değil), TERMS.md,
CODE_OF_CONDUCT.md, CONTRIBUTING.md. CONTRIBUTING.md'nin kendi
çerçevelemesiyle "küçük, bireysel bir açık kaynak proje" olarak
konumlandırılıyor — bir şirket/ekip ürünü değil. Bu, gelecekteki metin ve
iletişimde kurumsal-destek iddiaları veya ekip/şirket dilinden kaçınmayı
gerektirir.

## Evidence on Hand
Dış vaka çalışması/referans/basın yok (henüz harici kullanıcı tabanı yok).
Gerçek dogfooding kanıtı: bu repodaki canlı, aktif kullanılan kütüphane (12 domain, yüzlerce not) ve vault-chat'in Faz 0-11 arası gerçek
geliştirme geçmişi (.claude/ROADMAP.md, .claude/SESSION-LOG.md).

## Product Principles
1. Gizlilik ve yerellik pazarlık konusu değil — hiçbir kullanıcı notu
   rızası olmadan buluta gitmez.
2. Cevap yalnızca gösterilebilir kaynağa dayanmalı — kaynaksız/halüsine
   içerik yerine "kapsamda yok" demek tercih edilir.
3. Sohbet bir başlangıç, hedef aktif öğrenme — üretken çalışma
   materyalleri ürünün ayrılmaz parçası, sonradan eklenmiş bir özellik
   değil.
4. Tek-süreç, Docker'sız, localhost-bağlı basitlik — kurulum sürtünmesi
   benimsenmeyi engellememeli.
5. Görsel kimlik artık DESIGN.md'nin gözlemevi sistemiyle tanımlı;
   varsayılan/jenerik shadcn görünümü kalıcı hedef değil.
