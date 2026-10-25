<p align="center">
  <img src="../static/logo.png" alt="logotipo de vault-chat" width="140" />
</p>

<h1 align="center">Vault Chat</h1>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.de.md">Deutsch</a> · <b>Español</b> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <b>Un asistente de estudio que conversa con tus propias notas y funciona en local.</b><br />
  Importa tus documentos y recibe respuestas con fuentes citadas; genera tests, tarjetas, informes y diapositivas a partir de esas mismas fuentes.
</p>

<p align="center">
  <img alt="Licencia: Apache-2.0" src="https://img.shields.io/badge/licencia-Apache--2.0-blue" />
  <img alt="Versión" src="https://img.shields.io/github/v/tag/KodAlp/vault-chat-beta?sort=semver&label=versi%C3%B3n&color=informational" />
  <img alt="Plataforma" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" />
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Prioridad local" src="https://img.shields.io/badge/datos-se%20quedan%20en%20local-success" />
</p>

<p align="center">
  <img src="../docs/assets/demo-chat.gif" alt="Se hace una pregunta al vault; el modelo local explica la búsqueda binaria con el código y la fórmula de las notas, con chips de fuente" width="860" />
</p>

## ¿Qué hace?

- **Chat basado en fuentes (RAG).** Las respuestas provienen únicamente de las notas de tu vault (bóveda de notas); debajo de cada respuesta se ve qué sección de qué nota se usó. Las fórmulas se muestran con KaTeX y el código con resaltado de sintaxis.
- **Importa fuentes de cualquier tipo.** Archivos PDF, DOCX, PPTX, XLSX, HTML, EPUB, TeX y Markdown, además de enlaces y carpetas de Obsidian/Logseq/Joplin/Zettlr, se convierten a Markdown y se añaden a la biblioteca. Para los PDF con muchas fórmulas se usa un flujo con docling y MinerU como respaldo.
- **Herramientas de estudio.** A partir de las mismas fuentes genera tests de opción múltiple, tarjetas de repaso espaciado SM-2, mapas conceptuales, informes con citas y diapositivas; además sigue tu progreso tema a tema.
- **Varios vaults.** Cada vault tiene su propia biblioteca y su propio índice de búsqueda, sin mezclarse con los demás.
- **Local primero.** La vía predeterminada es Ollama o cualquier servidor local compatible con OpenAI (LM Studio, llama.cpp, vLLM, Jan). Los proveedores en la nube son opcionales, están desactivados de forma predeterminada y piden confirmación aparte en cada chat.
- **Servidor MCP.** Clientes MCP como Claude Code/Desktop pueden buscar en tu vault, leer notas e importar fuentes; la importación entra en la biblioteca cuando la apruebas en la aplicación (o si activas la aprobación automática para el vault).
- **23 idiomas de interfaz**, temas claro/oscuro y de tonos cálidos, y uso como paquete de escritorio (Tauri) o desde el navegador.

## Capturas de pantalla

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/screenshots/home-dark.webp" />
        <img src="../docs/assets/screenshots/home-light.webp" alt="Pantalla principal del vault: cuadro de preguntas y chats anteriores" />
      </picture>
      <p align="center"><sub>Pantalla principal del vault (tema claro y oscuro)</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/chat-code.webp" alt="Una respuesta con bloque de código y fórmula, con chips de fuente" />
      <p align="center"><sub>Respuesta con chips de fuente: código y fórmula juntos</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="../docs/assets/screenshots/study-panel.webp" alt="Panel de estudio: test, tarjetas, informe, mapa, diapositivas, progreso" />
      <p align="center"><sub>Panel de estudio: test, tarjetas, informe, mapa, diapositivas</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/source-viewer.webp" alt="Visor de fuentes integrado en la aplicación, con fórmulas renderizadas con KaTeX" />
      <p align="center"><sub>Visor de fuentes: edición y versiones anteriores</sub></p>
    </td>
  </tr>
</table>

<sub>Las capturas se tomaron en un vault de demostración con notas de ejemplo, con el modelo local <code>qwen3:8b</code> y la interfaz en inglés.</sub>

## ¿Cómo funciona?

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/architecture-dark.webp" />
  <img src="../docs/assets/architecture-light.webp" alt="Arquitectura de Vault Chat: fuentes, conversor, vault, aplicación, proveedores de modelos y clientes" />
</picture>

Todo se ejecuta en un único proceso de Node, en `localhost`. No hacen falta Docker ni un servidor externo. Tus notas, el índice y el historial de chats se quedan en tu propio equipo.

## Inicio rápido

```bash
git clone https://github.com/KodAlp/vault-chat-beta.git
cd vault-chat-beta
npm install
npm run dev
```

Después abre `http://localhost:5173`. El asistente de configuración del primer arranque localiza el servidor de modelos local y te ayuda a elegir el modelo de chat y el de embeddings. Los requisitos previos (Node.js 22 y una fuente de modelos), el paquete de escritorio, la configuración de MCP y la resolución de problemas se explican en las secciones detalladas siguientes.

Para contribuir, consulta [`CONTRIBUTING.md`](../CONTRIBUTING.md); para privacidad, seguridad y condiciones de uso, [`PRIVACY.md`](../PRIVACY.md), [`SECURITY.md`](../SECURITY.md) y [`TERMS.md`](../TERMS.md). El proyecto tiene licencia Apache 2.0 ([`LICENSE`](../LICENSE), [`NOTICE`](../NOTICE)).

---

# Instalación detallada

Una aplicación de estudio/chat SvelteKit local y sin Docker. Hace RAG sobre las
notas y documentos de tu propia biblioteca; se comunica con un servidor de modelos local (se recomienda Ollama, pero no es obligatorio:
sirve cualquier servidor compatible con OpenAI, como LM Studio, llama.cpp, vLLM o Jan)
o con un proveedor en la nube opcional. Un único proceso de Node,
enlazado a `localhost`.

## Requisitos previos

