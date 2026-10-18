# Repo public olmadan önce (TODO #51)

Durum: 2026-10-18. Repo hâlâ özel; Actions dakikaları bitti, bu yüzden iş akışları yalnız `ci` dalına push'ta ve elle çalışıyor.

## 1. Geçmişte sır taraması

- 2026-10-18'de 503 commit'in tamamı yaygın anahtar biçimleri için tarandı (`git log --all -p -G`): AWS `AKIA…`, OpenAI/Anthropic `sk-…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox…`, Google `AIza…`, Hugging Face `hf_…`, `PRIVATE KEY` blokları.
  - Tek eşleşme `c0ba9a6`'daki birim testinin sahte anahtarı (`sk-abcdefghijklmnopqrstuvwxyz0123456789`, `maskKey` testi).
- Depoya hiç `.env`, `.pem`, `.key`, `.pfx` ya da `secrets.json` girmedi; geçmişte yalnız `.env.example` var.
- Takip edilen `data/providers*.json` dosyalarının geçmişinde `apiKey`/`token`/`secret` alanı yok.
- 2026-10-18: gitleaks 8.30.1 tam kural setiyle çalıştırıldı (`node scripts/security-audit.mjs --only=gitleaks`; 484 commit, ayrıca çalışma ağacı `gitleaks dir .`). Tek bulgu yanlış pozitif: `ingest/youtube_transcript_test.py`'deki YouTube altyazı dil anahtarı `en-qlPKC2UN_YU` (`generic-api-key`). Geçmişteki hali `.gitleaksignore`'da parmak iziyle, güncel satır `# gitleaks:allow` ile işaretli. Şimdi sızıntı yok. `security.yml` gitleaks'i CI'da kendisi kuruyor ve aynı `.gitleaksignore`'u okuyor.

## 2. Tetikleyiciyi açmak

`desktop.yml` ve `security.yml` şu an yalnız `push: branches: [ci]` ve `workflow_dispatch` ile çalışıyor. Public olunca:

1. `desktop.yml`: `on:` bloğuna `push: branches: [main]` ve `pull_request:` ekle.
2. `security.yml`: yorumdaki haftalık `schedule` satırını aç; `pull_request:` ekle.
3. Dal koruması: main'e doğrudan push kapalı, `build (windows-x64)` ve `security` zorunlu kontrol.

## 3. Fork PR güvenliği

- `pull_request_target` hiçbir iş akışında yok ve eklenmemeli. Fork PR'ları `pull_request` ile çalışır, sırlara ve yazma jetonuna erişemez.
- Her iki iş akışında `permissions: contents: read` var; yazma izni isteyen adım yok.
- İş akışları sır kullanmıyor (imza yok). macOS imzası (#49) eklenince sırlar yalnız `main`/etiket push'unda kullanılmalı, PR'da asla.
- Ayarlar → Actions → "Fork pull request workflows from outside collaborators": **Require approval for all outside collaborators**.
- Üçüncü taraf eylemler sürüm etiketine sabit (`@v4`). Public olunca commit SHA'ya sabitlemek daha güvenli.

## 4. Windows ARM64

- `desktop.yml`'ye `windows-11-arm` satırı eklendi. Tetikleyici değişmediği için hiçbir şey çalışmadı, derleme denenmedi.
- `scripts/fetch-python-runtime.mjs` mimariye göre seçiyor: aynı python-build-standalone sürümünün (20261013, CPython 3.12.15) `aarch64-pc-windows-msvc` arşivi SHA256'sıyla sabitlendi.
- Gömülü Node, sahnelemeyi yapan Node'un kopyası. ARM koşucusunda ARM64 Node gelir.
- **Engel: sqlite-vec 0.1.9'un `windows-arm64` paketi yok.** `indexer/db.ts` ve `retrieve.ts` onu koşulsuz yüklüyor. Yüklenemezse yalnız vektör arama değil, FTS de açılmaz. Yerel ARM derlemesi için iki yol var:
  - sqlite-vec yüklenemezse kasayı yalnız-FTS moduna düşür (kod değişikliği), ya da
  - sqlite-vec'i ARM64 için kaynaktan derleyip pakete koy.
- Ara çözüm: x64 kurulum dosyası Windows 11 ARM'de emülasyonla çalışır (Node, Python ve sqlite-vec x64). Gerçek ARM makinede denenmedi.
- Python tarafında docling/torch için Windows ARM64 tekerlekleri sınırlı. Ağır PDF hattı ARM'de büyük olasılıkla çalışmaz; hafif paketler (markitdown, trafilatura, pypdf) saf Python ya da ARM tekerlekli.
