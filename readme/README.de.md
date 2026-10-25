<p align="center">
  <img src="../static/logo.png" alt="vault-chat-Logo" width="140" />
</p>

<h1 align="center">Vault Chat</h1>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.zh-CN.md">简体中文</a> · <b>Deutsch</b> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <b>Ein lokaler Lernassistent, der sich mit deinen eigenen Notizen unterhält.</b><br />
  Importiere deine Dokumente, erhalte Antworten mit Quellenangabe und lass aus denselben Quellen Tests, Karteikarten, Berichte und Folien erzeugen.
</p>

<p align="center">
  <img alt="Lizenz: Apache-2.0" src="https://img.shields.io/badge/Lizenz-Apache--2.0-blue" />
  <img alt="Version" src="https://img.shields.io/github/v/tag/KodAlp/vault-chat-beta?sort=semver&label=Version&color=informational" />
  <img alt="Plattform" src="https://img.shields.io/badge/Plattform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" />
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Local-first" src="https://img.shields.io/badge/Daten-bleiben%20lokal-success" />
</p>

<p align="center">
  <img src="../docs/assets/demo-chat.gif" alt="Eine Frage an den Vault: Das lokale Modell erklärt die binäre Suche mit Code und Formel aus den Notizen, samt Quellen-Chips" width="860" />
</p>

## Was kann es?

- **Quellenbasierter Chat (RAG).** Antworten stammen ausschließlich aus den Notizen in deinem Vault; unter jeder Antwort siehst du, welcher Abschnitt welcher Notiz verwendet wurde. Formeln werden mit KaTeX dargestellt, Code mit Syntaxhervorhebung.
- **Importiert Quellen jeder Art.** PDF-, DOCX-, PPTX-, XLSX-, HTML-, EPUB-, TeX- und Markdown-Dateien sowie Links und Obsidian-/Logseq-/Joplin-/Zettlr-Ordner werden in Markdown umgewandelt und der Bibliothek hinzugefügt. Für formelreiche PDFs gibt es eine Pipeline mit docling und MinerU als Fallback.
- **Lernwerkzeuge.** Aus denselben Quellen erzeugt es Multiple-Choice-Tests, SM-2-Karteikarten mit Spaced Repetition, Mindmaps, Berichte mit Quellenangaben und Folien; deinen Fortschritt verfolgt es Thema für Thema.
- **Mehrere Vaults.** Jeder Vault hat seine eigene Bibliothek und seinen eigenen Suchindex; sie vermischen sich nicht.
- **Local-first.** Der Standardweg ist Ollama oder ein beliebiger OpenAI-kompatibler lokaler Server (LM Studio, llama.cpp, vLLM, Jan). Cloud-Anbieter sind optional, standardmäßig deaktiviert und verlangen in jedem Chat eine eigene Zustimmung.
- **MCP-Server.** MCP-Clients wie Claude Code/Desktop können in deinem Vault suchen, Notizen lesen und Quellen importieren; ein Import gelangt in die Bibliothek, sobald du ihn in der App bestätigst (oder wenn du die automatische Bestätigung für den Vault aktivierst).
- **23 Oberflächensprachen**, helle/dunkle und warm getönte Themes, Nutzung als Desktop-Paket (Tauri) oder im Browser.

## Screenshots

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/screenshots/home-dark.webp" />
        <img src="../docs/assets/screenshots/home-light.webp" alt="Startseite des Vaults: Fragefeld und frühere Chats" />
      </picture>
      <p align="center"><sub>Startseite des Vaults (helles und dunkles Theme)</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/chat-code.webp" alt="Eine Antwort mit Codeblock und Formel samt Quellen-Chips" />
      <p align="center"><sub>Antwort mit Quellen-Chips: Code und Formel zusammen</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="../docs/assets/screenshots/study-panel.webp" alt="Lernpanel: Test, Karteikarten, Bericht, Mindmap, Folien, Fortschritt" />
      <p align="center"><sub>Lernpanel: Test, Karteikarten, Bericht, Mindmap, Folien</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/source-viewer.webp" alt="App-interner Quellenbetrachter mit per KaTeX gerenderten Formeln" />
      <p align="center"><sub>Quellenbetrachter: Bearbeiten und frühere Versionen</sub></p>
    </td>
  </tr>
</table>

<sub>Die Bilder wurden in einem Demo-Vault aus Beispielnotizen mit dem lokalen Modell <code>qwen3:8b</code> in der englischen Oberfläche aufgenommen.</sub>

## Wie funktioniert es?

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/architecture-dark.webp" />
  <img src="../docs/assets/architecture-light.webp" alt="Vault-Chat-Architektur: Quellen, Konverter, Vault, App, Modellanbieter und Clients" />
</picture>

Alles läuft in einem einzigen Node-Prozess auf `localhost`. Docker oder ein externer Server sind nicht nötig. Deine Notizen, der Index und dein Chatverlauf bleiben auf deinem Rechner.

## Schnellstart

```bash
git clone https://github.com/KodAlp/vault-chat-beta.git
cd vault-chat-beta
npm install
npm run dev
```

Öffne anschließend `http://localhost:5173`. Der Einrichtungsassistent beim ersten Start findet den lokalen Modellserver und hilft dir, das Chat- und das Embedding-Modell auszuwählen. Voraussetzungen (Node.js 22 und eine Modellquelle), Desktop-Paket, MCP-Einrichtung und Fehlerbehebung findest du in den ausführlichen Abschnitten weiter unten.

Zum Mitwirken siehe [`CONTRIBUTING.md`](../CONTRIBUTING.md); für Datenschutz, Sicherheit und Nutzungsbedingungen siehe [`PRIVACY.md`](../PRIVACY.md), [`SECURITY.md`](../SECURITY.md) und [`TERMS.md`](../TERMS.md). Das Projekt steht unter der Apache-2.0-Lizenz ([`LICENSE`](../LICENSE), [`NOTICE`](../NOTICE)).

---

# Ausführliche Einrichtung

Eine lokale SvelteKit-Lern-/Chat-Anwendung ohne Docker. Sie führt RAG über die
Notizen und Dokumente in deiner eigenen Bibliothek aus und spricht mit einem lokalen Modellserver (Ollama wird
empfohlen, ist aber nicht zwingend — jeder OpenAI-kompatible Server wie
LM Studio, llama.cpp, vLLM oder Jan funktioniert ebenfalls)
oder mit einem optionalen Cloud-Anbieter. Ein einziger Node-Prozess,
gebunden an `localhost`.

## Voraussetzungen