1. **Node.js 22** (`>=22 <23`; 20 y 24 no funcionan — comprueba la versión instalada con `node --version`). El paquete de escritorio para Windows incluye Node en su interior, así que allí no se instala por separado.
2. **Una fuente de modelos de chat** — **se recomienda Ollama** (https://ollama.com), pero
   no es obligatorio. Basta con una de estas opciones:
   - Ollama,
   - otro servidor local compatible con OpenAI: llama.cpp, LM Studio, vLLM, Jan,
     LocalAI,
   - un proveedor en la nube (DeepSeek, Google AI Studio, OpenRouter...; opcional,
     desactivado de forma predeterminada, consulta `PRIVACY.md`).

   Si no hay ninguno instalado, el chat no funciona: la aplicación muestra el aviso
   "Kurulum tamamlanmadı" (configuración incompleta).
3. **Modelo de embeddings (búsqueda) — opcional.** Sirve cualquier proveedor
   que admita embeddings; si no eliges ninguno, la búsqueda funciona solo por
   palabras clave (FTS) y la búsqueda semántica queda desactivada. Si usas Ollama, el modelo recomendado es
   `bge-m3` — NO `nomic-embed-text` (`EMBED_MODEL` en `src/lib/server/embed-config.ts`;
   da resultados claramente mejores en consultas en turco, y el motivo
   está en el propio comentario de embed-config.ts). Si no descargas en el servidor un
   modelo que hayas configurado para embeddings, `npm run index` falla con "model not found".

**Vía principal: el asistente de configuración.** Se abre en el primer arranque (en el paquete de escritorio) o
desde el navegador en `/setup/local-server`, y también desde el enlace
"Kurulum sihirbazını yeniden çalıştır" (volver a ejecutar el asistente) de la página **Ajustes → Proveedores**; avanza en tres
pasos: (1) localizar/instalar el servidor local, (2) elegir el modelo de chat, (3)
elegir el modelo de embeddings **o bien "solo búsqueda por palabras clave"**. Si prefieres
hacerlo a mano con Ollama:
```bash
ollama serve
ollama pull qwen3:8b      # recommended chat model
ollama pull bge-m3        # recommended embedding model (optional)
# optional, for deep sessions:
ollama pull qwen3:30b-a3b
```

Para verificar todo esto con un solo comando en lugar de comprobarlo a mano:
```bash
npm run doctor
```

## Instalación

```bash
cd vault-chat-beta
npm install
```

El archivo `.env` ya se creó a partir de `.env.example`. Si hace falta, ábrelo y revísalo:

```
CHATS_DB_PATH=./data/chats.db
PUBLIC_VAULT_NAME="My Notes"  # display name of the "default" vault on first launch
```

`OLLAMA_URL` ya no se lee: la dirección de Ollama (y de los demás servidores)
se establece en Ajustes → Proveedores, es decir, en el campo `baseUrl` de `providers.json`.

`PUBLIC_VAULT_NAME` solo se lee como nombre visible predeterminado cuando se crea
por primera vez el vault "default" (consulta
`migrateVaults.ts`); en ejecuciones posteriores no tiene efecto. Las fuentes se abren siempre en el
visor de la propia aplicación. Las carpetas Markdown procedentes de aplicaciones de notas como Obsidian, Logseq, Joplin
o Zettlr son únicamente una fuente de importación
(**Ajustes → Biblioteca**).

`data/providers.json` es un archivo **semilla** que viene con este repositorio: una
instalación nueva encuentra algunos de los proveedores en la nube (DeepSeek, Google AI Studio)
con `enabled: true`. Para usarlos de verdad hay que (a) introducir una clave de API para ese
proveedor en `data/secrets.json` (Ajustes →
Proveedores) y (b) aceptar una casilla de confirmación aparte en cada chat
(consulta `PRIVACY.md`); por sí solo, `enabled: true` no envía ningún
dato. Si no quieres ver los proveedores en la nube ni siquiera como opción en la interfaz,
puedes poner `enabled: false` en la entrada correspondiente de tu propio `data/providers.json`.
La versión de escritorio empaquetada, en cambio, no usa este archivo, sino
`data/providers.default.json`, una semilla limpia: todos los proveedores en la nube desactivados, cadenas de tareas vacías, sin embeddings
(solo búsqueda por palabras clave); el asistente de configuración los rellena.

## Vaults

La aplicación puede mantener **varios vaults** en lugar de una sola biblioteca; cada uno tiene
su propia carpeta de fuentes y su propio índice de búsqueda, completamente aislados entre sí
(`data/vaults/<id>/library/`, `data/vaults/<id>/index.db`). El historial de chats se queda en
una única base de datos global (`data/chats.db`) y cada chat
registra a qué vault pertenece.

- Para crear, eliminar o renombrar vaults: **Ajustes → Vaults**.
- Solo un vault está "activo" a la vez: la pantalla de chat y el indexador trabajan siempre sobre el vault
  activo.
- **Si vienes de una instalación antigua (anterior a los vaults múltiples)** no tienes que hacer nada:
  en el primer arranque el servidor ve que no existe `data/vaults.json`, traslada
  automáticamente el contenido de `LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH`
  a `data/vaults/default/` y registra un vault llamado "default";
  todos los chats antiguos quedan vinculados a ese vault. **`VAULT_PATH` no se
  traslada a propósito**: en la arquitectura antigua era un puntero que señalaba in situ a una carpeta
  viva de notas Markdown (por ejemplo, un vault de Obsidian) y nunca se copiaba; no es una carpeta propia de la aplicación.
  Si solo `VAULT_PATH` está definido (como en este repositorio: `data/library` está vacío y
  el contenido real se indexa in situ desde `VAULT_PATH=..`), el vault "default"
  empieza **vacío**; tendrás que (volver a) importar el contenido
  a mano con la importación de Ajustes → Biblioteca. Si quieres ejecutar esto
  a mano, con vista previa:
  ```bash
  npm run vault:migrate -- --dry-run   # reports what would be moved, writes nothing
  npm run vault:migrate                # actually moves it
  ```

## Primera indexación

Para poder chatear, primero hay que convertir el contenido del vault activo en un índice vectorial:

```bash
npm run index
```

Esto recorre todos los archivos `.md` de la biblioteca del vault activo,
omite con un aviso los que no tienen frontmatter, trocea el resto, lo incrusta con el modelo de embeddings
configurado (recomendado: `bge-m3`) y lo escribe en el `index.db` de ese vault. Si no hay embeddings configurados (modo solo palabras clave), se omite el paso vectorial; los fragmentos y los datos de palabras clave (FTS) se escriben igualmente. Funciona de forma
incremental basada en sha256: omite los archivos sin cambios, con la misma lógica que `pdf2md.py`.

Indicadores:
- `npm run index -- --vault <id>` — indexa un vault concreto en lugar del vault
  activo (id es el identificador que aparece en Ajustes → Vaults).
- `npm run index -- --full` — reindexa todo desde cero (úsalo si cambió el modelo
  de embeddings).
- `npm run index -- --dry-run` — informa de lo que cambiaría sin escribir nada.

## Uso diario

```bash
npm run dev
```

Se abre `http://localhost:5173`. Después de estudiar y actualizar notas, ejecuta
`npm run index` cuando quieras: no hay conflicto ni siquiera con la aplicación abierta (modo WAL).

Si quieres vigilancia automática (opcional, no es lo predeterminado):

```bash
npm run index:watch
```

## Uso permanente (sin servidor de desarrollo)

```bash
npm run build
BODY_SIZE_LIMIT=1G node build
```

Sin `BODY_SIZE_LIMIT`, adapter-node limita el cuerpo de la petición a **512 KB**
(su valor predeterminado) y toda carga de fuentes que supere ese tamaño se rechaza con 413 sin
llegar siquiera a la ruta: un `.docx` pequeño pasa, pero un `.pdf`/`.pptx`/`.xlsx` real no.
En el paquete de escritorio esta variable se pasa automáticamente al sidecar
(`src-tauri/src/lib.rs`); al ejecutar `node build` a mano debes pasarla tú. Este flujo no lee `.env`;
tienes que pasarla como variable de entorno.

## Escritorio (Tauri)

Un paquete que ejecuta el mismo servidor en una ventana nativa en lugar del navegador, sin
usar Electron. **El paquete de Windows incluye Node.js 22 y Python 3.12 (python-build-standalone)**:
ninguno de los dos se instala por separado, la aplicación usa siempre el Node incluido (el instalador de WebView2 también
viene en el paquete). Para el chat hace falta una fuente de modelos (recomendado: Ollama, u otro servidor local / proveedor en la nube),
que no se incluye en el paquete. En los paquetes de macOS/Linux, Node (y Python) siguen instalándose a mano; consulta más abajo.

```bash
npm run desktop:dev      # native window against the live Vite dev server, HMR works
npm run desktop:build    # builds the package for the operating system you are on
```

**El número de versión sube solo.** Antes de compilar, `desktop:build` ejecuta `scripts/release.mjs --auto`: examina los commits ([Conventional Commits](https://www.conventionalcommits.org)) desde la última etiqueta `v*`. `fix`/`perf`/`refactor` significan parche (0.1.0 → 0.1.1), `feat` versión menor (0.1.x → 0.2.0), `!` o `BREAKING CHANGE` versión mayor (→ 1.0.0); `docs`, `chore`, `test` y `ci` no cambian la versión. La subida solo se hace en la rama `main` y con los archivos de versión limpios; se crean el commit `chore(release): vX.Y.Z` y la etiqueta `vX.Y.Z`; para enviarlos, `git push --follow-tags`. A mano: `npm run release` (vista previa: `npm run release -- --dry-run`).

En Windows, la salida de `desktop:build` es: `src-tauri/target/release/bundle/nsis/vault-chat_<version>_x64-setup.exe`
(archivo de instalación NSIS). Los paquetes de Linux y macOS se generan con el mismo comando, en su
propio sistema operativo (no hay compilación cruzada); los destinos están en `src-tauri/tauri.linux.conf.json`
(`deb`, `appimage`) y en `src-tauri/tauri.macos.conf.json` (`app`, `dmg`); consulta
la sección "Linux y macOS (nuevo, beta)" más abajo. Para los paquetes ya listos, el flujo de trabajo `desktop` de GitHub
Actions compila los paquetes de Windows x64, Linux x64, macOS arm64 y macOS x64
y sube un artefacto llamado `vault-chat-<target>` para cada uno
(`.github/workflows/desktop.yml`; los artefactos se conservan 7 días). También se intenta Windows ARM64,
pero por ahora se espera que falle y su resultado no pone el flujo en rojo.
El flujo se ejecuta al hacer push a `main` y a la rama `ci`, con las etiquetas de versión `v*`, en los PR y
manualmente desde la pestaña Actions ("Run workflow"); un cambio solo de documentación
(`*.md`, `docs/`) no inicia ninguna compilación. Mientras el repositorio es privado se omiten las compilaciones de `main`, etiquetas y PR
(los minutos de Actions son limitados); para compilar una rama durante ese tiempo, usa
`git push origin <branch>:ci` (con `--force` si hace falta) o la ejecución manual.

Ubicación de instalación y carpeta de datos en Windows:
La instalación es por usuario (no requiere administrador) y va a `%LOCALAPPDATA%\vault-chat\`.
Los datos de la aplicación (historial de chats, registro de vaults, la biblioteca e índice de cada vault, `config.json`) se guardan en Windows en `%APPDATA%\Roaming\app.vaultchat.desktop\`
(macOS: `~/Library/Application Support/app.vaultchat.desktop/`, Linux:
`~/.local/share/app.vaultchat.desktop/`), totalmente separados de la carpeta `data/` y
sin compartirse con el flujo del navegador. El registro de vaults se resuelve según el `DATA_DIR` de aquí
(una variable de entorno propia del sidecar que el usuario no ve); el único par
`vault_path`/`vault_name` de `config.json` es otra cosa: determina el nombre del vault
**"default"** que se instala primero; los vaults adicionales se crean después desde Ajustes → Vaults dentro de la aplicación.

En el primer arranque se te pide elegir una carpeta (selector de carpetas nativo); esto se pregunta
por el nombre visible del vault "default",
el contenido de la biblioteca NO se vincula a ella (la biblioteca es siempre una
carpeta propia de la aplicación; consulta la sección "Vaults" más arriba). La elección se escribe en `config.json`
y no se vuelve a preguntar en arranques posteriores. Para cambiar este nombre más tarde,
usa **Ajustes → Escritorio — Ubicación del vault** (el cambio surte efecto en el siguiente
inicio; no reinicia el servidor en ejecución).

Como llama directamente a `node build/index.js`, todo lo que exige el flujo de uso
permanente (Node 22, variables de entorno en lugar de `.env`) también
se aplica aquí; consulta la nota anterior.

## Ejecutarlo en otro equipo con Windows

El instalador de Windows incluye Node.js 22 y Python 3.12, pero no incluye el servidor de modelos local
(como Ollama); la fuente de modelos (se recomienda Ollama, otro servidor local o un proveedor en la nube)
debe configurarse aparte en el equipo de destino. En el flujo de desarrollo (`npm run dev` / `node build`) Node sigue instalándose a mano. Tras la instalación en el equipo de destino, `npm run doctor`
(flujo de desarrollo) o el propio aviso de la aplicación "Yerel sunucu … çalışmıyor" /
"Kurulum tamamlanmadı" (paquete de escritorio) te dice qué falta.

| Componente | ¿Obligatorio? | Quién lo instala |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Sí | Incluido en el paquete de escritorio de Windows (la aplicación siempre usa ese); flujo de desarrollo: a mano — https://nodejs.org |
| Ollama + `qwen3:8b` + `bge-m3` | **Recomendado** (también sirve otro servidor local o un proveedor en la nube; sin embeddings, solo búsqueda por palabras clave) | A mano — https://ollama.com, o el asistente de configuración |
| WebView2 Runtime | Sí (solo el paquete de escritorio) | Automático — si no está, el instalador NSIS lo instala con el pequeño instalador que lleva dentro (`embedBootstrapper`); durante la instalación hace falta internet |
| Visual C++ Redistributable | Técnicamente sí | Normalmente ya está en Windows 10/11; si falta, a mano |
| Python 3.12+ (versión estable) | No — solo para importar PDF/documentos/YouTube | Incluido (3.12) en el paquete de escritorio de Windows; si existe un Python del sistema con docling o `PYTHON_BIN`, se prefiere ese. Otros flujos: a mano — https://python.org |
| `markitdown` y otros paquetes ligeros (`pip install -r ingest/requirements.txt`) | No — solo para importar PDF/documentos/YouTube | En el paquete de escritorio, el aviso "Şimdi kur" de la propia aplicación (crea un `python-venv` a partir del Python incluido, requiere internet); otros flujos: a mano |
| docling (PDF/OCR pesado) | No — opcional | A mano (`pip install docling`) |
| pandoc | No — solo para convertir `.tex` | A mano |

Puntos a tener en cuenta:
- **Windows ARM64 no es compatible.** `sqlite-vec` solo tiene un paquete precompilado
  `win32-x64` para Windows: en un equipo Windows basado en ARM
  (Snapdragon, etc.) `npm install` falla en sqlite-vec.
- **Una versión de Node incorrecta se instala en silencio y falla en tiempo de ejecución.** Como
  `engine-strict` está desactivado, `npm install` termina también con Node 20/24, pero
  el binario nativo de `better-sqlite3` está compilado para la ABI de Node 22: el error
  aparece solo en el primer acceso a la base de datos. `npm run doctor` lo detecta justo
  después de la instalación.
- **`secrets.json` no se traslada.** En el paquete de escritorio se
  cifra con AES-256-GCM; la clave de cifrado está en el almacén del sistema operativo (Windows
  DPAPI, macOS Keychain, Linux Secret Service) y está ligada al perfil de usuario/equipo: un `secrets.json`
  copiado a otro equipo/usuario no se puede descifrar y se comporta como "sin clave". Vuelve a introducir las claves de API de los proveedores en la nube (DeepSeek/Gemini/Groq/...)
  en Ajustes → Proveedores en el equipo de destino.
- **El contenido de los vaults se traslada a mano.** `data/vaults.json` es portable porque
  vuelve a derivar sus propias rutas en cada lectura, pero el contenido real de cada vault
  (`data/vaults/<id>/library/`, `index.db`, `study.db`) debe copiarse aparte,
  o bien regenerarse en el equipo de destino con la importación + `npm run index`.
- **En el paquete de escritorio de Windows, para importar PDF/documentos/YouTube solo faltan los
  paquetes ligeros.** La carpeta `ingest/` y Python 3.12 vienen incluidos en el paquete de instalación
  (consulta `scripts/stage-server.mjs`, `scripts/fetch-python-runtime.mjs`); `markitdown`
  y otros paquetes no están en el paquete: en el primer uso la aplicación lo detecta mediante `/api/system/python`
  y, con el botón "Şimdi kur" de un aviso naranja, instala por ti
  `pip install -r ingest/requirements.txt` en el `python-venv` de la carpeta de datos.
  Si ya existe un Python con docling, se prefiere ese.

## Linux y macOS (nuevo, beta)

> **Aviso:** los paquetes de Linux y macOS son nuevos. Se compilan en CI, pero **aún no se
> han probado en un equipo real con Linux/macOS**; además, el paquete de macOS está **sin firmar y
> sin notarizar**. No es tan maduro como el de Windows: si ves algún problema, informa adjuntando el `launch.log`
> de la carpeta de datos (más abajo). Lista de pruebas paso a paso para
> macOS: [`docs/macos-deneme-listesi.md`](../docs/macos-deneme-listesi.md) (en turco).

Formatos de paquete admitidos (se compilan en CI; consulta "Escritorio (Tauri)"):

| Plataforma | Paquete | Nota |
|---|---|---|
| Linux x64 | `.deb`, `.AppImage` | El `.deb` depende de estos paquetes: `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`, `libsecret-1-0` (`src-tauri/tauri.linux.conf.json`) |
| macOS (Apple Silicon e Intel) | `vault-chat.app` + `.dmg`, sin firmar | macOS 11.0 o superior (`minimumSystemVersion`) |

Para compilar desde el código fuente en Linux (lista de paquetes de Ubuntu 22.04 del CI):
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libsecret-1-dev libdbus-1-dev
npm install && npm run desktop:build
```

| Componente | ¿Obligatorio? | Cómo se instala en Linux / macOS |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Sí — no está incluido en el paquete | https://nodejs.org, Homebrew (`brew install node@22`), nvm/fnm/Volta o el gestor de paquetes de tu distribución |
| Fuente de modelos (se recomienda Ollama; otro servidor local o proveedor en la nube) | Una de ellas para el chat | A mano — https://ollama.com |
| Python **3.10+** | No — solo para importar PDF/documentos/YouTube | macOS: `brew install python@3.12`; Linux: gestor de paquetes de la distribución (en Debian/Ubuntu, `sudo apt install python3 python3-venv`) |
| pandoc | No — solo para convertir `.tex` | Homebrew o el gestor de paquetes de la distribución |

Lo que debes saber:
- **¿Cómo se encuentra Node?** Una aplicación abierta desde la interfaz gráfica no hereda el PATH
  del shell. Por eso `node` se busca primero en el PATH (incluido el PATH del shell de sesión/login)
  y luego en ubicaciones conocidas: `/usr/local/bin`, `/usr/bin`,
  `/opt/homebrew/bin`, `~/.volta/bin`, nvm (`~/.nvm/versions/node`) y las carpetas de versiones de fnm
  (`src-tauri/src/platform.rs`, `resolve_node_binary` en `src-tauri/src/lib.rs`). Si la versión principal del
  Node encontrado no es la 22, la aplicación avisa al arrancar.
- **Python "Şimdi kur"** en macOS/Linux no hace `pip install` en el Python del sistema
  (chocaría con la protección "externally managed" de Debian/Homebrew). En su lugar crea en la carpeta de datos
  un entorno virtual propio de la aplicación (`python-venv`) e instala
  allí los paquetes (`src/routes/api/system/python/+server.ts`,
  `src/lib/server/python-bin.ts`). Si en Debian/Ubuntu falta el paquete `python3-venv`,
  no se puede crear el entorno y la aplicación lo dice. En macOS, si las Herramientas de línea de comandos
  (CLT) no están instaladas, se omite el marcador de posición `/usr/bin/python3`
  (para que no se dispare la ventana de instalación). También se puede indicar un intérprete concreto
  con la variable de entorno `PYTHON_BIN`.
- **winget solo existe en Windows.** En macOS/Linux la aplicación no ejecuta por sí misma
  el gestor de paquetes; los comandos de Homebrew / del gestor de paquetes de la distribución
  los ejecutas tú.
- **Las claves de API** están protegidas por el almacén del sistema operativo: en macOS
  el Llavero (servicio `app.vaultchat.desktop`, cuenta `secrets-key`;
  en el primer arranque puede aparecer una pregunta de permiso: "Permitir siempre"), en Linux
  Secret Service (GNOME Keyring / KWallet). Si en Linux este servicio no existe, las claves
  se guardan sin cifrar (en un archivo con permisos `0600`) y verás
  un aviso en Ajustes → Proveedores; al instalar GNOME Keyring o KWallet y reiniciar
  la aplicación, se cifran. Si la clave existe pero no se puede leer ("bloqueada"), no se regenera
  nada; **Ajustes → Proveedores → "Kayıtlı API anahtarlarını
  sıfırla"** (restablecer las claves de API guardadas) hace una copia del archivo antiguo como `secrets.json.locked-<date>` y reinicia
  la aplicación. Detalles: `SECURITY.md`.
- **Procesos en segundo plano:** en Linux, aunque la aplicación se cierre de forma abrupta, el núcleo del sistema operativo envía `SIGTERM`
  al servidor Node (`PR_SET_PDEATHSIG`). En macOS no existe tal
  garantía: el proceso del servidor solo se limpia en una salida normal (Cmd+Q);
  si la aplicación se cierra por un fallo o se fuerza su cierre, el proceso `node` puede quedarse en segundo plano.
- **Archivo de registro:** ante problemas de arranque, `launch.log` — macOS:
  `~/Library/Application Support/app.vaultchat.desktop/launch.log`, Linux:
  `~/.local/share/app.vaultchat.desktop/launch.log`.

### macOS: abrir la aplicación sin firmar (Gatekeeper)

Como la aplicación no está firmada por Apple ni ha pasado la notarización,
macOS la bloquea en el primer arranque ("no se pudo verificar el desarrollador" o "dañada").
Arrastra `vault-chat` desde el `.dmg` a **Applications** y luego, en Finder, haz
**clic derecho → Abrir → Abrir** sobre la aplicación. Si aun así no se abre, quita la marca de cuarentena:

```bash
xattr -dr com.apple.quarantine /Applications/vault-chat.app
```

## Servidor MCP

Un servidor local que expone las notas de tu vault a clientes MCP como Claude Code/Desktop;
no requiere un paquete ni una instalación aparte, `mcp/` vive dentro de este repositorio con el mismo
patrón que `indexer/`.

**En la aplicación de escritorio empaquetada** el servidor viene como un paquete de un solo archivo
(`dist-server/mcp/vault-chat-mcp.mjs`, lo genera `scripts/build-mcp.mjs`; va incluido automáticamente en `npm run stage:server`):
no hacen falta el repositorio, `tsx` ni ninguna otra instalación;
basta con el Node 22 del sistema. La tarjeta **Ajustes → Conectar a un cliente MCP** da la configuración
lista que apunta a este archivo. `node <install>/_up_/dist-server/mcp/vault-chat-mcp.mjs --print-config` (en Windows, la carpeta de instalación es `%LOCALAPPDATA%\vault-chat`)
imprime el mismo bloque. Si no se indica `DATA_DIR`, se usa la carpeta de datos de la aplicación instalada
(`%APPDATA%\app.vaultchat.desktop`; en macOS `~/Library/Application Support/app.vaultchat.desktop`,
en Linux el mismo nombre bajo `$XDG_DATA_HOME` o `~/.local/share`). Al ejecutar desde el código fuente,
la vía `mcp/launch.mjs` sigue siendo válida tal cual. Para generar el paquete por separado: `npm run build:mcp`.

**Herramientas:**

- `list_vaults` — lista los vaults expuestos a MCP (activar/desactivar por vault: **Ajustes → Vaults**).
- `search_library` — busca en el vault; de forma predeterminada (`mode: "auto"`) hace búsqueda vectorial y, si no hay embeddings o no da resultados, recurre a palabras clave (FTS5). `mode`: `vector`, `keyword` (solo FTS5, no requiere embeddings) o `hybrid` (vectorial + FTS5, reciprocal rank fusion). Acepta filtros `domain`/`level`.
- `get_note` — lee una nota; `heading` devuelve solo la sección de ese encabezado, y `max_chars`/`offset` permiten lectura paginada (`hash` es siempre el de todo el archivo).
- `list_domains` — lista los valores de domain del vault con el número de notas y la fecha del último cambio.
- `list_sources` — lista las fuentes del vault con sus valores de domain y nivel.
- `create_vault` — crea un vault nuevo.
- `import_source` — añade un archivo local o una URL a los **pendientes** para importarlos.
- `list_pending_imports` — muestra el estado de las importaciones pendientes.
- `edit_note` — edita una nota existente (requiere como `expected_hash` el valor `hash` de `get_note`; el frontmatter no cambia, la versión anterior se guarda como revisión). **Está desactivada de forma predeterminada**: solo se activa con el interruptor de desarrollador en **Ajustes**, el agente no puede activarla; con ella desactivada, la llamada devuelve el error `MCP_EDIT_NOTE_DISABLED`.

Las herramientas de escritura funcionan a través de la API de la aplicación, por lo que **la aplicación
debe estar abierta** (la aplicación escribe `mcp-endpoint.json` en `DATA_DIR`).
La fuente importada no entra en la biblioteca hasta que la apruebes en la aplicación; el agente
no puede aprobarla él mismo ni cambiar el ajuste. Los archivos locales solo se leen
de las carpetas que permitas en **Ajustes**; las URL pasan por la importación web normal.
Si quieres, puedes activar por vault el ajuste **aprobar automáticamente las importaciones MCP**: `off` (predeterminado, lo apruebas todo tú), `clean` (solo las que no tienen avisos, sin marca de revisión y que no son copias)
o `all` (toda importación correcta). `all` incorpora a la búsqueda el contenido que trae el agente sin que
lo veas; ten en cuenta el riesgo de prompt injection.

**Instalación con un solo comando.** Desde el código fuente (tras `npm install`) este comando lo hace todo:

```bash
npx vault-chat-mcp setup      # or: npm run mcp:setup
```

Si en Windows PowerShell la ejecución de scripts está desactivada (`npx.ps1 cannot be loaded`), escribe `npx.cmd vault-chat-mcp setup` o `npm.cmd run mcp:setup`.

1. **Elige la carpeta de datos:** `--data-dir` > variable de entorno `DATA_DIR` (incluido `.env`) > carpeta de la aplicación de escritorio instalada (si existe) > carpeta `data/` del repositorio.
2. **Lo registra en los clientes MCP que encuentra:** Claude Desktop (incluido el archivo de configuración virtual de la versión de Microsoft Store), Claude Code (si `claude` está en el PATH) y LM Studio (si existe `~/.lmstudio`). Hace una copia de seguridad de los archivos como `<file>.bak-YYYYMMDD-HHMMSS`, no toca otras claves ni otros servidores y nunca sobrescribe un JSON no válido. Tienes que cerrar Claude Desktop por completo y reiniciarlo. Para Jan y otros clientes, al final se imprime el bloque de configuración.
3. **Crea el "Örnek Kasa" (vault de ejemplo):** copia 5 notas de clase cortas (en turco e inglés), lo expone a MCP y lo indexa; puedes probar enseguida `search_library` / `get_note`. Como `vaults.json` pertenece a la aplicación, este paso se omite mientras la aplicación está abierta: cierra la aplicación y vuelve a ejecutar el comando. Si no hay servidor de embeddings (Ollama), el índice se crea solo con búsqueda por palabras clave (FTS5); si el proveedor que configuraste no es accesible, la indexación da error y, con la sugerencia que aparece en pantalla, se ejecuta `npm run index -- --vault ornek-kasa`.

Opciones: `--client claude-desktop,claude-code,lm-studio` (registra solo esos; crea la carpeta si no existe), `--data-dir <folder>`, `--no-sample` (sin vault de ejemplo), `--dry-run` (muestra lo que haría sin escribir nada). `npx vault-chat-mcp config` solo imprime el bloque de configuración. El comando se puede volver a ejecutar: el registro actualizado y el vault de ejemplo existente se dejan tal cual.

Si prefieres instalarlo a mano:

**Conexión.** Los datos de la aplicación de escritorio instalada están en `%APPDATA%\Roaming\app.vaultchat.desktop\`
(consulta "Escritorio (Tauri)"); `DATA_DIR` debe apuntar a esta carpeta.
Si ejecutas desde el código fuente, el valor predeterminado es la carpeta `data/` del repositorio. Para Claude
Code (sin `--scope user` el registro se vincula solo al directorio desde el que se ejecuta el comando):

```bash
claude mcp add --scope user vault-chat -- node "<this repo>\mcp\launch.mjs"
```

Para Claude Desktop, para generar ya listo el bloque que se añade a `%APPDATA%\Claude\claude_desktop_config.json`,
con `DATA_DIR` y la ruta de `node` **absolutos**:

```bash
npm run mcp:config
```

La salida tiene este formato; para que lea los datos de la aplicación instalada, cambia `DATA_DIR` por
la carpeta AppData indicada arriba:

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

`"command"` debe ser `node` (o la ruta absoluta de `node` que escribe `npm run mcp:config`),
no `"npx"`/`"tsx"`: en Windows ambos son shims `.cmd` y dan `ENOENT` en los clientes
que lanzan procesos sin shell.

Verificación:

```bash
npm run mcp:smoke   # tests the tools in a single process, without touching a real model server
```

Con el servidor en marcha, para el diagnóstico basta una sola línea en stderr: `DATA_DIR=... vaults=N`.
En Claude Desktop esta línea va a `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`.

## Proveedores y capacidades de los modelos

Qué proveedor se usa para el chat se elige en **Ajustes → Proveedores**
(o en el asistente durante la primera instalación); Ollama es solo una opción. La capacidad de un
modelo para llamar a herramientas (tools) y para razonar (reasoning) se estima a partir del nombre
del modelo (grafías como Ollama `qwen3:8b`, llama.cpp `Qwen3-8B-Q4_K_M.gguf`, LM Studio/vLLM
`qwen/qwen3-8b` se asocian a la misma familia) y para todos los tipos de servidor
sale de la misma tabla. Si la estimación es incorrecta, en **Ajustes → Proveedores →
"model listesini yönet"** (gestionar la lista de modelos) cada modelo tiene un interruptor de **Herramientas** y otro de **Razonamiento**:
muestran el valor predeterminado de la tabla y, al cambiarlos, escriben una anulación específica del modelo
(`modelCaps` en `providers.json`). En los servidores compatibles con OpenAI marcados como locales (`local`) (llama.cpp,
LM Studio, vLLM), cuando se desactiva el razonamiento, para los modelos que razonan se añade a la petición
`chat_template_kwargs: { enable_thinking: false }` (plantilla de qwen3);
nunca se envía a los proveedores en la nube.

## Ajustes de rendimiento para GPU pequeñas

> Esta sección solo es válida si usas **Ollama** como servidor de modelos
> (`ollama ps`, variables `OLLAMA_*`, Modelfile). En otro servidor como LM Studio o llama.cpp, los ajustes de la ventana de contexto y de las capas en GPU
> se hacen desde la propia interfaz de ese servidor.

Si el modelo local va lento, mira primero esto: con un modelo cargado, ¿la columna
`PROCESSOR` de la salida de `ollama ps` dice `100% GPU` o muestra un reparto como `18%/82% CPU/GPU`?
Si hay reparto, el modelo no cabe en la VRAM y parte de las capas se ejecuta en la CPU; la velocidad
depende en gran medida de la proporción de capas que quedan en la CPU. Los ajustes siguientes reducen esa proporción.
**No cambian la calidad** (mismos pesos, mismo cálculo), solo cambian dónde
se ejecutan las capas.

> Todas las cifras se midieron en **un solo equipo** (RTX 4050 Laptop 6 GB, `qwen3:8b`). En otro hardware
> el orden puede ser el mismo, pero las cifras serán distintas. Si el modelo ya cabe por completo en la GPU
> (`100% GPU`, normalmente tarjetas de 12 GB o más), estos ajustes no tienen efecto.

### 1. Lado de Ollama (se escribe en el entorno de Ollama)

Tres variables de entorno a nivel de usuario; después cierra Ollama desde la barra de tareas y vuelve a abrirlo:

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION', '1',    'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE',   'q8_0', 'User')
[Environment]::SetEnvironmentVariable('LLAMA_ARG_FIT_TARGET',   '256',  'User')
```

- `OLLAMA_FLASH_ATTENTION=1` y `OLLAMA_KV_CACHE_TYPE=q8_0`: reducen la caché KV aproximadamente a la mitad
  y dejan sitio en la VRAM para las capas del modelo.
- `LLAMA_ARG_FIT_TARGET=256` (MiB): el motor de Ollama (`llama-server`) intenta por defecto dejar libres
  **1024 MiB** de VRAM; este valor reduce ese margen. El efecto medido: con el mismo
  modelo, aumenta el número de capas y, en este equipo, ~50 % más de velocidad
  de generación para `qwen3:8b` Q4_K_M. Reducir el margen aumenta el riesgo de falta de memoria
  si compartes la VRAM con otros programas; si ves algún problema, sube el valor o elimina la variable.

**Lo que debes saber**

- `LLAMA_ARG_FIT_TARGET` **no es un ajuste documentado** de Ollama; funciona porque Ollama
  deja que el subproceso del motor herede su entorno al iniciarlo. Una actualización de Ollama podría
  cambiarlo. Tras actualizar, vuelve a mirar `ollama ps`.
- Esta variable afecta a **todos los programas basados en llama.cpp** del equipo.
- Verificación: carga un modelo y mira `ollama ps`; además, en el registro del servidor de Ollama
  (`%LOCALAPPDATA%\Ollama\server.log`) debe aparecer la línea `free memory target of 256 MiB`.
- Para revertir: para cada variable `[Environment]::SetEnvironmentVariable('<NAME>', $null, 'User')`,
  y luego reinicia Ollama.

### 2. Lado de la aplicación

| Ajuste | Predeterminado | Qué hace |
|---|---|---|
| `OLLAMA_SERVE_CTX` | tabla de modelos (`qwen3`: 8192) | Ventana de contexto (`num_ctx`) que se pide a Ollama, para todos los modelos |
| `CHAT_RETRIEVAL_K` | 6 (1–50) | Número de fragmentos de fuente que se recuperan por pregunta en el chat |

- **Dónde se define:** `.env` solo vale para **`npm run dev`** (consulta `.env.example`).
  **`node build` ("Uso permanente") y la aplicación empaquetada (Tauri) no leen `.env`.** Para `node build`,
  define el ajuste en el shell desde el que ejecutas ese comando (`OLLAMA_SERVE_CTX=8192 node build`); para la aplicación
  empaquetada, defínelo como **variable de entorno del sistema operativo** (a nivel `'User'`, como arriba)
  y cierra y vuelve a abrir la aplicación; el proceso del servidor hereda el entorno de la aplicación.
- **Bajar `OLLAMA_SERVE_CTX` puede ser peligroso.** Al reducir la ventana, más capas se quedan en la GPU,
  pero si el prompt (puede llegar a ~4k tokens incluso con k=6) no cabe, Ollama desplaza el contexto y
  **conserva solo los primeros 4 tokens**; las reglas del sistema se pierden en silencio. Antes de
  bajar de los 8192 predeterminados, mira en los registros `llm_timing` de `data/app-log.jsonl` si hay
  `nearCtxLimit: true`.
- **Si tienes VRAM de sobra**, sube ambos a la vez (p. ej. `OLLAMA_SERVE_CTX=16384`,
  `CHAT_RETRIEVAL_K=12`): responde con más fuentes. El efecto de `k` en la calidad de la respuesta
  no es medible, es una cuestión de criterio; si algo empeora, vuelve al valor anterior.

### 3. Cuantización más pequeña (opcional)

Si el modelo no cabe por completo en la GPU, una cuantización más pequeña (p. ej. `IQ4_XS`, ~4.6 GB; `Q4_K_M`
~5.0 GB) mantiene más capas en la GPU. Según una medición publicada (cuantizaciones propias de otro
editor, indica una tendencia), la desviación de `IQ4_XS` es cercana a la de `Q4_K_M`;
en las cuantizaciones de 3 bits (`IQ3_M`, `Q3_K_M`) la desviación aumenta unas 2-3 veces. En local no se hizo
ninguna prueba con potencia suficiente para distinguir la calidad: toma la decisión tú mismo con preguntas reales.

**Descargar directamente un GGUF en bruto.** Las capacidades `tools` y `thinking` del `qwen3:8b` oficial vienen de la
**plantilla** del modelo; descargar un GGUF en bruto de otra fuente las pierde y las herramientas de skills
y el modo de razonamiento de la aplicación no funcionan. La vía correcta es tomar el Modelfile del modelo oficial y cambiar solo la línea
`FROM`:

```powershell
cmd /c "ollama show qwen3:8b --modelfile > Modelfile"
# In the Modelfile, replace the FROM line with the path of the .gguf file you downloaded (with forward slashes),
# do not touch any other line. Then:
ollama create qwen3:8b-iq4xs -f Modelfile
ollama show qwen3:8b-iq4xs      # tools and thinking should appear under Capabilities
```

(`cmd /c` es a propósito: el operador `>` de Windows PowerShell 5.1 escribe el archivo en UTF-16 y Ollama
no puede leerlo.)

Compara el SHA256 del archivo descargado con el valor de la página del editor.

### 4. Medir

Cada llamada de chat escribe un registro `llm_timing` en `data/app-log.jsonl`: `promptTokens`,
`completionTokens`, `promptMs`, `completionMs`, `loadMs`, `numCtx`, `nearCtxLimit`. Solo
números, sin contenido de texto.

## Resolución de problemas

- **El modelo local va lento** → "Ajustes de rendimiento para GPU pequeñas", más arriba.
- **Aviso "Yerel sunucu … çalışmıyor" / "… sağlayıcısına ulaşılamıyor"** → ¿Está en marcha el
  servidor local que usa el chat (Ollama, LM Studio, llama.cpp...)? Para Ollama,
  `ollama serve`; si la dirección es incorrecta, corrige el `baseUrl` de ese proveedor
  en Ajustes → Proveedores (`OLLAMA_URL` ya no se lee).
- **Aviso "Kurulum tamamlanmadı" / el chat no responde** → La cadena de chat
  está vacía: ejecuta el asistente de configuración (`/setup/local-server`) o, en Ajustes →
  Proveedores, añade y activa un proveedor y elige su modelo predeterminado.
- **La lista de modelos está vacía / ModelPicker da error** → ¿Hay algún modelo instalado en el servidor?
  (Para Ollama, `ollama pull qwen3:8b`; en LM Studio/llama.cpp, carga un modelo.)
- **Resultados de búsqueda pobres / solo funcionan las palabras clave** → Puede que los embeddings
  no estén configurados (búsqueda semántica desactivada); en Ajustes → Proveedores elige un
  modelo de embeddings y luego reindexa el vault.
- **No se encuentran fuentes / las respuestas no tienen relación** → ¿Se ejecutó `npm run index` y está el índice al día?
  Si usas varios vaults,
  comprueba además: ¿está activo el vault correcto (Ajustes → Vaults)? ¿`npm run index`
  indexó el vault activo o uno distinto (quizá se pasó un vault equivocado con `--vault <id>`)?
- **Las matemáticas no se renderizan / se ve código sin formato como `f(x)`** →
  prueba el pipeline de `src/lib/markdown.ts` con un texto de ejemplo como `f(x)`.
- **El cliente MCP no muestra "connected" / se cierra enseguida** → ¿El valor de `"command"`
  es realmente `"node"` (consulta la nota anterior)? ¿`npm run mcp:smoke`
  pasa sin errores? En Claude Desktop revisa la línea de stderr de
  `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`: ¿`DATA_DIR` apunta al lugar esperado?
- **MCP `search_library` no devuelve resultados pero el propio chat de la aplicación
  sí encuentra** → probablemente leen un `DATA_DIR`/vault distinto; mira los campos
  `indexed`/`noteCount` que devuelve la herramienta `list_vaults`.
- **La lista de modelos o la prueba de conexión de un proveedor en la nube
  (DeepSeek/OpenRouter/Groq/Google AI Studio/Mistral) falla de forma aleatoria, mientras que en el navegador
  esa dirección de API se abre sin problema** → busca en `data/app-log.jsonl` una línea como
  `"listModels: ... fetch failed (SELF_SIGNED_CERT_IN_CHAIN)"` para ese proveedor.
  No es un error en el código de vault-chat: significa que tu antivirus
  (Kaspersky, ESET, Avast/AVG, Bitdefender, Norton, etc., todos tienen la función
  "analizar conexiones cifradas") se interpone en las conexiones HTTPS salientes con su propio certificado raíz
  para inspeccionarlas, pero Node.js (a diferencia de los navegadores) no usa el almacén de certificados de Windows
  y por eso no confía en ese certificado. Solución: en `certmgr.msc` → *Trusted Root
  Certification Authorities* exporta el certificado raíz de tu antivirus
  como `.cer`/`.pem` en Base-64, luego establece la variable de entorno
  `NODE_EXTRA_CA_CERTS` con la ruta de ese archivo y reinicia `npm run dev` (o
  la aplicación de escritorio). Relajar la verificación de certificados
  (`NODE_TLS_REJECT_UNAUTHORIZED=0`) **nunca** es una solución:
  también elimina la protección frente a un ataque real de intermediario.
