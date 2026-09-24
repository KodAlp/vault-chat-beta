# Üçüncü Taraf Bildirimleri

Bu proje (MIT lisanslı, bkz. `LICENSE`) aşağıdaki açık kaynak bağımlılıkları kullanır. Liste **doğrudan** bağımlılıklarla sınırlı (npm `dependencies` + Python `ingest/requirements*.txt`) — geçişli (transitive) bağımlılıkların tam listesi orantısız derecede uzun olurdu (233 üretim paketi); tam liste `npx license-checker --production` ile yeniden üretilebilir.

**Tarama sonucu (2026-09-24):** hiçbir bağımlılıkta (doğrudan ya da geçişli) copyleft lisans (GPL/AGPL/LGPL) yok — yalnızca MIT, Apache-2.0, BSD, ISC, MPL-2.0, Unlicense ve benzeri izin verici lisanslar.

## Node.js / npm (üretim bağımlılıkları)

| Paket | Lisans |
|---|---|
| `@internationalized/date` | Apache-2.0 |
| `@lucide/svelte` | ISC |
| `@marp-team/marp-core` | MIT |
| `@tauri-apps/api` | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-opener` | MIT OR Apache-2.0 |
| `@vscode/markdown-it-katex` | MIT |
| `better-sqlite3` | MIT |
| `bits-ui` | MIT |
| `chokidar` | MIT |
| `clsx` | MIT |
| `dompurify` | (MPL-2.0 OR Apache-2.0) |
| `fflate` | MIT |
| `gray-matter` | MIT |
| `katex` | MIT |
| `markdown-it` | MIT |
| `markmap-lib` | MIT |
| `markmap-view` | MIT |
| `paneforge` | MIT |
| `robots-parser` | MIT |
| `shiki` | MIT |
| `sqlite-vec` | MIT OR Apache-2.0 |
| `tailwind-merge` | MIT |
| `tailwind-variants` | MIT |
| `undici` | MIT |
| `zod` | MIT |

## Python (`ingest/requirements.txt`)

| Paket | Lisans |
|---|---|
| `markitdown` | MIT |
| `yt-dlp` | Unlicense |
| `trafilatura` | Apache-2.0 |
| `py-asciimath` | MIT |
| `pypdf` | BSD-3-Clause |
| `lxml` (trafilatura/py-asciimath'ın geçişli bağımlılığı, ayrıca doğrudan içe aktarılıyor) | BSD-3-Clause |

## Python (`ingest/requirements-optional.txt` — varsayılan kurulu değil)

Yalnızca kullanıcı matematik-yoğun/taranmış PDF dönüştürme için elle kurarsa devreye girer (bkz. `.claude/skills/source-ingest/SKILL.md`).

| Paket | Lisans |
|---|---|
| `marker-pdf` | Apache-2.0 |
| `docling` | MIT |

**PyMuPDF kullanılmıyor** — hiçbir yerde import edilmiyor (Aşama 1'de kod incelemesiyle kapatılan bir karar, Aşama 12'de tekrar doğrulandı). Kullanılsaydı AGPL/ticari çift lisans riski olurdu; proje bunu bilinçli olarak dışarıda tutuyor.

## Fontlar

`static/fonts/` altında self-host edilen Fraunces, Schibsted Grotesk ve IBM Plex Mono — üçü de SIL Open Font License 1.1 ile lisanslı (bkz. `static/fonts/OFL.txt`).

## Modeller (uygulamanın çalışma zamanında kullandığı, repoya dahil olmayan)

Ollama üzerinden çalıştırılan modeller (`qwen3`, `bge-m3` vb.) bu repoya dahil değil — kullanıcı kendi Ollama kurulumuna kendi seçtiği modeli çeker, her modelin kendi lisansı geçerlidir (Ollama'nın model kütüphanesinde belirtilir).
