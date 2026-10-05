# UI translation glossary

Kararlar bir kez verilir, her dilde aynı uygulanır. Kaynak katalog `messages/en.json`
(anlam şüphesinde `tr.json` esas alınır). Yeni bir dil eklerken bu dosyayı okuyun.

## Hiç çevrilmeyenler

- Ürün / servis adları: Vault Chat, Obsidian (yalnız içe aktarma kaynağı adı olarak), Ollama, MCP,
  Claude, DeepSeek, OpenAI, Azure, Gemini, Kimi, Tauri, Python, Pandoc, docling,
  MinerU, YouTube, GitHub, Hugging Face, Whisper, WebView2.
- Not uygulaması adları (Kütüphane içe aktar kartları): Obsidian, Logseq, Joplin, Zettlr, Foam, Dendron, Notion,
  Evernote, Bear, Notesnook, Capacities, Heptabase, Tana, SiYuan, Trilium Notes, Anytype, AFFiNE, Roam Research,
  Google Keep, Apple Notes. Bu adlar yalnız `LibraryImport.source_*` / `flavor_*` anahtarlarında geçebilir.
- Biçim ve teknoloji adları: PDF, DOCX, PPTX, XLSX, EPUB, HTML, Markdown, LaTeX,
  KaTeX, JSON, YAML, URL, API, GPU, CPU, RAM, VRAM, SSE, HTTP(S), CSV, SQLite,
  FTS, RAG.
- Model kimlikleri (`qwen3:8b`, `bge-m3` …), dosya uzantıları, yollar, ortam
  değişkenleri, klavye kısayolları (Ctrl+S, Shift+Enter, Esc, F11).
- `{yer_tutucu}` adları — birebir kalır, yalnız cümle içindeki yeri değişebilir.
- Emoji ve işaretler (⚠, ×, →, …).

## Terim kararları

| Kavram (en) | Karar | Gerekçe |
|---|---|---|
| vault | Dilde yerleşik, kişisel not koleksiyonu anlamındaki karşılık (de *Tresor*, es *bóveda*, fr *coffre*, pt *cofre*, ru *хранилище*, ja *保管庫*, zh-CN *仓库*). Yerleşik karşılık yoksa *vault*. | Kavram kullanıcıların not uygulamalarından aşina olduğu "kasa / depo" fikridir; uygulama adı (Vault Chat) ile tutarlı kalır. |
| library | "kütüphane"nin doğal karşılığı | Vault içindeki not ağacı. |
| source | doğal karşılık (kaynak) | Sohbette alıntılanan not. |
| library import | "kütüphane içe aktarma" anlamı (tr *Kütüphane içe aktar*) | Başka not uygulamalarından (Obsidian, Logseq, Joplin…) not kütüphanesi getirme sayfası; "import" burada kopyalama + dönüştürme demektir. |
| embedding / embedding model | Dilde yerleşik teknik terim (zh 嵌入, ja 埋め込み); yoksa *embedding* | Teknik kullanıcı kitlesi. |
| chunk | Dilde yerleşik karşılık yoksa *chunk* | |
| index / reindex | "dizin(le) / yeniden dizinle" anlamındaki doğal fiil | Arama dizini anlamında, klasör değil. |
| provider | doğal karşılık ("sağlayıcı") | Model sağlayıcısı. |
| prompt | dilde yerleşikse onu, değilse *prompt* | |
| skill | doğal karşılık ("beceri"); dosya adları çevrilmez | Kullanıcı beceri dosyaları. |
| quiz / test | doğal karşılık | Uygulamadaki çoktan seçmeli test. |
| flashcard (knowledge card) | doğal karşılık ("bilgi kartı") | |
| mind map | doğal karşılık | |
| small talk | "gündelik sohbet" anlamı | Kaynaksız selamlaşma kapısı. |
| hedge phrase | "belirsizlik ifadesi" anlamı | Model yanıtındaki "sanırım/olabilir". |
| thinking (model) | "düşünme" anlamı | Akıl yürütme paneli. |

## Üslup

- Arayüz dili kısa ve doğrudan; düğmeler eylem fiili (Kaydet, Sil).
- Kullanıcıya hitap: dilin yazılım arayüzlerindeki olağan biçimi — de "du",
  fr "vous", es "tú", pt "você" (Brezilya), ru "вы", hi/ur/bn saygılı biçim,
  ja/zh nötr-kibar, id "Anda", ar/ar-EG ikinci tekil eril-nötr.
- `pcm` (Nijerya Pidgini) ve `ar-EG` (Mısır Arapçası): arayüz metinlerinde bu
  diller nadir; çeviri model üretimidir, ana dil konuşanı denetimi önerilir.
  `ar-EG` günlük Mısır kullanımına yaslanır ama teknik terimlerde MSA ile aynı
  kalır.

## Çoğul biçimler

`{count}` içeren bir anahtarın dilbilgisi farklı biçim istiyorsa aynı ad alanına
`anahtar#one`, `anahtar#two`, `anahtar#few`, `anahtar#many`, `anahtar#zero`
varyantları eklenir (`Intl.PluralRules` kategorileri). Taban `anahtar` her zaman
bulunur ve `other` biçimidir.
