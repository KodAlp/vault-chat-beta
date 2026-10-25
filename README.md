<p align="center">
  <img src="static/logo.png" alt="vault-chat logo" width="140" />
</p>

<h1 align="center">Vault Chat</h1>

<p align="center">
  <b>English</b> · <a href="readme/README.tr.md">Türkçe</a> · <a href="readme/README.zh-CN.md">简体中文</a> · <a href="readme/README.de.md">Deutsch</a> · <a href="readme/README.es.md">Español</a> · <a href="readme/README.fr.md">Français</a> · <a href="readme/README.ja.md">日本語</a>
</p>

<p align="center">
  <b>A local study assistant that chats with your own notes.</b><br />
  Import your documents and get answers with cited sources; generate quizzes, flashcards, reports and slides from the same sources.
</p>

<p align="center">
  <img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue" />
  <img alt="Version" src="https://img.shields.io/github/v/tag/KodAlp/vault-chat-beta?sort=semver&label=version&color=informational" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" />
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Local-first" src="https://img.shields.io/badge/data-stays%20local-success" />
</p>

<p align="center">
  <img src="docs/assets/demo-chat.gif" alt="A question is asked about the vault; the local model explains binary search using code and a formula from the notes, with source chips" width="860" />
</p>

## What it does

- **Source-grounded chat (RAG).** Answers come only from the notes in your vault; under each answer you can see which section of which note was used. Formulas are rendered with KaTeX and code is syntax-highlighted.
- **Imports any kind of source.** PDF, DOCX, PPTX, XLSX, HTML, EPUB, TeX and Markdown files, plus links and Obsidian/Logseq/Joplin/Zettlr folders, are converted to Markdown and added to the library. Formula-heavy PDFs go through a pipeline with docling and MinerU fallbacks.
- **Study tools.** From the same sources it generates multiple-choice quizzes, SM-2 spaced-repetition cards, concept maps, cited reports and slides, and tracks your progress topic by topic.
- **Multiple vaults.** Each vault has its own library and search index; they never mix.
- **Local-first.** The default path is Ollama or any OpenAI-compatible local server (LM Studio, llama.cpp, vLLM, Jan). Cloud providers are optional, off by default, and ask for separate consent in every chat.
- **MCP server.** MCP clients such as Claude Code/Desktop can search your vault, read notes and import sources; an import enters the library once you approve it in the app (or if you turn on auto-approve for the vault).
- **23 interface languages**, light/dark and warm-toned themes, as a desktop package (Tauri) or in the browser.

## Screenshots

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/home-dark.webp" />
        <img src="docs/assets/screenshots/home-light.webp" alt="Vault home screen: question box and past chats" />
      </picture>
      <p align="center"><sub>Vault home screen (light and dark theme)</sub></p>
    </td>
    <td width="50%">
      <img src="docs/assets/screenshots/chat-code.webp" alt="An answer with source chips, containing a code block and a formula" />
      <p align="center"><sub>Answer with source chips: code and formula together</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/assets/screenshots/study-panel.webp" alt="Study panel: quiz, cards, report, map, slides, progress" />
      <p align="center"><sub>Study panel: quiz, cards, report, map, slides</sub></p>
    </td>
    <td width="50%">
      <img src="docs/assets/screenshots/source-viewer.webp" alt="In-app source viewer with formulas rendered by KaTeX" />
      <p align="center"><sub>Source viewer: editing and previous versions</sub></p>
    </td>
  </tr>
</table>

<sub>The screenshots were taken in the English interface, on a demo vault of sample notes, with the local <code>qwen3:8b</code> model.</sub>

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.webp" />
  <img src="docs/assets/architecture-light.webp" alt="Vault Chat architecture: sources, converter, vault, app, model providers and clients" />
</picture>

Everything runs in a single Node process on `localhost`. No Docker or external server is needed. Your notes, the index and your chat history stay on your own machine.

## Quick start

```bash
git clone https://github.com/KodAlp/vault-chat-beta.git
cd vault-chat-beta
npm install
npm run dev
```

Then open `http://localhost:5173`. The setup wizard on first launch finds the local model server and helps you pick a chat model and an embedding model. Prerequisites (Node.js 22 and a model source), the desktop package, MCP setup and troubleshooting are covered in the detailed sections below.

To contribute, see [`CONTRIBUTING.md`](CONTRIBUTING.md); for privacy, security and terms of use, see [`PRIVACY.md`](PRIVACY.md), [`SECURITY.md`](SECURITY.md) and [`TERMS.md`](TERMS.md). The project is licensed under Apache 2.0 ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE)).

---

# Detailed setup

A local, Docker-free SvelteKit study/chat app. It does RAG over the
notes and documents in your own library; it talks to a local model server (Ollama is recommended but not required —
any OpenAI-compatible server such as LM Studio, llama.cpp, vLLM or Jan works too)
or to an optional cloud provider. A single Node process,
bound to `localhost`.