1. **Node.js 22** (`>=22 <23`; 20 und 24 funktionieren nicht — die installierte Version siehst du mit `node --version`). Das Windows-Desktop-Paket bringt Node selbst mit, daher wird es dort nicht separat installiert.
2. **Eine Chat-Modellquelle** — **Ollama wird empfohlen** (https://ollama.com), ist aber
   nicht zwingend. Eine der folgenden genügt:
   - Ollama,
   - ein anderer OpenAI-kompatibler lokaler Server: llama.cpp, LM Studio, vLLM, Jan,
     LocalAI,
   - ein Cloud-Anbieter (DeepSeek, Google AI Studio, OpenRouter...; optional,
     standardmäßig deaktiviert, siehe `PRIVACY.md`).

   Ist nichts davon installiert, funktioniert der Chat nicht: Die App zeigt die
   Warnung „Einrichtung nicht abgeschlossen“ an.
3. **Embedding-Modell (Suche) — optional.** Jeder Anbieter mit Embedding-Unterstützung
   ist geeignet; wählst du keines, arbeitet die Suche nur mit Schlüsselwörtern (FTS)
   und die semantische Suche bleibt deaktiviert. Bei Ollama ist das empfohlene Modell
   `bge-m3` — NICHT `nomic-embed-text` (`EMBED_MODEL` in `src/lib/server/embed-config.ts`;
   es liefert bei türkischen Anfragen messbar bessere Ergebnisse,
   die Begründung steht im Kommentar von embed-config.ts selbst). Wenn du ein konfiguriertes
   Embedding-Modell nicht auf dem Server herunterlädst, bricht `npm run index` mit „model not found“ ab.

**Hauptweg: der Einrichtungsassistent.** Er öffnet sich beim ersten Start (im Desktop-Paket) oder
im Browser unter `/setup/local-server`, außerdem über den Link „Einrichtungsassistent erneut ausführen“
auf der Seite **Einstellungen → Anbieter**, und führt in drei Schritten
durch die Einrichtung: (1) lokalen Server finden/installieren, (2) Chat-Modell auswählen, (3)
Embedding-Modell auswählen **oder „nur Schlüsselwortsuche“** wählen. Wenn du es
lieber manuell machst, so geht es mit Ollama:
```bash
ollama serve
ollama pull qwen3:8b      # recommended chat model
ollama pull bge-m3        # recommended embedding model (optional)
# optional, for deep sessions:
ollama pull qwen3:30b-a3b
```

Um diese Punkte nicht von Hand zu prüfen, sondern mit einem einzigen Befehl zu verifizieren:
```bash
npm run doctor
```

## Installation

```bash
cd vault-chat-beta
npm install
```

Die Datei `.env` wurde bereits aus `.env.example` erzeugt. Öffne und prüfe sie bei Bedarf:

```
CHATS_DB_PATH=./data/chats.db
PUBLIC_VAULT_NAME="My Notes"  # display name of the "default" vault on first launch
```

`OLLAMA_URL` wird nicht mehr gelesen: Die Adresse von Ollama (und der anderen Server)
wird unter Einstellungen → Anbieter festgelegt, also über das Feld `baseUrl` in
`providers.json`.

`PUBLIC_VAULT_NAME` wird nur beim erstmaligen Anlegen des „default“-Vaults (siehe
`migrateVaults.ts`) als standardmäßiger Anzeigename gelesen — bei späteren
Starts hat es keine Wirkung. Quellen werden immer im
App-eigenen Betrachter geöffnet. Markdown-Ordner aus Notiz-Apps wie Obsidian, Logseq,
Joplin oder Zettlr sind lediglich Importquellen
(**Einstellungen → Bibliothek**).

`data/providers.json` ist eine **Seed**-Datei, die mit diesem Repo ausgeliefert wird — eine neue
Installation findet einige der Cloud-Anbieter (DeepSeek, Google AI Studio)
mit `enabled: true` vor. Um sie tatsächlich zu nutzen, musst du dennoch (a) für den
jeweiligen Anbieter einen API-Schlüssel in `data/secrets.json` eintragen (Einstellungen →
Anbieter) und (b) in jedem Chat ein separates Kontrollkästchen bestätigen
(siehe `PRIVACY.md`) — allein `enabled: true` sendet keinerlei
Daten. Wenn du Cloud-Anbieter nicht einmal als Auswahlmöglichkeit in der Oberfläche sehen
möchtest, kannst du den entsprechenden Eintrag in deiner eigenen `data/providers.json`
auf `enabled: false` setzen. Die paketierte Desktop-Version verwendet dagegen nicht diese Datei,
sondern die saubere Vorgabe `data/providers.default.json` als Seed:
alle Cloud-Anbieter deaktiviert, Aufgabenketten leer, kein Embedding
(nur Schlüsselwortsuche) — der Einrichtungsassistent füllt diese Werte aus.

## Vaults

Die App kann statt einer einzelnen Bibliothek **mehrere Vaults** verwalten — jeder mit
eigenem Quellordner und eigenem Suchindex, vollständig voneinander isoliert
(`data/vaults/<id>/library/`, `data/vaults/<id>/index.db`). Der Chatverlauf bleibt in einer einzigen
globalen DB (`data/chats.db`); jeder Chat speichert, zu welchem Vault er gehört.

- Vaults anlegen/löschen/umbenennen: **Einstellungen → Vaults**.
- Es ist immer nur ein Vault „aktiv“ — Chat-Ansicht und Indexer arbeiten stets auf dem
  aktiven Vault.
- **Wenn du von einer älteren Installation (vor Multi-Vault) kommst**, musst du nichts tun
  — beim ersten Start stellt der Server fest, dass `data/vaults.json` fehlt, verschiebt
  den Inhalt von `LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH` automatisch
  nach `data/vaults/default/` und registriert einen Vault namens „default“;
  alle alten Chats werden mit diesem Vault verknüpft. **`VAULT_PATH` wird bewusst
  nicht verschoben** — In der alten Architektur war das ein Zeiger, der auf einen aktiven Markdown-Notizordner
  (z. B. einen Obsidian-Vault) an Ort und Stelle zeigte (er wurde nie kopiert), kein Ordner der App.
  Ist nur `VAULT_PATH` gesetzt (wie in diesem Repo — `data/library` ist leer,
  der eigentliche Inhalt wird aus `VAULT_PATH=..` an Ort und Stelle indexiert), startet der „default“-Vault
  **leer**; den Inhalt musst du über den Import unter Einstellungen → Bibliothek
  von Hand (erneut) importieren. Wenn du das manuell und mit Vorschau
  ausführen möchtest:
  ```bash
  npm run vault:migrate -- --dry-run   # reports what would be moved, writes nothing
  npm run vault:migrate                # actually moves it
  ```

## Erste Indexierung

Damit du chatten kannst, muss der Inhalt des aktiven Vaults zuerst in einen Vektorindex überführt werden:

```bash
npm run index
```

Das durchsucht alle `.md`-Dateien in der Bibliothek des aktiven Vaults,
überspringt Dateien ohne Frontmatter mit einer Warnung, zerlegt den Rest in Chunks,
bettet sie mit dem konfigurierten Embedding-Modell (empfohlen: `bge-m3`) ein und schreibt sie in die
`index.db` dieses Vaults. Ist kein Embedding konfiguriert (reiner Schlüsselwortmodus),
wird der Vektorschritt übersprungen; Chunks und Schlüsselwortdaten (FTS) werden trotzdem geschrieben. Es arbeitet inkrementell auf
sha256-Basis — unveränderte Dateien werden übersprungen, nach demselben Prinzip wie `pdf2md.py`.

Flags:
- `npm run index -- --vault <id>` — indexiert statt des aktiven Vaults einen bestimmten Vault
  (die id ist die Kennung, die unter Einstellungen → Vaults angezeigt wird).
- `npm run index -- --full` — indexiert alles von Grund auf neu (nutze das, wenn sich das
  Embedding-Modell geändert hat).
- `npm run index -- --dry-run` — meldet, was sich ändern würde, ohne etwas zu schreiben.

## Täglicher Gebrauch

```bash
npm run dev
```

`http://localhost:5173` wird geöffnet. Nachdem du gelernt und Notizen aktualisiert hast, kannst du jederzeit
`npm run index` ausführen — auch bei laufender App gibt es keine Konflikte (WAL-Modus).

Wenn du automatisches Beobachten möchtest (optional, nicht Standard):

```bash
npm run index:watch
```

## Dauerhafter Betrieb (ohne Entwicklungsserver)

```bash
npm run build
BODY_SIZE_LIMIT=1G node build
```

Ohne `BODY_SIZE_LIMIT` begrenzt adapter-node den Request-Body auf **512 KB**
(sein eigener Standardwert), und jeder Quellen-Upload, der diese Größe überschreitet, wird mit 413 abgewiesen,
ohne die Route überhaupt zu erreichen — ein kleines `.docx` geht durch, eine echte
`.pdf`/`.pptx`/`.xlsx` nicht. Im Desktop-Paket wird diese Variable dem Sidecar
automatisch übergeben (`src-tauri/src/lib.rs`); beim manuellen Start von
`node build` musst du sie selbst angeben. Dieser Ablauf liest keine `.env`,
du musst sie als Umgebungsvariable übergeben.

## Desktop (Tauri)

Ein Paket, das denselben Server statt im Browser in einem nativen Fenster ausführt und kein Electron
verwendet. **Das Windows-Paket bringt Node.js 22 und Python 3.12 (python-build-standalone) selbst
mit**: Beide werden nicht separat installiert, die App nutzt immer das eingebettete Node (auch der WebView2-Installer ist
im Paket enthalten). Für den Chat wird eine Modellquelle benötigt (empfohlen: Ollama, oder ein anderer lokaler Server / Cloud-Anbieter),
sie ist nicht ins Paket eingebettet. In den macOS-/Linux-Paketen werden Node (und Python) weiterhin von Hand installiert, siehe unten.

```bash
npm run desktop:dev      # native window against the live Vite dev server, HMR works
npm run desktop:build    # builds the package for the operating system you are on
```

**Die Versionsnummer erhöht sich automatisch.** `desktop:build` führt vor dem Build `scripts/release.mjs --auto` aus: Es prüft die Commits ([Conventional Commits](https://www.conventionalcommits.org)) seit dem letzten `v*`-Tag. `fix`/`perf`/`refactor` bedeutet Patch (0.1.0 → 0.1.1), `feat` Minor (0.1.x → 0.2.0), `!` oder `BREAKING CHANGE` Major (→ 1.0.0); `docs`, `chore`, `test`, `ci` ändern die Version nicht. Die Erhöhung erfolgt nur auf dem Branch `main` und bei sauberen Versionsdateien; es entstehen ein Commit `chore(release): vX.Y.Z` und ein Tag `vX.Y.Z`; zum Veröffentlichen `git push --follow-tags`. Manuell: `npm run release` (Vorschau: `npm run release -- --dry-run`).

Die Ausgabe von `desktop:build` unter Windows: `src-tauri/target/release/bundle/nsis/vault-chat_<version>_x64-setup.exe`
(NSIS-Installationsdatei). Linux- und macOS-Pakete werden mit demselben Befehl auf dem jeweiligen
Betriebssystem erzeugt (keine Cross-Kompilierung); die Ziele stehen in `src-tauri/tauri.linux.conf.json`
(`deb`, `appimage`) und `src-tauri/tauri.macos.conf.json` (`app`, `dmg`) — siehe
den Abschnitt „Linux und macOS (neu, Beta)“ weiter unten. Für fertige Pakete baut der `desktop`-Workflow
in GitHub Actions die Pakete für Windows x64, Linux x64, macOS arm64 und macOS x64
und lädt für jedes ein Artifact namens `vault-chat-<target>` hoch
(`.github/workflows/desktop.yml`; Artifacts werden 7 Tage aufbewahrt). Windows ARM64 wird ebenfalls
versucht, soll vorerst aber scheitern und färbt das Ergebnis nicht rot.
Der Workflow läuft bei Push auf `main` und den Branch `ci`, bei `v*`-Versions-Tags, bei PRs und
manuell über den Actions-Tab („Run workflow“); reine Dokumentationsänderungen
(`*.md`, `docs/`) lösen keinen Build aus. Solange das Repo privat ist, werden `main`-, Tag- und PR-Builds
übersprungen (Actions-Minuten sind begrenzt); um in dieser Zeit einen Branch bauen zu lassen, nutze
`git push origin <branch>:ci` (gegebenenfalls mit `--force`) oder den manuellen Start.

Installationsort und Datenordner unter Windows:
Die Installation erfolgt benutzerbezogen (keine Administratorrechte nötig) unter `%LOCALAPPDATA%\vault-chat\`.
Die Anwendungsdaten (Chatverlauf, Vault-Registry, Bibliothek/Index jedes Vaults, `config.json`) liegen unter Windows in `%APPDATA%\Roaming\app.vaultchat.desktop\`
(macOS: `~/Library/Application Support/app.vaultchat.desktop/`, Linux:
`~/.local/share/app.vaultchat.desktop/`) — vollständig getrennt vom Ordner `data/` und nicht
mit dem Browser-Ablauf geteilt. Die Vault-Registry wird relativ zum dortigen `DATA_DIR` aufgelöst (eine
Umgebungsvariable des Sidecars, für den Benutzer unsichtbar); das einzelne
Paar `vault_path`/`vault_name` in `config.json` ist dagegen etwas anderes — es bestimmt den Namen
des zuerst eingerichteten **„default“**-Vaults, weitere Vaults werden später in der App unter Einstellungen → Vaults
angelegt.

Beim ersten Start wirst du aufgefordert, einen Ordner auszuwählen (nativer Ordnerwähler) — das wird
für den Anzeigenamen des „default“-Vaults abgefragt,
der Bibliotheksinhalt wird NICHT daran gebunden (die Bibliothek ist immer ein Ordner der App,
siehe den Abschnitt „Vaults“ oben). Die Auswahl wird in `config.json` geschrieben
und beim nächsten Start nicht erneut abgefragt. Um diesen Namen später zu ändern, nutze
**Einstellungen → Desktop — Vault-Speicherort** (die Änderung wird beim nächsten
Start wirksam, der laufende Server wird nicht neu gestartet).

Da `node build/index.js` direkt aufgerufen wird, gilt alles, was der Ablauf für den Dauerbetrieb
verlangt (Node 22, Umgebungsvariablen statt `.env`), auch hier — siehe den Hinweis oben.

## Auf einem anderen Windows-Rechner ausführen

Der Windows-Installer bringt Node.js 22 und Python 3.12 selbst mit, aber keinen lokalen Modellserver
(wie Ollama) — die Modellquelle (empfohlen Ollama, ein anderer lokaler Server oder ein Cloud-Anbieter)
muss auf dem Zielrechner separat eingerichtet werden. Im Entwicklerablauf (`npm run dev` / `node build`) wird Node weiterhin von Hand installiert. Nach der Installation auf dem Zielrechner zeigt `npm run doctor`
(Entwicklerablauf) oder das eigene Banner der App „Lokaler Server … läuft nicht“ /
„Einrichtung nicht abgeschlossen“ (Desktop-Paket), was fehlt.

| Komponente | Erforderlich | Wer installiert |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Ja | Im Windows-Desktop-Paket eingebettet (die App nutzt immer dieses); Entwicklerablauf: manuell — https://nodejs.org |
| Ollama + `qwen3:8b` + `bge-m3` | **Empfohlen** (ein anderer lokaler Server oder Cloud-Anbieter geht auch; ohne Embedding nur Schlüsselwortsuche) | Manuell — https://ollama.com, oder über den Einrichtungsassistenten |
| WebView2 Runtime | Ja (nur Desktop-Paket) | Automatisch — falls nicht vorhanden, installiert der NSIS-Installer sie über den darin enthaltenen kleinen Bootstrapper (`embedBootstrapper`); während der Installation ist Internet nötig |
| Visual C++ Redistributable | Technisch ja | Meist bereits in Windows 10/11 vorhanden; falls nicht, manuell |
| Python 3.12+ (stabile Version) | Nein — nur für PDF-/Dokument-/YouTube-Import | Im Windows-Desktop-Paket eingebettet (3.12); ein System-Python mit docling oder `PYTHON_BIN` hat Vorrang, falls vorhanden. Andere Abläufe: manuell — https://python.org |
| `markitdown` und weitere leichte Pakete (`pip install -r ingest/requirements.txt`) | Nein — nur für PDF-/Dokument-/YouTube-Import | Im Desktop-Paket über das App-eigene Banner „Jetzt installieren“ (erstellt aus dem eingebetteten Python ein `python-venv`, Internet nötig); andere Abläufe: manuell |
| docling (schwere PDF/OCR) | Nein — optional | Manuell (`pip install docling`) |
| pandoc | Nein — nur für die `.tex`-Konvertierung | Manuell |

Worauf du achten solltest:
- **ARM64-Windows wird nicht unterstützt.** Für `sqlite-vec` gibt es unter Windows nur das
  Prebuilt-Paket `win32-x64` — auf einem ARM-basierten Windows-Rechner
  (Snapdragon usw.) schlägt `npm install` für sqlite-vec fehl.
- **Eine falsche Node-Version wird stillschweigend installiert und scheitert erst zur Laufzeit.** Da `engine-strict`
  deaktiviert ist, läuft `npm install` auch mit Node 20/24 durch, aber
  das native Binary von `better-sqlite3` ist für die ABI von Node 22 kompiliert — der Fehler tritt erst
  beim ersten Datenbankzugriff auf. `npm run doctor` fängt das direkt nach der
  Installation ab.
- **`secrets.json` lässt sich nicht übertragen.** Im Desktop-Paket wird sie mit
  AES-256-GCM verschlüsselt; der Schlüssel liegt im Speicher des Betriebssystems (Windows
  DPAPI, macOS Keychain, Linux Secret Service) und ist an das Benutzer-/Rechnerprofil gebunden —
  eine auf einen anderen Rechner/Benutzer kopierte `secrets.json` lässt sich nicht
  entschlüsseln und verhält sich, als gäbe es keinen Schlüssel. Gib die API-Schlüssel der Cloud-Anbieter (DeepSeek/Gemini/Groq/...)
  auf dem Zielrechner unter Einstellungen → Anbieter erneut ein.
- **Vault-Inhalte werden von Hand übertragen.** `data/vaults.json` ist portabel, weil es seine Pfade bei jedem
  Lesen neu ableitet, aber der eigentliche Inhalt jedes Vaults
  (`data/vaults/<id>/library/`, `index.db`, `study.db`) muss separat kopiert werden —
  oder auf dem Zielrechner durch Import + `npm run index`
  neu aufgebaut werden.
- **Im Windows-Desktop-Paket fehlen für den PDF-/Dokument-/YouTube-Import nur die leichten
  Pakete.** Der Ordner `ingest/` und Python 3.12 sind im Installationspaket enthalten
  (siehe `scripts/stage-server.mjs`, `scripts/fetch-python-runtime.mjs`); `markitdown`
  und die übrigen Pakete sind nicht im Paket, bei der ersten Nutzung erkennt die App das über `/api/system/python`
  und installiert in einem orangefarbenen Banner per Schaltfläche „Jetzt installieren“
  `pip install -r ingest/requirements.txt` für dich in das `python-venv` im Datenordner.
  Ist bereits ein Python mit docling vorhanden, hat dieses Vorrang.

## Linux und macOS (neu, Beta)

> **Warnung:** Die Linux- und macOS-Pakete sind neu. Sie werden in der CI gebaut, aber **noch nicht
> auf einem echten Linux-/macOS-Rechner getestet**; das macOS-Paket ist außerdem **unsigniert
> und nicht notarisiert**. Sie sind nicht so ausgereift wie die Windows-Version — wenn dir
> etwas auffällt, melde es bitte mit der `launch.log` aus dem Datenordner (siehe unten). Eine
> Schritt-für-Schritt-Testliste für macOS: [`docs/macos-deneme-listesi.md`](../docs/macos-deneme-listesi.md) (Türkisch).

Unterstützte Paketformate (werden in der CI gebaut; siehe „Desktop (Tauri)“):

| Plattform | Paket | Hinweis |
|---|---|---|
| Linux x64 | `.deb`, `.AppImage` | Das `.deb` hängt von diesen Paketen ab: `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`, `libsecret-1-0` (`src-tauri/tauri.linux.conf.json`) |
| macOS (Apple Silicon und Intel) | `vault-chat.app` + `.dmg`, unsigniert | macOS 11.0 und höher (`minimumSystemVersion`) |

Zum Bauen aus dem Quellcode unter Linux (Paketliste von Ubuntu 22.04 aus der CI):
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libsecret-1-dev libdbus-1-dev
npm install && npm run desktop:build
```

| Komponente | Erforderlich | Installation unter Linux / macOS |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Ja — nicht ins Paket eingebettet | https://nodejs.org, Homebrew (`brew install node@22`), nvm/fnm/Volta oder der Paketmanager deiner Distribution |
| Modellquelle (Ollama empfohlen, anderer lokaler Server oder Cloud-Anbieter) | Eine für den Chat | Manuell — https://ollama.com |
| Python **3.10+** | Nein — nur für PDF-/Dokument-/YouTube-Import | macOS: `brew install python@3.12`; Linux: Paketmanager der Distribution (unter Debian/Ubuntu `sudo apt install python3 python3-venv`) |
| pandoc | Nein — nur für die `.tex`-Konvertierung | Homebrew oder Paketmanager der Distribution |

Was du wissen solltest:
- **Wie wird Node gefunden?** Eine aus der GUI gestartete App übernimmt nicht den
  PATH der Shell. Deshalb wird `node` zuerst im PATH (einschließlich des PATH der Sitzungs-/Login-Shell)
  und danach an bekannten Orten gesucht: `/usr/local/bin`, `/usr/bin`,
  `/opt/homebrew/bin`, `~/.volta/bin`, nvm (`~/.nvm/versions/node`) und die Versionsordner
  von fnm (`src-tauri/src/platform.rs`, `resolve_node_binary` in
  `src-tauri/src/lib.rs`). Ist die Hauptversion des gefundenen Node nicht 22, warnt die App
  beim Start.
- **Python „Jetzt installieren“** führt unter macOS/Linux kein `pip install` in das System-Python aus
  (es stößt an den „externally managed“-Schutz von Debian/Homebrew). Stattdessen wird im Datenordner
  eine App-eigene virtuelle Umgebung (`python-venv`) angelegt und die Pakete werden
  dort installiert (`src/routes/api/system/python/+server.ts`,
  `src/lib/server/python-bin.ts`). Fehlt unter Debian/Ubuntu das Paket `python3-venv`,
  kann die Umgebung nicht angelegt werden, und die App sagt dir das. Sind unter macOS die Command Line
  Tools (CLT) nicht installiert, wird der Platzhalter `/usr/bin/python3` übersprungen
  (damit das Installationsfenster nicht ausgelöst wird). Über die Umgebungsvariable `PYTHON_BIN` kann auch ein bestimmter
  Interpreter angegeben werden.
- **winget gibt es nur unter Windows.** Unter macOS/Linux führt die App den Paketmanager
  nicht selbst aus; die Befehle von Homebrew bzw. dem Paketmanager deiner Distribution
  führst du selbst aus.
- **API-Schlüssel** werden durch den Speicher des Betriebssystems geschützt: unter macOS durch
  die Schlüsselbundverwaltung (Dienst `app.vaultchat.desktop`, Konto `secrets-key`;
  beim ersten Start kann eine Berechtigungsabfrage erscheinen — „Immer erlauben“), unter Linux durch
  den Secret Service (GNOME Keyring / KWallet). Gibt es diesen Dienst unter Linux nicht, werden die Schlüssel
  unverschlüsselt (in einer Datei mit `0600`-Rechten) gespeichert, und du siehst unter Einstellungen → Anbieter
  eine Warnung; installierst du GNOME Keyring oder KWallet und startest die App neu,
  werden sie verschlüsselt. Existiert der Schlüssel, ist aber nicht lesbar („gesperrt“), wird nichts
  neu erzeugt; **Einstellungen → Anbieter → „Gespeicherte API-Schlüssel
  zurücksetzen“** sichert die alte Datei als `secrets.json.locked-<date>`
  und startet die App neu. Details: `SECURITY.md`.
- **Hintergrundprozesse:** Unter Linux sendet der Betriebssystemkern dem Node-Server
  `SIGTERM`, selbst wenn die App abstürzt (`PR_SET_PDEATHSIG`). Unter macOS gibt es eine solche
  Garantie nicht: Nur bei normalem Beenden (Cmd+Q) wird der Serverprozess aufgeräumt;
  stürzt die App ab oder wird sie zwangsweise beendet, kann der `node`-Prozess im Hintergrund weiterlaufen.
- **Logdatei:** bei Startproblemen `launch.log` — macOS:
  `~/Library/Application Support/app.vaultchat.desktop/launch.log`, Linux:
  `~/.local/share/app.vaultchat.desktop/launch.log`.

### macOS: unsignierte App öffnen (Gatekeeper)

Da die App nicht von Apple signiert und nicht notarisiert ist,
blockiert macOS sie beim ersten Start („Entwickler kann nicht überprüft werden“ oder „beschädigt“).
Ziehe `vault-chat` aus der `.dmg` in **Programme**, klicke dann im Finder mit der
**rechten Maustaste auf die App → Öffnen → Öffnen**. Lässt sie sich trotzdem nicht öffnen, entferne das Quarantäne-Attribut:

```bash
xattr -dr com.apple.quarantine /Applications/vault-chat.app
```

## MCP-Server

Ein lokaler Server, der die Notizen in deinem Vault für MCP-Clients wie Claude Code/Desktop
bereitstellt — er braucht kein separates Paket und keine eigene Installation, `mcp/` liegt in diesem Repo
nach demselben Muster wie `indexer/`.

**In der paketierten Desktop-App** wird der Server als einzelne Paketdatei geliefert
(`dist-server/mcp/vault-chat-mcp.mjs`, erzeugt von `scripts/build-mcp.mjs`; automatisch in `npm run stage:server`
enthalten): Das Repo, `tsx` oder eine weitere Installation sind nicht nötig,
das Node 22 des Systems genügt. Die Karte **Einstellungen → Mit MCP-Client verbinden** liefert die
fertige Konfiguration, die auf diese Datei zeigt. `node <install>/_up_/dist-server/mcp/vault-chat-mcp.mjs --print-config` (unter Windows ist der Installationsordner `%LOCALAPPDATA%\vault-chat`)
gibt denselben Block ebenfalls aus. Wird `DATA_DIR` nicht angegeben, wird der Datenordner der installierten App verwendet
(`%APPDATA%\app.vaultchat.desktop`, unter macOS `~/Library/Application Support/app.vaultchat.desktop`,
unter Linux derselbe Name unter `$XDG_DATA_HOME` oder `~/.local/share`). Beim Ausführen aus dem Quellcode
gilt der Weg über `mcp/launch.mjs` unverändert. Um das Paket einzeln zu erzeugen: `npm run build:mcp`.

**Werkzeuge:**

- `list_vaults` — listet die für MCP freigegebenen Vaults (Freigabe pro Vault ein-/ausschalten: **Einstellungen → Vaults**).
- `search_library` — durchsucht den Vault; standardmäßig (`mode: "auto"`) per Vektorsuche, mit Schlüsselwort-Fallback (FTS5), wenn kein Embedding vorhanden ist oder nichts gefunden wird. `mode`: `vector`, `keyword` (nur FTS5, kein Embedding nötig) oder `hybrid` (Vektor + FTS5, Reciprocal Rank Fusion). Akzeptiert Filter für `domain`/`level`.
- `get_note` — liest eine Notiz; `heading` liefert nur den Abschnitt dieser Überschrift, `max_chars`/`offset` ermöglichen seitenweises Lesen (`hash` bezieht sich immer auf die gesamte Datei).
- `list_domains` — listet die domain-Werte im Vault mit Notizanzahl und Zeitpunkt der letzten Änderung.
- `list_sources` — listet die Quellen im Vault mit ihren domain- und level-Werten.
- `create_vault` — legt einen neuen Vault an.
- `import_source` — fügt eine lokale Datei oder URL zum Import zu den **ausstehenden** hinzu.
- `list_pending_imports` — zeigt den Status der ausstehenden Importe.
- `edit_note` — bearbeitet eine vorhandene Notiz (der `hash` aus `get_note` ist als `expected_hash` erforderlich; das Frontmatter bleibt unverändert, die vorherige Version wird als Revision gespeichert). **Standardmäßig deaktiviert**: Wird nur über den Entwicklerschalter unter **Einstellungen** aktiviert, der Agent kann ihn nicht einschalten; solange es deaktiviert ist, liefert der Aufruf den Fehler `MCP_EDIT_NOTE_DISABLED`.

Die Schreibwerkzeuge laufen über die API der App, daher muss **die App
geöffnet sein** (die App schreibt `mcp-endpoint.json` in `DATA_DIR`).
Eine importierte Quelle gelangt erst in die Bibliothek, wenn du sie in der App bestätigst; der Agent
kann das nicht selbst bestätigen oder die Einstellung ändern. Lokale Dateien werden nur aus
Ordnern gelesen, die du unter **Einstellungen** freigegeben hast; URLs durchlaufen den normalen Web-Import.
Wenn du möchtest, kannst du pro Vault die Einstellung **MCP-Importe
automatisch bestätigen** aktivieren: `off` (Standard, du bestätigst alles),
`clean` (nur Importe ohne Warnung, ohne Prüfmarkierung und keine Duplikate)
oder `all` (jeder erfolgreiche Import). `all` bezieht die vom Agenten gebrachten Inhalte in die Suche ein,
ohne dass du sie gesehen hast — berücksichtige das Risiko einer Prompt-Injection.

**Einrichtung mit einem einzigen Befehl.** Aus dem Quellcode (nach `npm install`) erledigt dieser Befehl alles:

```bash
npx vault-chat-mcp setup      # or: npm run mcp:setup
```

Ist die Skriptausführung in der Windows PowerShell deaktiviert (`npx.ps1 cannot be loaded`), gib `npx.cmd vault-chat-mcp setup` oder `npm.cmd run mcp:setup` ein.

1. **Wählt den Datenordner:** `--data-dir` > Umgebungsvariable `DATA_DIR` (einschließlich `.env`) > Ordner der installierten Desktop-App (falls vorhanden) > der Ordner `data/` des Repos.
2. **Registriert sich bei den gefundenen MCP-Clients:** Claude Desktop (einschließlich der virtuellen Konfigurationsdatei der Microsoft-Store-Version), Claude Code (wenn `claude` im PATH ist) und LM Studio (wenn `~/.lmstudio` existiert). Von den Dateien legt es eine Sicherung als `<file>.bak-YYYYMMDD-HHMMSS` an, rührt andere Schlüssel und andere Server nicht an und überschreibt ungültiges JSON nie. Du musst Claude Desktop vollständig schließen und neu starten. Für Jan und andere Clients wird am Ende der Konfigurationsblock ausgegeben.
3. **Legt den „Beispiel-Vault“ an:** Kopiert 5 kurze Vorlesungsnotizen (auf Türkisch und Englisch), gibt ihn für MCP frei und indexiert ihn; du kannst sofort `search_library` / `get_note` ausprobieren. Da `vaults.json` der App gehört, wird dieser Schritt bei geöffneter App übersprungen: Schließe die App und führe den Befehl erneut aus. Gibt es keinen Embedding-Server (Ollama), wird der Index nur mit Schlüsselwortsuche (FTS5) aufgebaut; ist der konfigurierte Anbieter nicht erreichbar, schlägt die Indexierung fehl, und du führst mit dem Hinweis auf dem Bildschirm `npm run index -- --vault ornek-kasa` aus.

Optionen: `--client claude-desktop,claude-code,lm-studio` (registriert nur diese; legt den Ordner an, falls er nicht existiert), `--data-dir <folder>`, `--no-sample` (kein Beispiel-Vault), `--dry-run` (zeigt, was getan würde, ohne etwas zu schreiben). `npx vault-chat-mcp config` gibt nur den Konfigurationsblock aus. Der Befehl kann wiederholt ausgeführt werden: Ein aktueller Eintrag und ein vorhandener Beispiel-Vault bleiben unverändert.

Wenn du es manuell einrichten möchtest:

**Verbinden.** Die Daten der installierten Desktop-App liegen unter `%APPDATA%\Roaming\app.vaultchat.desktop\`
(siehe „Desktop (Tauri)“); `DATA_DIR` muss auf diesen Ordner zeigen.
Wenn du aus dem Quellcode arbeitest, ist der Standard der Ordner `data/` des Repos. Für Claude
Code (ohne `--scope user` gilt die Registrierung nur für das Verzeichnis,
in dem der Befehl ausgeführt wurde):

```bash
claude mcp add --scope user vault-chat -- node "<this repo>\mcp\launch.mjs"
```

Um für Claude Desktop den Block, der in `%APPDATA%\Claude\claude_desktop_config.json` einzufügen ist,
fertig mit **absolutem** `DATA_DIR` und `node`-Pfad zu erzeugen:

```bash
npm run mcp:config
```

Die Ausgabe hat folgendes Format; um die Daten der installierten App einzulesen, ersetze `DATA_DIR`
durch den oben genannten AppData-Ordner:

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

`"command"` muss `node` sein (oder der absolute `node`-Pfad, den `npm run mcp:config` ausgibt),
nicht `"npx"`/`"tsx"` — unter Windows sind beide `.cmd`-Shims und liefern bei Clients,
die ohne Shell starten, `ENOENT`.

Überprüfung:

```bash
npm run mcp:smoke   # tests the tools in a single process, without touching a real model server
```

Bei laufendem Server genügt für die Diagnose eine einzelne stderr-Zeile: `DATA_DIR=... vaults=N`.
In Claude Desktop landet diese Zeile in `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`.

## Anbieter und Modellfähigkeiten

Welcher Anbieter für den Chat verwendet wird, wählst du unter **Einstellungen → Anbieter**
(oder im Assistenten bei der Ersteinrichtung); Ollama ist nur eine Option. Die Fähigkeit eines
Modells zum Aufrufen von Werkzeugen (Tools) und zum Schlussfolgern (Reasoning) wird aus dem
Modellnamen abgeleitet (Schreibweisen wie Ollama `qwen3:8b`, llama.cpp `Qwen3-8B-Q4_K_M.gguf`, LM Studio/vLLM
`qwen/qwen3-8b` werden derselben Familie zugeordnet) und stammt für jeden Servertyp aus derselben Tabelle. Ist die Schätzung falsch, gibt es unter **Einstellungen → Anbieter →
„Modellliste verwalten“** für jedes Modell einen Schalter **Werkzeuge** und **Reasoning**:
Sie zeigen den Tabellenstandard an, und eine Änderung schreibt eine modellspezifische Überschreibung
(`modelCaps` in `providers.json`). Bei als lokal (`local`) markierten OpenAI-kompatiblen Servern (llama.cpp,
LM Studio, vLLM) wird für Reasoning-Modelle bei deaktiviertem Denken
`chat_template_kwargs: { enable_thinking: false }` an die Anfrage angehängt (qwen3-Template);
an Cloud-Anbieter wird es nie gesendet.

## Leistungseinstellungen für kleine GPUs

> Dieser Abschnitt gilt nur, wenn du **Ollama** als Modellserver verwendest
> (`ollama ps`, `OLLAMA_*`-Variablen, Modelfile). Bei einem anderen Server wie LM Studio oder llama.cpp
> werden Kontextfenster und GPU-Layer-Einstellungen in der eigenen
> Oberfläche dieses Servers vorgenommen.

Wenn das lokale Modell langsam ist, schau zuerst hierauf: Steht in der Spalte
`PROCESSOR` der Ausgabe von `ollama ps`, während ein Modell geladen ist, `100% GPU`, oder eine Aufteilung wie `18%/82% CPU/GPU`?
Bei einer Aufteilung passt das Modell nicht in den VRAM, und ein Teil der Layer läuft auf der CPU; die Geschwindigkeit
hängt weitgehend vom Anteil der Layer ab, die auf der CPU verbleiben. Die folgenden Einstellungen
senken diesen Anteil. Sie **ändern die Qualität nicht** (gleiche Gewichte, gleiche Berechnung), sondern nur,
wo die Layer laufen.

> Alle Zahlen wurden auf **einem einzigen Rechner** gemessen (RTX 4050 Laptop 6 GB, `qwen3:8b`). Auf anderer Hardware
> kann die Rangfolge gleich sein, die Zahlen fallen aber anders aus. Passt das Modell bereits vollständig in die GPU
> (`100% GPU`, meist Karten mit 12 GB+), haben diese Einstellungen keine Wirkung.

### 1. Ollama-Seite (wird in die Umgebung von Ollama geschrieben)

Drei Umgebungsvariablen auf Benutzerebene; beende danach Ollama über die Taskleiste und öffne es neu:

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION', '1',    'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE',   'q8_0', 'User')
[Environment]::SetEnvironmentVariable('LLAMA_ARG_FIT_TARGET',   '256',  'User')
```

- `OLLAMA_FLASH_ATTENTION=1` und `OLLAMA_KV_CACHE_TYPE=q8_0`: Sie halbieren den KV-Cache ungefähr
  und schaffen im VRAM Platz für Modell-Layer.
- `LLAMA_ARG_FIT_TARGET=256` (MiB): Die Engine von Ollama (`llama-server`) versucht standardmäßig,
  **1024 MiB** VRAM frei zu lassen; dieser Wert verkleinert den Puffer. Der gemessene Effekt: bei
  gleichem Modell mehr Layer und auf diesem Rechner für `qwen3:8b` Q4_K_M ~50 % schnellere
  Generierung. Einen kleineren Puffer zu wählen erhöht das Risiko von Speichermangel, wenn du dir den VRAM
  mit anderen Programmen teilst; treten Probleme auf, erhöhe den Wert oder lösche die Variable.

**Was du wissen solltest**

- `LLAMA_ARG_FIT_TARGET` ist **keine dokumentierte Einstellung** von Ollama; sie funktioniert, weil Ollama
  die Engine als Unterprozess startet und ihr seine Umgebung vererbt. Ein Ollama-Update kann das
  ändern. Schau nach einem Update erneut auf `ollama ps`.
- Diese Variable betrifft **alle auf llama.cpp basierenden Programme** auf dem Rechner.
- Überprüfung: Lade ein Modell und schau auf `ollama ps`; außerdem sollte im Serverlog von Ollama
  (`%LOCALAPPDATA%\Ollama\server.log`) die Zeile `free memory target of 256 MiB` erscheinen.
- Rückgängig machen: für jede Variable `[Environment]::SetEnvironmentVariable('<NAME>', $null, 'User')`,
  danach Ollama neu starten.

### 2. App-Seite

| Einstellung | Standard | Wirkung |
|---|---|---|
| `OLLAMA_SERVE_CTX` | Modelltabelle (`qwen3`: 8192) | Das von Ollama angeforderte Kontextfenster (`num_ctx`), für alle Modelle |
| `CHAT_RETRIEVAL_K` | 6 (1–50) | Anzahl der Quellen-Chunks, die im Chat pro Frage abgerufen werden |

- **Wo man sie setzt:** `.env` gilt nur für **`npm run dev`** (siehe `.env.example`).
  **`node build` („Dauerhafter Betrieb“) und die paketierte (Tauri-)App lesen keine `.env`.** Für `node build`
  gib die Einstellung in der Shell an, in der du diesen Befehl ausführst (`OLLAMA_SERVE_CTX=8192 node build`); für die paketierte
  App gib sie als **Umgebungsvariable des Betriebssystems** an (wie oben auf `'User'`-Ebene)
  und schließe die App und öffne sie neu; der Serverprozess erbt die Umgebung von der App.
- **`OLLAMA_SERVE_CTX` zu senken kann gefährlich sein.** Wird das Fenster kleiner, bleiben mehr Layer auf der GPU,
  aber passt der Prompt (selbst bei k=6 kann er auf ~4k Token anwachsen) nicht hinein, verschiebt Ollama den Kontext und
  **behält nur die ersten 4 Token**; die Systemregeln fallen stillschweigend weg. Bevor du unter den Standardwert 8192 gehst,
  prüfe in den `llm_timing`-Einträgen in `data/app-log.jsonl`, ob `nearCtxLimit: true` vorkommt.
- **Wenn du viel VRAM hast**, erhöhe beide gemeinsam (z. B. `OLLAMA_SERVE_CTX=16384`,
  `CHAT_RETRIEVAL_K=12`): Es antwortet dann mit mehr Quellen. Der Einfluss von `k` auf die Antwortqualität
  lässt sich nicht messen, das ist Ermessenssache; wird etwas schlechter, kehre zum alten Wert zurück.

### 3. Kleinere Quantisierung (optional)

Passt das Modell nicht vollständig in die GPU, hält eine kleinere Quantisierung (z. B. `IQ4_XS`, ~4,6 GB; `Q4_K_M`
~5,0 GB) mehr Layer auf der GPU. Laut einer veröffentlichten Messung (eigene Quantisierungen eines anderen
Herausgebers, zeigt einen Trend) liegt die Abweichung von `IQ4_XS` nah an der von `Q4_K_M`;
bei 3-Bit-Quantisierungen (`IQ3_M`, `Q3_K_M`) steigt die Abweichung auf etwa das 2–3-Fache. Lokal wurde kein Test
durchgeführt, der stark genug wäre, die Qualität zu unterscheiden: Entscheide anhand echter Fragen selbst.

**Rohes GGUF nicht direkt herunterladen.** Die Fähigkeiten `tools` und `thinking` des offiziellen `qwen3:8b` kommen aus dem
**Template** des Modells; ein rohes GGUF aus einer anderen Quelle verliert sie, und die Skill-Werkzeuge bzw.
der Denkmodus der App funktionieren nicht. Der richtige Weg: das Modelfile des offiziellen Modells nehmen und nur die `FROM`-Zeile
ändern:

```powershell
cmd /c "ollama show qwen3:8b --modelfile > Modelfile"
# In the Modelfile, replace the FROM line with the path of the .gguf file you downloaded (with forward slashes),
# do not touch any other line. Then:
ollama create qwen3:8b-iq4xs -f Modelfile
ollama show qwen3:8b-iq4xs      # tools and thinking should appear under Capabilities
```

(`cmd /c` mit Absicht: Der Operator `>` der Windows PowerShell 5.1 schreibt die Datei als UTF-16, und Ollama
kann sie nicht lesen.)

Vergleiche die SHA256 der heruntergeladenen Datei mit dem Wert auf der Seite des Herausgebers.

### 4. Messen

Jeder Chat-Aufruf schreibt einen `llm_timing`-Eintrag nach `data/app-log.jsonl`: `promptTokens`,
`completionTokens`, `promptMs`, `completionMs`, `loadMs`, `numCtx`, `nearCtxLimit`. Nur
Zahlen, kein Textinhalt.

## Fehlerbehebung

- **Lokales Modell ist langsam** → siehe oben „Leistungseinstellungen für kleine GPUs“.
- **Warnung „Lokaler Server … läuft nicht“ / „… Anbieter nicht erreichbar“** → Läuft der lokale Server,
  den der Chat verwendet (Ollama, LM Studio, llama.cpp...)? Bei Ollama
  `ollama serve`; ist die Adresse falsch, korrigiere die `baseUrl` dieses Anbieters unter Einstellungen → Anbieter
  (`OLLAMA_URL` wird nicht mehr gelesen).
- **Warnung „Einrichtung nicht abgeschlossen“ / Chat antwortet nicht** → Die Chat-Kette
  ist leer: Führe den Einrichtungsassistenten (`/setup/local-server`) aus oder füge unter Einstellungen →
  Anbieter einen Anbieter hinzu, aktiviere ihn und wähle sein Standardmodell.
- **Modellliste leer / ModelPicker meldet Fehler** → Ist auf dem Server ein Modell geladen?
  (Bei Ollama `ollama pull qwen3:8b`; in LM Studio/llama.cpp ein Modell laden.)
- **Suchergebnisse schwach / nur Schlüsselwortsuche funktioniert** → Möglicherweise ist kein Embedding
  konfiguriert (semantische Suche deaktiviert); wähle unter Einstellungen → Anbieter ein
  Embedding-Modell und indexiere den Vault dann neu.
- **Quelle nicht auffindbar / Antworten irrelevant** → Wurde `npm run index` ausgeführt, ist der Index aktuell?
  Wenn du mehrere Vaults verwendest,
  prüfe außerdem: Ist der richtige Vault aktiv (Einstellungen → Vaults), hat `npm run index`
  den aktiven Vault indexiert oder einen anderen (möglicherweise wurde mit `--vault <id>`
  der falsche Vault angegeben)?
- **Mathematik wird nicht gerendert / nackter Code wie `f(x)` erscheint** →
  Teste die Pipeline in `src/lib/markdown.ts` mit einem Beispieltext wie `f(x)`.
- **MCP-Client zeigt nicht „connected“ / schließt sich sofort** → Ist der Wert von `"command"`
  wirklich `"node"` (siehe Hinweis oben)? Läuft `npm run mcp:smoke`
  sauber durch? Prüfe in Claude Desktop die einzelne stderr-Zeile in `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`
  — zeigt `DATA_DIR` auf den erwarteten Ort?
- **MCP `search_library` liefert keine Ergebnisse, aber der Chat der App
  findet etwas** → Wahrscheinlich lesen sie ein unterschiedliches `DATA_DIR`/einen unterschiedlichen Vault; schau auf die Felder `indexed`/`noteCount`,
  die das Werkzeug `list_vaults` zurückgibt.
- **Bei Cloud-Anbietern (DeepSeek/OpenRouter/Groq/Google AI Studio/Mistral)
  schlagen Modellliste oder Verbindungstest zufällig fehl, obwohl sich diese API-Adresse im Browser
  problemlos öffnen lässt** → Suche in `data/app-log.jsonl` für diesen Anbieter
  nach einer Zeile wie `"listModels: ... fetch failed (SELF_SIGNED_CERT_IN_CHAIN)"`. Das ist kein Fehler
  im Code von vault-chat — es bedeutet, dass dein Antivirenprogramm
  (Kaspersky, ESET, Avast/AVG, Bitdefender, Norton usw. haben alle die Funktion „verschlüsselte
  Verbindungen scannen“) ausgehende HTTPS-Verbindungen mit seinem eigenen Stammzertifikat
  abfängt und prüft, Node.js diesem Zertifikat aber nicht vertraut, weil es (anders als Browser)
  den Windows-Zertifikatspeicher nicht verwendet. Lösung: Exportiere in `certmgr.msc` → *Trusted Root
  Certification Authorities* das Stammzertifikat deines Antivirenprogramms
  als Base-64-`.cer`/`.pem`, setze dann die Umgebungsvariable `NODE_EXTRA_CA_CERTS`
  auf den Pfad dieser Datei und starte `npm run dev` (oder die
  Desktop-App) neu. Die Zertifikatsprüfung zu lockern
  (`NODE_TLS_REJECT_UNAUTHORIZED=0`) ist **niemals** eine Lösung —
  es hebt auch den Schutz vor einem echten Man-in-the-Middle-Angriff auf.
