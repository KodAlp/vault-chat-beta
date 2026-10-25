# Üçüncü Taraf Bildirimleri

Bu proje (Apache 2.0 lisanslı, bkz. `LICENSE` ve `NOTICE`) aşağıdaki açık kaynak bağımlılıkları kullanır. Liste **doğrudan** bağımlılıklarla sınırlı (npm `dependencies` + Python `ingest/requirements*.txt`) — geçişli (transitive) bağımlılıkların tam listesi orantısız derecede uzun olurdu (233 üretim paketi); tam liste `npx license-checker --production` ile yeniden üretilebilir.

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

## Windows paketine gömülü çalışma zamanları

Windows kurulum dosyası (`dist-server/`, bkz. `scripts/stage-server.mjs` ve `scripts/fetch-python-runtime.mjs`) iki çalışma zamanını yeniden dağıtır:

| Bileşen | Lisans | Not |
|---|---|---|
| **Node.js 22** (`node/node.exe`) | MIT (Node.js'in kendi lisansı; içindeki V8, OpenSSL, ICU, libuv, zlib, undici vb. bileşenlerin lisansları için bkz. https://github.com/nodejs/node/blob/main/LICENSE) | Derleme makinesindeki resmi Node binary'si olduğu gibi kopyalanır; Node'un `LICENSE` dosyası binary'nin yanında bulunursa `node/LICENSE` olarak pakete konur. |
| **CPython 3.12** (`python/`) — [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (Astral) derlemesi | Python: PSF License (`python/LICENSE.txt`, derlemeyle birlikte gelir); python-build-standalone betikleri MPL-2.0; derlemenin içindeki üçüncü taraf bileşenlerin (OpenSSL, SQLite, zlib, Tcl/Tk, libffi, bzip2, xz vb.) lisansları da `python/LICENSE.txt` içinde listelenir | Sürüm/özet `scripts/fetch-python-runtime.mjs` içinde sabitlenir (SHA256 doğrulanır). |

## Python (`ingest/requirements-optional.txt` — varsayılan kurulu değil)

Yalnızca kullanıcı matematik-yoğun/taranmış PDF dönüştürme için elle kurarsa devreye girer.

| Paket | Lisans |
|---|---|
| `marker-pdf` | Kod: Apache-2.0 · **Model ağırlıkları: değiştirilmiş AI Pubs Open RAIL-M** (aşağıya bakın) |
| `docling` | MIT |

**⚠️ marker model ağırlıkları ticari kısıtlıdır.** Ağırlıklar ilk kullanımda indirilir; bu repoda ya da installer'da yoktur. Lisansları araştırma, kişisel kullanım ve yıllık geliri/fonu 5 milyon doların altındaki girişimler için ücretsizdir; bunun ötesindeki ticari kullanım Datalab'dan ayrı lisans gerektirir (bkz. https://github.com/datalab-to/marker). Vault Chat marker'ı varsayılan olarak kurmaz; kurmaya karar veren kullanıcı bu koşulları kabul etmiş olur.

**PyMuPDF kullanılmıyor** — hiçbir yerde import edilmiyor (kod incelemesiyle kapatılan ve sonradan tekrar doğrulanan bir karar). Kullanılsaydı AGPL/ticari çift lisans riski olurdu; proje bunu bilinçli olarak dışarıda tutuyor.

## Fontlar

`static/fonts/` (ve tasarım kaynağı `yeni-dizayn/fonts/`) altında self-host edilen iki değişken font, ikisi de [SIL Open Font License 1.1](https://openfontlicense.org) ile lisanslı. OFL fontun yazılımla birlikte dağıtılmasına ve gömülmesine izin verir; lisans metni fontun yanında durur.

| Font | Kullanım | Kaynak | Lisans |
|---|---|---|---|
| Figtree | Arayüz (sans) | [google/fonts `ofl/figtree`](https://github.com/google/fonts/tree/main/ofl/figtree), © The Figtree Project Authors | OFL-1.1 (`static/fonts/OFL-Figtree.txt`) |
| Newsreader | Editoryal başlıklar (serif) | [google/fonts `ofl/newsreader`](https://github.com/google/fonts/tree/main/ofl/newsreader), © The Newsreader Project Authors | OFL-1.1 (`static/fonts/OFL-Newsreader.txt`) |

Dosyalar Google Fonts deposundaki TTF'lerin değiştirilmeden WOFF2'ye çevrilmiş halidir (glif ya da ad değişikliği yok). Formüller için `static/mathlive-fonts/` altındaki KaTeX fontları MIT lisanslıdır (KaTeX). Monospace için sistem yazı tipleri kullanılır, font dosyası dağıtılmaz.

## İkonlar

| Kaynak | Dosyalar | Lisans |
|---|---|---|
| [Material Symbols](https://github.com/google/material-design-icons) (Google) | `static/icons/*.svg` (`repeat-stroke.svg` hariç) | Apache-2.0 (`static/icons/LICENSE-material-symbols.txt`) |
| [Tabler Icons](https://github.com/tabler/tabler-icons) | `static/icons/repeat-stroke.svg` | MIT |
| [Lucide](https://lucide.dev) (`@lucide/svelte`) | Arayüzde kalan birkaç ikon | ISC |

## Modeller (uygulamanın çalışma zamanında kullandığı, repoya dahil olmayan)

Ollama üzerinden çalıştırılan modeller (`qwen3`, `bge-m3` vb.) bu repoya dahil değil — kullanıcı kendi Ollama kurulumuna kendi seçtiği modeli çeker, her modelin kendi lisansı geçerlidir (Ollama'nın model kütüphanesinde belirtilir).