## Prerequisites

1. **Node.js 22** (`>=22 <23`; 20 and 24 do not work — check the installed version with `node --version`). The Windows desktop package bundles Node, so you do not install it separately there.
2. **A chat model source** — **Ollama is recommended** (https://ollama.com), but it is
   not required. Any one of these is enough:
   - Ollama,
   - another OpenAI-compatible local server: llama.cpp, LM Studio, vLLM, Jan,
     LocalAI,
   - a cloud provider (DeepSeek, Google AI Studio, OpenRouter...; optional,
     off by default, see `PRIVACY.md`).

   If none of them is installed, chat does not work: the app shows a
   "Setup is not complete" warning.
3. **Embedding (search) model — optional.** Any provider that supports
   embeddings will do; if you pick none, search works with keywords only (FTS)
   and semantic search is off. If you use Ollama, the recommended model is
   `bge-m3` — NOT `nomic-embed-text` (`EMBED_MODEL` in `src/lib/server/embed-config.ts`;
   it gives measurably better results on Turkish queries,
   the rationale is in the comments of embed-config.ts itself). If you do not pull a
   model you configured for embeddings on the server, `npm run index` fails with "model not found".

**Main path: the setup wizard.** It opens on first launch (in the desktop package) or
in the browser at `/setup/local-server`, and also from the "Re-run setup wizard" link
on the **Settings → Providers** page. It has three steps: (1) find/install the local server, (2) pick the chat model, (3)
pick the embedding model **or choose "keyword search only"**. If you
prefer to do it by hand, for Ollama:
```bash
ollama serve
ollama pull qwen3:8b      # recommended chat model
ollama pull bge-m3        # recommended embedding model (optional)
# optional, for deep sessions:
ollama pull qwen3:30b-a3b
```

To verify these items with one command instead of checking them by hand:
```bash
npm run doctor
```

## Installation

```bash
cd vault-chat-beta
npm install
```

The `.env` file has already been created from `.env.example`. Open it and check it if needed:

```
CHATS_DB_PATH=./data/chats.db
PUBLIC_VAULT_NAME="My Notes"  # display name of the "default" vault on first launch
```

`OLLAMA_URL` is no longer read: the address of Ollama (and of other servers) is
set in Settings → Providers, that is, in the `baseUrl` field of `providers.json`.

`PUBLIC_VAULT_NAME` is read only when the "default" vault is first created (see
`migrateVaults.ts`) as the default display name — it has no effect on
later runs. Sources always open in the app's own
viewer. Markdown folders from note-taking apps such as Obsidian, Logseq, Joplin and Zettlr are only an import
source (**Settings → Library**).

`data/providers.json` is a **seed** file shipped with this repo — a fresh
install finds some of the cloud providers (DeepSeek, Google AI Studio)
with `enabled: true`. Actually using them still requires (a) entering an API key for that
provider in `data/secrets.json` (Settings →
Providers) and (b) accepting a separate checkbox in every chat
(see `PRIVACY.md`) — `enabled: true` alone sends no
data. If you do not want to see the cloud providers even as an option in the
UI, you can set the relevant entry to
`enabled: false` in your own `data/providers.json`. The packaged desktop build does not use this file; it seeds from
`data/providers.default.json`, a clean default:
all cloud providers off, task chains empty, no embeddings
(keyword search only) — the setup wizard fills these in.

## Vaults

Instead of a single library, the app can hold **multiple vaults** — each with its
own source folder and search index, completely isolated from the others
(`data/vaults/<id>/library/`, `data/vaults/<id>/index.db`). Chat history stays in one
global DB (`data/chats.db`), and each chat records which vault it belongs to.

- To create/delete/rename vaults, use **Settings → Vaults**.
- Only one vault is "active" at a time — the chat screen and the indexer always work on the active
  vault.
- **If you are coming from an old (pre-multi-vault) install** you do not need to do anything
  — on first launch the server sees that `data/vaults.json` does not exist,
  automatically moves the contents of `LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH`
  under `data/vaults/default/` and registers a vault named "default";
  all old chats are attached to this vault. **`VAULT_PATH` is deliberately
  not moved** — in the old architecture it was a pointer to a live Markdown note folder
  (e.g. an Obsidian vault) used in place (it was never copied), not a folder owned by the app.
  Only if `VAULT_PATH` is set (as in this repo — `data/library` is empty and
  the real content is indexed in place from `VAULT_PATH=..`) does the "default" vault
  start **empty**; you then have to import the content (again) by hand
  through the import in Settings → Library. If you want to run this by hand,
  with a preview:
  ```bash
  npm run vault:migrate -- --dry-run   # reports what would be moved, writes nothing
  npm run vault:migrate                # actually moves it
  ```

## First indexing

To be able to chat, the content of the active vault must first be turned into a vector index:

```bash
npm run index
```

This scans all `.md` files in the active vault's library,
skips those without frontmatter with a warning, chunks the rest,
embeds them with the configured embedding model (recommended: `bge-m3`) and writes them to that vault's
`index.db`. If no embedding is configured (keyword-only
mode), the vector step is skipped; chunks and keyword (FTS) data are still written. It is incremental, based on sha256
— it skips unchanged files, using the same logic as `pdf2md.py`.

Flags:
- `npm run index -- --vault <id>` — indexes a specific vault instead of the active
  one (the id is the identifier shown in Settings → Vaults).
- `npm run index -- --full` — re-indexes everything from scratch (use this if the embedding
  model changed).
- `npm run index -- --dry-run` — reports what would change without writing anything.

## Everyday use

```bash
npm run dev
```

`http://localhost:5173` opens. After studying and updating notes, run
`npm run index` whenever you like — there is no conflict even while the app is open (WAL mode).

If you want automatic watching (optional, not the default):

```bash
npm run index:watch
```

## Persistent use (without the dev server)

```bash
npm run build
BODY_SIZE_LIMIT=1G node build
```

Without `BODY_SIZE_LIMIT`, adapter-node limits the request body to **512 KB**
(its own default), and every source upload above that size is rejected with 413 before it
ever reaches the route — a small `.docx` passes but a real
`.pdf`/`.pptx`/`.xlsx` does not. In the desktop package this variable is passed to the sidecar
automatically (`src-tauri/src/lib.rs`); when you run `node build` by hand
you must pass it yourself. This flow does not read `.env`; you have to
pass it as an environment variable.

## Desktop (Tauri)

A package that runs the same server in a native window instead of the browser, without
Electron. **The Windows package bundles Node.js 22 and Python 3.12 (python-build-standalone)**:
neither is installed separately, and the app always uses the bundled Node (the WebView2 installer is also
in the package). For chat you need a model source (recommended: Ollama, or another local server / cloud provider),
which is not bundled. In the macOS/Linux packages Node (and Python) are still installed by hand, see below.

```bash
npm run desktop:dev      # native window against the live Vite dev server, HMR works
npm run desktop:build    # builds the package for the operating system you are on
```

**The version number bumps itself.** Before building, `desktop:build` runs `scripts/release.mjs --auto`: it looks at the commits ([Conventional Commits](https://www.conventionalcommits.org)) since the last `v*` tag. `fix`/`perf`/`refactor` mean a patch (0.1.0 → 0.1.1), `feat` a minor version (0.1.x → 0.2.0), `!` or `BREAKING CHANGE` a major version (→ 1.0.0); `docs`, `chore`, `test` and `ci` do not change the version. The bump happens only on the `main` branch and when the version files are clean; it creates a `chore(release): vX.Y.Z` commit and a `vX.Y.Z` tag; to publish, `git push --follow-tags`. By hand: `npm run release` (preview: `npm run release -- --dry-run`).

On Windows, the `desktop:build` output is: `src-tauri/target/release/bundle/nsis/vault-chat_<version>_x64-setup.exe`
(an NSIS installer). The Linux and macOS packages are built with the same command, on their own operating
system (no cross-compilation); the targets are in `src-tauri/tauri.linux.conf.json`
(`deb`, `appimage`) and `src-tauri/tauri.macos.conf.json` (`app`, `dmg`) — see the
"Linux and macOS (new, beta)" section below. For ready-made packages, the `desktop` workflow on GitHub
Actions builds the Windows x64, Linux x64, macOS arm64 and macOS x64
packages and uploads an artifact named `vault-chat-<target>` for each
(`.github/workflows/desktop.yml`; artifacts are kept for 7 days). Windows ARM64 is also
attempted, but it is expected to fail for now and does not turn the result red.
The workflow runs on pushes to `main` and the `ci` branch, on `v*` version tags, on PRs,
and manually from the Actions tab ("Run workflow"); documentation-only changes
(`*.md`, `docs/`) do not start a build. While the repo is private, `main`, tag and PR builds
are skipped (Actions minutes are limited); to get a branch built in the meantime, use
`git push origin <branch>:ci` (with `--force` if needed) or run it manually.

Windows install location and data folder:
The install is per-user (no admin rights needed) and goes under `%LOCALAPPDATA%\vault-chat\`.
App data (chat history, vault registry, each vault's
library/index, `config.json`) is kept on Windows under `%APPDATA%\Roaming\app.vaultchat.desktop\`
(macOS: `~/Library/Application Support/app.vaultchat.desktop/`, Linux:
`~/.local/share/app.vaultchat.desktop/`) — completely separate from the `data/` folder and not
shared with the browser flow. The vault registry is resolved against the `DATA_DIR` here (the sidecar's
own environment variable, which the user does not see); the single
`vault_path`/`vault_name` pair in `config.json` is something else — it determines the name of the first-created **"default"**
vault, and additional vaults are created later in the app under Settings → Vaults.

On first launch you are asked to pick a folder (native folder picker) — this is asked for the display name
of the "default" vault;
the library content is NOT tied to it (the library is always a folder owned by the app,
see the "Vaults" section above). The choice is written to `config.json`
and is not asked again on later launches. To change this name afterwards, use
**Settings → Desktop — Vault Location** (the change takes effect at the next
start; it does not restart the running server).

Since it calls `node build/index.js` directly, everything the persistent-use flow
needs (Node 22, environment variables rather than `.env`) applies here as well —
see the note above.

## Running on another Windows machine

The Windows installer bundles Node.js 22 and Python 3.12, but not the local model server
(such as Ollama) — the model source (recommended Ollama, another local server or a cloud provider)
must be set up separately on the target machine. In the developer flow (`npm run dev` / `node build`) Node is still installed by hand. After installing on the target machine, `npm run doctor`
(developer flow) or the app's own "Local server … not running" /
"Setup is not complete" banner (desktop package) tells you what is missing.

| Component | Required | Who installs it |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Yes | Bundled in the Windows desktop package (the app always uses it); developer flow: by hand — https://nodejs.org |
| Ollama + `qwen3:8b` + `bge-m3` | **Recommended** (another local server or a cloud provider also works; without embeddings, keyword search only) | By hand — https://ollama.com, or the setup wizard |
| WebView2 Runtime | Yes (desktop package only) | Automatic — if it is missing, the NSIS installer installs it with the small bootstrapper inside it (`embedBootstrapper`); internet is needed during installation |
| Visual C++ Redistributable | Technically yes | Usually already present on Windows 10/11; if missing, by hand |
| Python 3.12+ (stable release) | No — only for PDF/document/YouTube import | Bundled (3.12) in the Windows desktop package; a system Python with docling or `PYTHON_BIN` is preferred if present. Other flows: by hand — https://python.org |
| `markitdown` and other lightweight packages (`pip install -r ingest/requirements.txt`) | No — only for PDF/document/YouTube import | In the desktop package, the app's own "Install now" banner (creates a `python-venv` from the bundled Python, internet needed); other flows: by hand |
| docling (heavy PDF/OCR) | No — optional | By hand (`pip install docling`) |
| pandoc | No — only for `.tex` conversion | By hand |

Things to watch out for:
- **ARM64 Windows is not supported.** `sqlite-vec` has only a `win32-x64`
  prebuilt package for Windows — on an ARM-based Windows machine
  (Snapdragon etc.) `npm install` fails for sqlite-vec.
- **The wrong Node version installs silently and breaks at run time.** Because `engine-strict`
  is off, `npm install` also completes with Node 20/24, but
  the native binary of `better-sqlite3` is built for Node 22's ABI — the error shows up only on
  the first database access. `npm run doctor` catches this right after
  installation.
- **`secrets.json` is not portable.** In the desktop package it is
  encrypted with AES-256-GCM; the encryption key is in the operating system's store (Windows
  DPAPI, macOS Keychain, Linux Secret Service) and is tied to the user/machine profile —
  a `secrets.json` copied to another machine/user cannot be decrypted and
  behaves as if there were "no key". Re-enter the cloud provider (DeepSeek/Gemini/Groq/...) API keys
  on the target machine in Settings → Providers.
- **Vault contents are moved by hand.** `data/vaults.json` can be moved because it re-derives its own paths on every
  read, but the actual content of each vault
  (`data/vaults/<id>/library/`, `index.db`, `study.db`) must be copied separately —
  or rebuilt on the target machine with import + `npm run index`.
- **In the Windows desktop package, only the lightweight packages for PDF/document/YouTube
  import are missing.** The `ingest/` folder and Python 3.12 are part of the install package
  (see `scripts/stage-server.mjs`, `scripts/fetch-python-runtime.mjs`); `markitdown`
  and the other packages are not in the package. On first use the app detects this via `/api/system/python`
  and shows an orange banner with an "Install now" button that
  installs `pip install -r ingest/requirements.txt` into the `python-venv` in the data folder
  for you. If a Python with docling is already present, it is preferred.

## Linux and macOS (new, beta)

> **Warning:** The Linux and macOS packages are new. They are built in CI but **have not yet
> been tried on a real Linux/macOS machine**; the macOS package is also **unsigned and
> not notarized**. They are not as mature as Windows — if you
> hit a problem, report it with the `launch.log` from the data folder (below). For a step-by-step
> macOS test checklist: [`docs/macos-deneme-listesi.md`](docs/macos-deneme-listesi.md) (Turkish).

Supported package formats (built in CI; see "Desktop (Tauri)"):

| Platform | Package | Note |
|---|---|---|
| Linux x64 | `.deb`, `.AppImage` | `.deb` depends on these packages: `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`, `libsecret-1-0` (`src-tauri/tauri.linux.conf.json`) |
| macOS (Apple Silicon and Intel) | `vault-chat.app` + `.dmg`, unsigned | macOS 11.0 and later (`minimumSystemVersion`) |

To build from source on Linux (the Ubuntu 22.04 package list used in CI):
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libsecret-1-dev libdbus-1-dev
npm install && npm run desktop:build
```

| Component | Required | How to install on Linux / macOS |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Yes — not bundled in the package | https://nodejs.org, Homebrew (`brew install node@22`), nvm/fnm/Volta or your distribution's package manager |
| Model source (Ollama recommended, another local server or a cloud provider) | One of them, for chat | By hand — https://ollama.com |
| Python **3.10+** | No — only for PDF/document/YouTube import | macOS: `brew install python@3.12`; Linux: your distribution's package manager (on Debian/Ubuntu `sudo apt install python3 python3-venv`) |
| pandoc | No — only for `.tex` conversion | Homebrew or your distribution's package manager |

What you should know:
- **How is Node found?** An app launched from the GUI does not inherit the shell's
  PATH. So `node` is looked up first in PATH (including the session/login shell's PATH)
  and then in known locations: `/usr/local/bin`, `/usr/bin`,
  `/opt/homebrew/bin`, `~/.volta/bin`, nvm (`~/.nvm/versions/node`) and fnm
  version folders (`src-tauri/src/platform.rs`, `resolve_node_binary` in
  `src-tauri/src/lib.rs`). If the major version of the Node it finds is not 22, the app
  warns at startup.
- **Python "Install now"** does not run `pip install` against the system Python on macOS/Linux
  (it would run into the Debian/Homebrew "externally managed" protection). Instead it creates an app-owned
  virtual environment (`python-venv`) in the data
  folder and installs the packages there (`src/routes/api/system/python/+server.ts`,
  `src/lib/server/python-bin.ts`). If the `python3-venv` package is missing on Debian/Ubuntu,
  the environment cannot be created and the app says so. On macOS, if the Command Line
  Tools (CLT) are not installed, the `/usr/bin/python3` placeholder is skipped
  (so that the install dialog is not triggered). A specific
  interpreter can also be given with the `PYTHON_BIN` environment variable.
- **winget is Windows-only.** On macOS/Linux the app does not run the package manager
  itself; you run the Homebrew / distribution package manager commands.
- **API keys** are protected by the operating system's store: on macOS the
  Keychain (service `app.vaultchat.desktop`, account `secrets-key`;
  a permission prompt may appear on first launch — "Always Allow"), on Linux
  Secret Service (GNOME Keyring / KWallet). If this service is missing on Linux, keys
  are stored unencrypted (in a file with `0600` permissions) and you see a
  warning in Settings → Providers; they get encrypted once you install GNOME Keyring or KWallet and restart
  the app. If the key exists but cannot be read ("locked"), nothing is
  regenerated; **Settings → Providers → "Reset saved API keys"** backs up the old file as
  `secrets.json.locked-<date>` and restarts the
  app. Details: `SECURITY.md`.
- **Background processes:** On Linux, even if the app crashes, the operating system kernel sends
  `SIGTERM` to the Node server (`PR_SET_PDEATHSIG`). On macOS there is no such
  guarantee: the server process is cleaned up only on a normal exit (Cmd+Q);
  if the app crashes or is force-quit, the `node` process may stay behind.
- **Log file:** for startup problems, `launch.log` — macOS:
  `~/Library/Application Support/app.vaultchat.desktop/launch.log`, Linux:
  `~/.local/share/app.vaultchat.desktop/launch.log`.

### macOS: opening the unsigned app (Gatekeeper)

Because the app is not signed by Apple and has not passed notarization,
macOS blocks it on first launch ("developer cannot be verified" or "damaged").
Drag `vault-chat` from the `.dmg` to **Applications**, then in Finder
**right-click → Open → Open** the app. If it still does not open, remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/vault-chat.app
```

## MCP Server

A local server that exposes the notes in your vault to MCP clients such as Claude Code/Desktop
— it needs no separate package or installation; `mcp/` lives inside this repo
in the same pattern as `indexer/`.

**In the packaged desktop app** the server ships as a single-file bundle
(`dist-server/mcp/vault-chat-mcp.mjs`, built by `scripts/build-mcp.mjs`; automatic
within `npm run stage:server`): no repo, `tsx` or other installation is needed,
the system's Node 22 is enough. The **Settings → Connect to an MCP client** card gives a ready-made configuration
pointing to this file. `node <install>/_up_/dist-server/mcp/vault-chat-mcp.mjs --print-config` (on Windows the install folder is `%LOCALAPPDATA%\vault-chat`)
prints the same block. If `DATA_DIR` is not given, the installed app's data folder is used
(`%APPDATA%\app.vaultchat.desktop`, on macOS `~/Library/Application Support/app.vaultchat.desktop`,
on Linux the same name under `$XDG_DATA_HOME` or `~/.local/share`). When running from
source code, the `mcp/launch.mjs` path applies as before. To build the bundle on its own: `npm run build:mcp`.

**Tools:**

- `list_vaults` — lists the vaults exposed to MCP (per-vault on/off: **Settings → Vaults**).
- `search_library` — searches the vault; the default (`mode: "auto"`) is vector search, with a keyword (FTS5) fallback if there are no embeddings or it returns nothing. `mode`: `vector`, `keyword` (FTS5 only, no embeddings needed) or `hybrid` (vector + FTS5, reciprocal rank fusion). Accepts `domain`/`level` filters.
- `get_note` — reads a note; `heading` returns only that heading's section, `max_chars`/`offset` give paged reading (`hash` is always that of the whole file).
- `list_domains` — lists the domain values in the vault with note counts and last-modified times.
- `list_sources` — lists the sources in the vault with their domain and level values.
- `create_vault` — creates a new vault.
- `import_source` — adds a local file or URL to the **pending** imports.
- `list_pending_imports` — shows the status of pending imports.
- `edit_note` — edits an existing note (needs `get_note`'s `hash` value as `expected_hash`; frontmatter is unchanged, the previous version is kept as a revision). **Off by default**: it is turned on only with the developer switch in **Settings**, the agent cannot turn it on; while it is off the call returns the `MCP_EDIT_NOTE_DISABLED` error.

The write tools go through the app's API, so **the app must be
open** (the app writes `mcp-endpoint.json` into `DATA_DIR`).
An imported source does not enter the library until you approve it in the app; the agent
cannot approve it itself or change the setting. Local files are read only from
folders you allow in **Settings**; URLs go through the normal web
import. If you want, you can turn on the per-vault **auto-approve MCP imports**
setting: `off` (default, you approve everything), `clean` (only those with no warnings, no review flag and
that are not duplicates) or `all` (every successful import). `all` adds content the agent
brought to search before you have seen it — keep the prompt injection risk in mind.

**One-command setup.** From source (after `npm install`), this command does everything:

```bash
npx vault-chat-mcp setup      # or: npm run mcp:setup
```

If script execution is disabled in Windows PowerShell (`npx.ps1 cannot be loaded`), type `npx.cmd vault-chat-mcp setup` or `npm.cmd run mcp:setup`.

1. **Picks the data folder:** `--data-dir` > the `DATA_DIR` environment variable (including `.env`) > the installed desktop app's folder (if any) > the repo's `data/` folder.
2. **Registers with the MCP clients it finds:** Claude Desktop (including the virtual config file of the Microsoft Store version), Claude Code (if `claude` is on PATH) and LM Studio (if `~/.lmstudio` exists). It backs the files up as `<file>.bak-YYYYMMDD-HHMMSS`, does not touch other keys or other servers, and never overwrites invalid JSON. You need to fully quit and restart Claude Desktop. For Jan and other clients, the configuration block is printed at the end.
3. **Creates a sample vault ("Örnek Kasa"):** copies 5 short lecture notes (in Turkish and English), exposes it to MCP and indexes it; you can try `search_library` / `get_note` right away. Because `vaults.json` is owned by the app, this step is skipped while the app is open: close the app and run the command again. If there is no embedding server (Ollama), the index is built with keyword (FTS5) search only; if the provider you configured is unreachable, indexing fails and, with the hint on screen, `npm run index -- --vault ornek-kasa` is run.

Options: `--client claude-desktop,claude-code,lm-studio` (registers only these; creates the folder if it does not exist), `--data-dir <folder>`, `--no-sample` (no sample vault), `--dry-run` (shows what it would do without writing anything). `npx vault-chat-mcp config` prints only the configuration block. The command can be re-run: the current registration and an existing sample vault are left as they are.

If you want to set it up by hand:

**Connecting.** The data of the installed desktop app is under `%APPDATA%\Roaming\app.vaultchat.desktop\`
(see "Desktop (Tauri)"); `DATA_DIR` must point to this folder.
If you run from source, the default is the repo's `data/` folder. For Claude
Code (without `--scope user` the registration is tied only to the directory where the command is run):

```bash
claude mcp add --scope user vault-chat -- node "<this repo>\mcp\launch.mjs"
```

To generate the block to add to `%APPDATA%\Claude\claude_desktop_config.json` for Claude Desktop,
ready-made with an **absolute** `DATA_DIR` and `node` path:

```bash
npm run mcp:config
```

The output has this form; to make it read the installed app's data, replace `DATA_DIR`
with the AppData folder above:

```json
{
  "mcpServers": {
    "vault-chat": {
      "command": "node",
      "args": ["<repo>\mcp\launch.mjs"],
      "env": { "DATA_DIR": "<data folder>" }
    }
  }
}
```

`"command"` must be `node` (or the absolute `node` path that `npm run mcp:config` prints),
not `"npx"`/`"tsx"` — on Windows both are `.cmd` shims and give `ENOENT` in
clients that spawn without a shell.

Verification:

```bash
npm run mcp:smoke   # tests the tools in a single process, without touching a real model server
```

While the server is up, a single stderr line is enough for diagnosis: `DATA_DIR=... vaults=N`.
In Claude Desktop this line lands in `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`.

## Providers and model capabilities

Which provider is used for chat is chosen in **Settings → Providers**
(or in the wizard during first setup); Ollama is just one option. A
model's tool-calling (tools) and reasoning capability is
inferred from the model name (spellings such as Ollama `qwen3:8b`, llama.cpp `Qwen3-8B-Q4_K_M.gguf`, LM Studio/vLLM
`qwen/qwen3-8b` map to the same family) and comes from the same table for every server
type. If the inference is wrong, in **Settings → Providers →
"manage model list"** each model has a **Tools** and a **Reasoning**
switch: these show the table's default, and when you
change one it writes a model-specific override (`modelCaps` in `providers.json`). On OpenAI-compatible
servers marked local (`local`) (llama.cpp,
LM Studio, vLLM), when thinking is turned off, `chat_template_kwargs: { enable_thinking: false }` is added to the request for reasoning
models (the qwen3 template);
it is never sent to cloud providers.

## Performance settings for small GPUs

> This section applies only if you use **Ollama** as the model server
> (`ollama ps`, `OLLAMA_*` variables, Modelfile). On another server such as LM Studio or llama.cpp,
> the context window and GPU layer settings are made in that server's own
> interface.

If the local model is slow, first check this: while a model is loaded, is the
`PROCESSOR` column in the `ollama ps` output `100% GPU`, or a split such as `18%/82% CPU/GPU`?
If there is a split, the model does not fit in VRAM and some of the layers run on the CPU; speed
depends largely on the share of layers left on the CPU. The settings below
lower that share. They **do not change quality** (same weights, same computation); they only change
where the layers run.

> All numbers were measured on **a single machine** (RTX 4050 Laptop 6 GB, `qwen3:8b`). On other hardware
> the ordering may be the same but the numbers will differ. If the model already fits entirely on the GPU
> (`100% GPU`, usually 12 GB+ cards), these settings have no effect.

### 1. Ollama side (written to Ollama's environment)

Three user-level environment variables, then quit Ollama from the taskbar and reopen it:

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION', '1',    'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE',   'q8_0', 'User')
[Environment]::SetEnvironmentVariable('LLAMA_ARG_FIT_TARGET',   '256',  'User')
```

- `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`: roughly halve the KV cache,
  freeing room in VRAM for model layers.
- `LLAMA_ARG_FIT_TARGET=256` (MiB): Ollama's engine (`llama-server`) by default
  tries to leave **1024 MiB** of VRAM free; this value shrinks that margin. The measured effect is an increase
  in the layer count on the same model and ~50% faster generation for `qwen3:8b` Q4_K_M on this machine.
  Shrinking the margin raises the risk of running out of memory if you share VRAM with other programs;
  if you see problems, raise the value or delete the variable.

**Things to know**

- `LLAMA_ARG_FIT_TARGET` is **not a documented Ollama setting**; it works because Ollama
  passes its environment on when it starts the engine as a subprocess. An Ollama update may
  change this. After an update, look at `ollama ps` again.
- This variable affects **all llama.cpp-based programs** on the machine.
- Verification: load a model and look at `ollama ps`; also the line `free memory target of 256 MiB`
  should appear in Ollama's server log (`%LOCALAPPDATA%\Ollama\server.log`).
- Rollback: for each variable `[Environment]::SetEnvironmentVariable('<NAME>', $null, 'User')`,
  then restart Ollama.

### 2. App side

| Setting | Default | What it does |
|---|---|---|
| `OLLAMA_SERVE_CTX` | model table (`qwen3`: 8192) | The context window (`num_ctx`) requested from Ollama, for all models |
| `CHAT_RETRIEVAL_K` | 6 (1–50) | Number of source chunks retrieved per question in chat |

- **Where to set it:** `.env` applies only to **`npm run dev`** (see `.env.example`).
  **`node build` ("Persistent use") and the packaged (Tauri) app do not read `.env`.** For `node build`
  set it in the shell where you run that command (`OLLAMA_SERVE_CTX=8192 node build`); for the packaged
  app set it as an **operating system environment variable** (at `'User'` level as above)
  and quit and reopen the app; the server process inherits its environment from the app.
- **Lowering `OLLAMA_SERVE_CTX` can be dangerous.** When the window shrinks, more layers stay on the GPU
  but if the prompt (which can reach ~4k tokens even at k=6) does not fit, Ollama shifts the context and
  **keeps only the first 4 tokens**; the system rules silently drop out. Before going
  below the default 8192, check whether the `llm_timing` records in `data/app-log.jsonl` have `nearCtxLimit: true`.
- **If you have plenty of VRAM**, raise both together (e.g. `OLLAMA_SERVE_CTX=16384`,
  `CHAT_RETRIEVAL_K=12`): it answers with more sources. The effect of `k` on answer quality
  cannot be measured; it is a matter of judgment. If something gets worse, go back to the old value.

### 3. Smaller quantization (optional)

If the model does not fit entirely on the GPU, a smaller quantization (e.g. `IQ4_XS`, ~4.6 GB; `Q4_K_M`
~5.0 GB) keeps more of the layers on the GPU. According to a published measurement (another
publisher's custom quantizations, so indicative only), the divergence of `IQ4_XS` is close to `Q4_K_M`;
for 3-bit quantizations (`IQ3_M`, `Q3_K_M`) the divergence rises about 2-3 times. No test strong enough to tell
quality apart was run locally: make the decision yourself with real questions.

**Pulling a raw GGUF directly.** The `tools` and `thinking` capabilities of the official `qwen3:8b` come from the model's
**template**; pulling a raw GGUF from another source loses them, and the app's
skill tools/thinking mode do not work. The right way is to take the official model's Modelfile and change only the `FROM`
line:

```powershell
cmd /c "ollama show qwen3:8b --modelfile > Modelfile"
# In the Modelfile, replace the FROM line with the path of the .gguf file you downloaded (with forward slashes),
# do not touch any other line. Then:
ollama create qwen3:8b-iq4xs -f Modelfile
ollama show qwen3:8b-iq4xs      # tools and thinking should appear under Capabilities
```

(`cmd /c` is deliberate: the `>` operator of Windows PowerShell 5.1 writes the file as UTF-16 and Ollama
cannot read it.)

Compare the SHA256 of the file you downloaded with the value on the publisher's page.

### 4. Measuring

Every chat call writes an `llm_timing` record to `data/app-log.jsonl`: `promptTokens`,
`completionTokens`, `promptMs`, `completionMs`, `loadMs`, `numCtx`, `nearCtxLimit`. Numbers
only, no text content.

## Troubleshooting

- **The local model is slow** → "Performance settings for small GPUs" above.
- **"Local server … not running" warning / "… provider unreachable"** → Is the
  local server chat uses (Ollama, LM Studio, llama.cpp...) running? For Ollama,
  `ollama serve`; if the address is wrong, fix that provider's
  `baseUrl` in Settings → Providers (`OLLAMA_URL` is no longer read).
- **"Setup is not complete" warning / chat does not respond** → The chat chain
  is empty: run the setup wizard (`/setup/local-server`) or add and enable a provider in Settings →
  Providers and pick its default model.
- **Model list is empty / ModelPicker errors** → Is there a model loaded on the server?
  (For Ollama, `ollama pull qwen3:8b`; in LM Studio/llama.cpp, load a model.)
- **Search results are weak / only keyword search works** → Embedding
  may not be configured (semantic search is off); pick an embedding model in Settings → Providers,
  then re-index the vault.
- **Sources are not found / answers are irrelevant** → Was `npm run index` run, is the index current?
  If you use multiple vaults,
  also check: is the right vault active (Settings → Vaults), did `npm run index`
  index the active vault or another one (the wrong vault may have been given with `--vault <id>`)?
- **Math does not render / bare code like `f(x)` shows up** →
  test the `src/lib/markdown.ts` pipeline with a sample text such as `f(x)`.
- **The MCP client does not show "connected" / closes immediately** → Is the `"command"`
  value really `"node"` (see the note above)? Does `npm run mcp:smoke`
  pass cleanly? In Claude Desktop, check the single stderr line in `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`
  — does `DATA_DIR` point where you expect?
- **MCP `search_library` returns no results but the app's own chat
  finds them** → they are probably reading a different `DATA_DIR`/vault; look at the `indexed`/`noteCount` fields
  returned by the `list_vaults`
  tool.
- **The model list or connection test of a cloud provider (DeepSeek/OpenRouter/Groq/Google AI Studio/Mistral)
  fails at random, while that API address opens fine in the browser** → in `data/app-log.jsonl`, look for a line like
  `"listModels: ... fetch failed (SELF_SIGNED_CERT_IN_CHAIN)"` for
  that provider. This is not a bug in vault-chat's code — it means your antivirus
  (Kaspersky, ESET, Avast/AVG, Bitdefender, Norton etc. all have a "scan encrypted
  connections" feature) is intercepting outgoing HTTPS connections with its own root
  certificate to inspect them, but Node.js does not trust this certificate because (unlike
  browsers) it does not use the Windows certificate store. Fix: in `certmgr.msc` → *Trusted Root
  Certification Authorities*, export your antivirus's root certificate
  as Base-64 `.cer`/`.pem`, then set the `NODE_EXTRA_CA_CERTS`
  environment variable to the path of that file and restart `npm run dev` (or
  the desktop app). Loosening certificate verification
  (`NODE_TLS_REJECT_UNAUTHORIZED=0`) is **never** a fix —
  it also removes protection against a real man-in-the-middle attack.
