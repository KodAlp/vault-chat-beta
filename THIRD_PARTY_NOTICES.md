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

## Rust (masaüstü kabuğu, `src-tauri/Cargo.toml`)

| Crate | Lisans |
|---|---|
| `tauri`, `tauri-build`, `tauri-plugin-dialog`, `tauri-plugin-log`, `tauri-plugin-opener` | Apache-2.0 OR MIT |
| `serde`, `serde_json`, `log`, `getrandom`, `windows`, `win32job` | MIT OR Apache-2.0 |
| `tokio` | MIT |

**Geçişli crate'ler (`cargo metadata`, 2026-09-28):** MPL-2.0 lisanslı olanlar `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short` (Tauri'nin HTML işleme zinciri) ve `option-ext`. MPL-2.0 dosya bazlı zayıf copyleft'tir: bu crate'ler değiştirilmeden kullanıldığı sürece uygulamanın kendi kodu için bir yükümlülük doğurmaz. `r-efi` çoklu lisanslıdır (MIT OR Apache-2.0 OR LGPL); MIT seçeneği kullanılır. GPL/AGPL yok.

## Dağıtım notu (installer)

NSIS installer'ı, `dist-server/` altında sidecar'ın üretim `node_modules` klasörünü de taşır. MIT/BSD/ISC lisansları, lisans metninin dağıtımla birlikte verilmesini ister; bu metinler her paketin kendi `node_modules/<paket>/LICENSE` dosyasında installer'la birlikte gelir. Tam liste `npx license-checker --production` ile üretilebilir.

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
| `marker-pdf` | Kod: Apache-2.0 · **Model ağırlıkları: değiştirilmiş AI Pubs Open RAIL-M** (aşağıya bakın) |
| `docling` | MIT |

**⚠️ marker model ağırlıkları ticari kısıtlıdır.** Ağırlıklar ilk kullanımda indirilir; bu repoda ya da installer'da yoktur. Lisansları araştırma, kişisel kullanım ve yıllık geliri/fonu 5 milyon doların altındaki girişimler için ücretsizdir; bunun ötesindeki ticari kullanım Datalab'dan ayrı lisans gerektirir (bkz. https://github.com/datalab-to/marker). Vault Chat marker'ı varsayılan olarak kurmaz; kurmaya karar veren kullanıcı bu koşulları kabul etmiş olur.

**PyMuPDF kullanılmıyor** — hiçbir yerde import edilmiyor (Aşama 1'de kod incelemesiyle kapatılan bir karar, Aşama 12'de tekrar doğrulandı). Kullanılsaydı AGPL/ticari çift lisans riski olurdu; proje bunu bilinçli olarak dışarıda tutuyor.

## Fontlar

`static/fonts/` altında self-host edilen Satoshi (sans) ve Gambetta (serif) — ikisi de Fontshare'den, ITF Free Font License (FFL) ile lisanslı; uygulamada kullanımı ve yeniden dağıtımı serbest (bkz. `static/fonts/FFL-Satoshi.txt`, `static/fonts/FFL-Gambetta.txt`). Monospace için sistem yazı tipleri kullanılır, font dosyası dağıtılmaz.

## Modeller (uygulamanın çalışma zamanında kullandığı, repoya dahil olmayan)

Ollama üzerinden çalıştırılan modeller (`qwen3`, `bge-m3` vb.) bu repoya dahil değil — kullanıcı kendi Ollama kurulumuna kendi seçtiği modeli çeker, her modelin kendi lisansı geçerlidir (Ollama'nın model kütüphanesinde belirtilir).
