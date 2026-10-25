# Repo public olmadan önce (TODO #51)

Durum: 2026-10-25. Repo hâlâ özel. Tetikleyiciler açıldı; `desktop.yml` derlemesi repo özelken yalnız `ci` dalında ve elle çalışıyor (bkz. bölüm 2).

## 1. Geçmişte sır taraması

- 2026-10-18'de 503 commit'in tamamı yaygın anahtar biçimleri için tarandı (`git log --all -p -G`): AWS `AKIA…`, OpenAI/Anthropic `sk-…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox…`, Google `AIza…`, Hugging Face `hf_…`, `PRIVATE KEY` blokları.
  - Tek eşleşme `c0ba9a6`'daki birim testinin sahte anahtarı (`sk-abcdefghijklmnopqrstuvwxyz0123456789`, `maskKey` testi).
- Depoya hiç `.env`, `.pem`, `.key`, `.pfx` ya da `secrets.json` girmedi; geçmişte yalnız `.env.example` var.
- Takip edilen `data/providers*.json` dosyalarının geçmişinde `apiKey`/`token`/`secret` alanı yok.
- 2026-10-18: gitleaks 8.30.1 tam kural setiyle çalıştırıldı (`node scripts/security-audit.mjs --only=gitleaks`; 484 commit, ayrıca çalışma ağacı `gitleaks dir .`). Tek bulgu yanlış pozitif: `ingest/youtube_transcript_test.py`'deki YouTube altyazı dil anahtarı `en-qlPKC2UN_YU` (`generic-api-key`). Geçmişteki hali `.gitleaksignore`'da parmak iziyle, güncel satır `# gitleaks:allow` ile işaretli. Şimdi sızıntı yok. `security.yml` gitleaks'i CI'da kendisi kuruyor ve aynı `.gitleaksignore`'u okuyor.

## 2. Tetikleyiciyi açmak

Yapıldı, public olunca iş akışlarına dokunmak gerekmiyor:

1. `security.yml`: main ve `ci` push'u, PR, haftalık (pazartesi 06:00 UTC) ve elle (2026-10-23 `29f030d`). Repo özelken de çalışır; ubuntu üzerinde kısa bir iş.
2. `desktop.yml` (2026-10-25): main ve `ci` push'u, `v*` etiketleri, PR ve elle. Yalnız belge değişikliği (`*.md`, `docs/`) derleme başlatmaz. İşin `if` koşulu repo özelken main, etiket ve PR çalışmalarını atlıyor (koşucu açılmaz, dakika harcanmaz); public olunca kendiliğinden çalışırlar. Aynı dala yeni push eski derlemeyi iptal eder. Windows ARM64 `continue-on-error` ile çalışır, başarısızlığı sonucu kırmızıya çevirmez.

Kalan, public olunca: dal koruması (main'e doğrudan push kapalı, `build (windows-x64)` ve `npm audit / cargo audit / gitleaks` zorunlu kontrol).

## 3. Fork PR güvenliği

- `pull_request_target` hiçbir iş akışında yok ve eklenmemeli. Fork PR'ları `pull_request` ile çalışır, sırlara ve yazma jetonuna erişemez.
- Her iki iş akışında `permissions: contents: read` var; yazma izni isteyen adım yok.
- İş akışları sır kullanmıyor (imza yok). macOS imzası (#49) eklenince sırlar yalnız `main`/etiket push'unda kullanılmalı, PR'da asla.
- Ayarlar → Actions → "Fork pull request workflows from outside collaborators": **Require approval for all outside collaborators**.
- Üçüncü taraf eylemler commit SHA'ya sabit, yanında sürüm yorumu var (`# v4`), 2026-10-21 `946a100`.

## 4. Windows ARM64

- `desktop.yml`'de `windows-11-arm` satırı var (`experimental: true`, başarısızlığı sonucu bozmaz). Henüz hiç çalışmadı, derleme denenmedi.
- `scripts/fetch-python-runtime.mjs` mimariye göre seçiyor: aynı python-build-standalone sürümünün (20261013, CPython 3.12.15) `aarch64-pc-windows-msvc` arşivi SHA256'sıyla sabitlendi.
- Gömülü Node, sahnelemeyi yapan Node'un kopyası. ARM koşucusunda ARM64 Node gelir.
- **sqlite-vec 0.1.9'un `windows-arm64` paketi yok.** 2026-10-21'den beri (`014b43e`) yüklenemezse kasa yalnız-FTS ile açılıyor: indeksleyici gömmesiz yazar, arama anahtar kelimeyle çalışır. Vektör arama ARM64'te ancak sqlite-vec kaynaktan derlenip pakete konursa gelir. Gerçek ARM makinede denenmedi.
- Ara çözüm: x64 kurulum dosyası Windows 11 ARM'de emülasyonla çalışır (Node, Python ve sqlite-vec x64). Gerçek ARM makinede denenmedi.
- Python tarafında docling/torch için Windows ARM64 tekerlekleri sınırlı. Ağır PDF hattı ARM'de büyük olasılıkla çalışmaz; hafif paketler (markitdown, trafilatura, pypdf) saf Python ya da ARM tekerlekli.
