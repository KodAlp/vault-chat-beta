# Gizlilik

Bu belge, Vault Chat'in verilerinizle gerçekte ne yaptığını anlatır — kod incelemesiyle doğrulanmış, iddia değil.

## Özet

Vault Chat **yerel-öncelikli** çalışır: kasanız (notlarınız), sohbet geçmişiniz, arama indeksiniz ve ayarlarınız yalnızca kendi bilgisayarınızdaki `data/` klasöründe tutulur. Hiçbir telemetri, analitik ya da kullanım izleme kodu yoktur (kod tabanında arandı, yok). Uygulamanın kendisi hiçbir sunucuya "eve telefon etmez".

## Verileriniz nerede duruyor

- **Kasa/kütüphane içeriği** — `data/vaults/<kasa-id>/library/` (ya da eski tek-kasa kurulumda `data/library/`).
- **Sohbet geçmişi** — `data/chats.db` (SQLite).
- **Arama indeksi** (embedding + tam metin) — `data/vault-index.db` (SQLite + sqlite-vec).
- **Sınav/kart/rapor/slayt gibi üretilen çalışma materyalleri** — `data/study.db`.
- **Ayarlar, sağlayıcı listesi, kasa kaydı** — `data/*.json` (API anahtarları `data/secrets.json`'da, ayrı, şifrelenmiş şekilde tutulur — Tauri masaüstü sürümünde işletim sisteminin kendi anahtar deposu (DPAPI) üzerinden).

Hiçbiri bu repoya commit'lenmez (`.gitignore`), hiçbiri sizin izniniz olmadan ağ üzerinden başka bir yere gönderilmez.

## Ağ üzerinden giden veri — tam liste

Uygulama yalnızca şu durumlarda dış ağa istek atar, başka hiçbir zaman:

1. **Ollama (yerel)** — `http://127.0.0.1:11434` (varsayılan). Sohbet/üretim istekleri buraya gider; bu kendi makinenizde çalışan bir süreç, ağa çıkmaz.
2. **Bulut model sağlayıcıları (isteğe bağlı, açıkça onaylanmadan asla)** — DeepSeek, Google AI Studio gibi bir bulut sağlayıcı seçip kullanmak istediğinizde, uygulama önce ayrı bir onay kutusu gösterir (İ2 — "bu sağlayıcıya sohbet içeriği gönderilecek" uyarısı); onaylamadığınız bir sağlayıcıya hiçbir istek gitmez. Onay durumu `data/provider-consent.json`'da tutulur, istediğiniz zaman geri alınabilir.
3. **Model kataloğu (openrouter.ai, models.dev)** — bir bulut sağlayıcının model listesini açtığınızda, hangi modellerin mevcut olduğunu göstermek için bu iki kamuya açık kataloğa istek atılır (kişisel/sohbet verisi gönderilmez, yalnızca "mevcut modeller ne" sorusu; 24 saat önbelleğe alınır).
4. **Kaynak içe aktarma (link/YouTube)** — siz açıkça bir URL yapıştırıp "içe aktar" dediğinizde, o tek adrese (ve YouTube altyazı API'sine) istek gider. SSRF sertleştirmesi (özel/yerel IP aralıklarına, DNS-rebinding'e karşı engelleme) her istekte devrede. YouTube/harici link içe aktarmadan önce ayrı bir hak-beyanı onay kutusu gösterilir (İ4/İ5).
5. **MCP (Model Context Protocol) sunucusu** — yalnızca siz Claude Code/Desktop gibi bir MCP istemcisini elle bağlarsanız çalışır; bir kasa varsayılan olarak **kapalı**dır (İ6, `mcpExposed: false`), yalnızca siz Ayarlar'dan açtığınız kasalar dışarıdan görülebilir/okunabilir.

Bunların dışında (docling/marker gibi isteğe bağlı ağır dönüştürücüler dahil) her şey tamamen yerelde çalışır.

## Üçüncü taraf içerik ve hak sorumluluğu

Link'ten/YouTube'dan içe aktardığınız içeriğin telif durumu size aittir — uygulama yalnızca bir araçtır, içeriğin hakkını devretmez. Ayrıntı için bkz. `TERMS.md`.

## Sorularınız için

Bu bir bireysel/açık kaynak proje — resmi bir "veri koruma görevlisi" yok. Sorularınız için GitHub Issues üzerinden ulaşabilirsiniz.

---

# Privacy (EN summary)

Vault Chat is **local-first**: your vault content, chat history, search index and settings live only in `data/` on your own machine. There is no telemetry or analytics code anywhere in the codebase. The app only ever talks to the network for: (1) your local Ollama instance, (2) a cloud model provider you explicitly opted into (with its own consent dialog, revocable), (3) the public OpenRouter/models.dev model-listing catalogs (no personal data, 24h cache) when you open a provider's model picker, (4) a URL/YouTube link you explicitly paste to import (SSRF-hardened, with its own copyright-acknowledgment checkbox), and (5) an MCP client you explicitly connect, against a vault you explicitly opened for that. Nothing else ever leaves your machine.
