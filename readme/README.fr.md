<p align="center">
  <img src="../static/logo.png" alt="logo de vault-chat" width="140" />
</p>

<h1 align="center">Vault Chat</h1>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.de.md">Deutsch</a> · <a href="README.es.md">Español</a> · <b>Français</b> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <b>Un assistant d'étude qui tourne en local et discute avec tes propres notes.</b><br />
  Importe tes documents pour obtenir des réponses avec sources citées, et génère tests, cartes, rapports et diaporamas à partir des mêmes sources.
</p>

<p align="center">
  <img alt="Licence : Apache-2.0" src="https://img.shields.io/badge/licence-Apache--2.0-blue" />
  <img alt="Version" src="https://img.shields.io/github/v/tag/KodAlp/vault-chat-beta?sort=semver&label=version&color=informational" />
  <img alt="Plateforme" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" />
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-24C8DB?logo=tauri&logoColor=white" />
  <img alt="Local d'abord" src="https://img.shields.io/badge/donn%C3%A9es-en%20local-success" />
</p>

<p align="center">
  <img src="../docs/assets/demo-chat.gif" alt="On pose une question au vault ; le modèle local explique la recherche binaire avec le code et la formule des notes, accompagnés de pastilles de sources" width="860" />
</p>

## Que fait-il ?

- **Discussion fondée sur les sources (RAG).** Les réponses proviennent uniquement des notes de ton vault (coffre de notes) ; sous chaque réponse, on voit quelle section de quelle note a été utilisée. Les formules sont rendues avec KaTeX et le code avec coloration syntaxique.
- **Importe tous les types de sources.** Les fichiers PDF, DOCX, PPTX, XLSX, HTML, EPUB, TeX et Markdown, ainsi que les liens et les dossiers Obsidian/Logseq/Joplin/Zettlr, sont convertis en Markdown et ajoutés à la bibliothèque. Pour les PDF riches en formules, une chaîne avec docling et MinerU en secours est utilisée.
- **Outils d'étude.** À partir des mêmes sources, il génère des tests à choix multiples, des cartes de répétition espacée SM-2, des cartes mentales, des rapports avec citations et des diaporamas ; tu suis ta progression sujet par sujet.
- **Plusieurs vaults.** Chaque vault a sa propre bibliothèque et son propre index de recherche, sans mélange possible.
- **Local d'abord.** La voie par défaut est Ollama ou n'importe quel serveur local compatible OpenAI (LM Studio, llama.cpp, vLLM, Jan). Les fournisseurs cloud sont facultatifs, désactivés par défaut, et demandent une confirmation à chaque discussion.
- **Serveur MCP.** Les clients MCP comme Claude Code/Desktop peuvent effectuer des recherches dans ton vault, lire des notes et importer des sources ; l'import entre dans la bibliothèque une fois que tu l'approuves dans l'application (ou si tu actives l'approbation automatique pour le vault).
- **23 langues d'interface**, thèmes clair/sombre et tons chauds, paquet de bureau (Tauri) ou utilisation dans le navigateur.

## Captures d'écran

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/screenshots/home-dark.webp" />
        <img src="../docs/assets/screenshots/home-light.webp" alt="Écran d'accueil du vault : zone de question et discussions précédentes" />
      </picture>
      <p align="center"><sub>Écran d'accueil du vault (thème clair et sombre)</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/chat-code.webp" alt="Une réponse avec bloc de code et formule, accompagnée de pastilles de sources" />
      <p align="center"><sub>Réponse avec pastilles de sources : code et formule réunis</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="../docs/assets/screenshots/study-panel.webp" alt="Panneau d'étude : test, cartes, rapport, carte mentale, diaporama, progression" />
      <p align="center"><sub>Panneau d'étude : test, cartes, rapport, carte mentale, diaporama</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/source-viewer.webp" alt="Visionneuse de sources intégrée à l'application, avec formules rendues par KaTeX" />
      <p align="center"><sub>Visionneuse de sources : édition et versions précédentes</sub></p>
    </td>
  </tr>
</table>

<sub>Les captures ont été prises dans un vault de démonstration composé de notes d'exemple, avec le modèle local <code>qwen3:8b</code>, dans l'interface en anglais.</sub>

## Comment ça marche ?

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/architecture-dark.webp" />
  <img src="../docs/assets/architecture-light.webp" alt="Architecture de Vault Chat : sources, convertisseur, vault, application, fournisseurs de modèles et clients" />
</picture>

Tout tourne dans un seul processus Node, sur `localhost`. Ni Docker ni serveur externe ne sont nécessaires. Tes notes, ton index et ton historique de discussions restent sur ta propre machine.

## Démarrage rapide

```bash
git clone https://github.com/KodAlp/vault-chat-beta.git
cd vault-chat-beta
npm install
npm run dev
```

Ouvre ensuite l'adresse `http://localhost:5173`. L'assistant de configuration du premier lancement trouve le serveur de modèles local et t'aide à choisir le modèle de discussion et le modèle d'embedding. Les prérequis (Node.js 22 et une source de modèles), le paquet de bureau, la configuration MCP et le dépannage figurent dans les sections détaillées ci-dessous.

Pour contribuer, consulte [`CONTRIBUTING.md`](../CONTRIBUTING.md) ; pour la confidentialité, la sécurité et les conditions d'utilisation, consulte [`PRIVACY.md`](../PRIVACY.md), [`SECURITY.md`](../SECURITY.md) et [`TERMS.md`](../TERMS.md). Le projet est sous licence Apache 2.0 ([`LICENSE`](../LICENSE), [`NOTICE`](../NOTICE)).

---

# Installation détaillée

Une application d'étude et de discussion SvelteKit, locale et sans Docker. Elle fait du RAG
sur les notes et documents de ta propre bibliothèque ; elle dialogue avec un serveur de modèles local (Ollama est recommandé mais pas obligatoire —
n'importe quel serveur compatible OpenAI comme LM Studio, llama.cpp, vLLM ou Jan convient aussi)
ou avec un fournisseur cloud facultatif. Un seul processus Node,
lié à `localhost`.

## Prérequis

1. **Node.js 22** (`>=22 <23` ; 20 et 24 ne fonctionnent pas — vérifie la version installée avec `node --version`). Le paquet de bureau Windows embarque Node, donc il n'a pas besoin d'y être installé séparément.
2. **Une source de modèles de discussion** — **Ollama est recommandé** (https://ollama.com), mais
   pas obligatoire. L'une des options suivantes suffit :
   - Ollama,
   - un autre serveur local compatible OpenAI : llama.cpp, LM Studio, vLLM, Jan,
     LocalAI,
   - un fournisseur cloud (DeepSeek, Google AI Studio, OpenRouter... ; facultatif,
     désactivé par défaut, voir `PRIVACY.md`).

   Si aucun n'est installé, la discussion ne fonctionne pas : l'application affiche
   l'avertissement « Configuration incomplète ».
3. **Modèle d'embedding (recherche) — facultatif.** N'importe quel fournisseur
   qui gère les embeddings convient ; si tu n'en choisis aucun, la recherche
   fonctionne uniquement par mots-clés (FTS) et la recherche sémantique reste désactivée. Si tu utilises Ollama, le modèle recommandé est
   `bge-m3` — et NON `nomic-embed-text` (`EMBED_MODEL` dans `src/lib/server/embed-config.ts` ;
   il donne des résultats mesurablement meilleurs sur les requêtes en turc,
   la justification figure dans le commentaire d'embed-config.ts lui-même). Si tu ne récupères pas sur le serveur
   un modèle que tu as configuré pour les embeddings, `npm run index` échoue avec « model not found ».

**Voie principale : l'assistant de configuration.** Il s'ouvre au premier lancement (dans le paquet de bureau) ou
dans le navigateur à l'adresse `/setup/local-server`, ainsi que via le lien
« Relancer l'assistant de configuration » de la page **Paramètres → Fournisseurs**, et se déroule en trois
étapes : (1) trouver/installer le serveur local, (2) choisir le modèle de discussion, (3) choisir
le modèle d'embedding **ou « recherche par mots-clés uniquement »**. Si tu préfères le faire
à la main, pour Ollama :
```bash
ollama serve
ollama pull qwen3:8b      # recommended chat model
ollama pull bge-m3        # recommended embedding model (optional)
# optional, for deep sessions:
ollama pull qwen3:30b-a3b
```

Pour vérifier ces points en une seule commande plutôt qu'à la main :
```bash
npm run doctor
```

## Installation

```bash
cd vault-chat-beta
npm install
```

Le fichier `.env` a déjà été créé à partir de `.env.example`. Ouvre-le et vérifie-le si nécessaire :

```
CHATS_DB_PATH=./data/chats.db
PUBLIC_VAULT_NAME="My Notes"  # display name of the "default" vault on first launch
```

`OLLAMA_URL` n'est plus lu : l'adresse d'Ollama (et des autres serveurs)
se règle dans Paramètres → Fournisseurs, c'est-à-dire via le champ `baseUrl`
de `providers.json`.

`PUBLIC_VAULT_NAME` n'est lu comme nom d'affichage par défaut que lors de la création initiale du vault « default » (voir
`migrateVaults.ts`) — il n'a aucun effet aux exécutions suivantes. Les sources s'ouvrent toujours dans
la visionneuse propre à l'application. Les dossiers Markdown venant d'applications de notes
comme Obsidian, Logseq, Joplin ou Zettlr ne sont que des sources d'import
(**Paramètres → Bibliothèque**).

`data/providers.json` est un fichier **de départ** fourni avec ce dépôt — une nouvelle
installation y trouve certains fournisseurs cloud (DeepSeek, Google AI Studio)
avec `enabled: true`. Les utiliser réellement exige quand même (a) de saisir
une clé API pour ce fournisseur dans `data/secrets.json` (Paramètres →
Fournisseurs) et (b) d'accepter une case de confirmation distincte à chaque discussion
(voir `PRIVACY.md`) — le simple fait d'avoir `enabled: true` n'envoie aucune
donnée. Si tu ne veux même pas voir les fournisseurs cloud comme option dans
l'interface, tu peux passer l'entrée correspondante à `enabled: false` dans ton propre
`data/providers.json`. La version de bureau empaquetée n'utilise pas ce fichier comme base,
mais `data/providers.default.json`, une configuration propre par défaut :
tous les fournisseurs cloud désactivés, chaînes de tâches vides, pas d'embedding
(recherche par mots-clés uniquement) — l'assistant de configuration les remplit.

## Vaults

L'application peut gérer **plusieurs vaults** au lieu d'une seule bibliothèque — chacun avec
son propre dossier de sources et son propre index de recherche, totalement isolés les uns des autres
(`data/vaults/<id>/library/`, `data/vaults/<id>/index.db`). L'historique des discussions reste dans une
base globale unique (`data/chats.db`), et chaque discussion enregistre à quel vault elle appartient.

- Pour créer, supprimer ou renommer un vault : **Paramètres → Vaults**.
- Un seul vault est « actif » à la fois — l'écran de discussion et l'indexeur travaillent toujours sur
  le vault actif.
- **Si tu viens d'une ancienne installation (antérieure au multi-vault)**, tu n'as rien à
  faire — au premier lancement, le serveur constate que `data/vaults.json` n'existe pas,
  déplace automatiquement le contenu de `LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH`
  sous `data/vaults/default/` et enregistre un vault nommé « default » ;
  toutes les anciennes discussions sont rattachées à ce vault. **`VAULT_PATH` n'est volontairement
  pas déplacé** — dans l'ancienne architecture, c'était un pointeur vers un dossier de notes Markdown vivant
  (par ex. un vault Obsidian) utilisé sur place (jamais copié), et non un dossier appartenant à l'application.
  Si seul `VAULT_PATH` est défini (comme dans ce dépôt — `data/library` est vide,
  le vrai contenu est indexé sur place depuis `VAULT_PATH=..`), le vault « default »
  démarre **vide** ; tu dois (ré)importer le contenu à la main via l'import dans
  Paramètres → Bibliothèque. Si tu veux lancer cette migration à la main,
  avec un aperçu :
  ```bash
  npm run vault:migrate -- --dry-run   # reports what would be moved, writes nothing
  npm run vault:migrate                # actually moves it
  ```

## Première indexation

Pour pouvoir discuter, le contenu du vault actif doit d'abord être transformé en index vectoriel :

```bash
npm run index
```

Cette commande parcourt tous les fichiers `.md` de la bibliothèque du vault actif,
ignore avec un avertissement ceux qui n'ont pas de frontmatter, découpe les autres en fragments,
les encode avec le modèle d'embedding configuré (recommandé : `bge-m3`) et les écrit dans
le `index.db` de ce vault. Si aucun embedding n'est configuré (mode mots-clés uniquement), l'étape vectorielle est ignorée ; les fragments et les données de mots-clés (FTS) sont tout de même écrits. Elle fonctionne
de façon incrémentale, basée sur sha256 — les fichiers inchangés sont ignorés, avec la même logique que `pdf2md.py`.

Options :
- `npm run index -- --vault <id>` — indexe un vault précis au lieu du vault actif
  (l'id est l'identifiant affiché dans Paramètres → Vaults).
- `npm run index -- --full` — réindexe tout depuis zéro (à utiliser si le modèle
  d'embedding a changé).
- `npm run index -- --dry-run` — indique ce qui changerait, sans rien écrire.

## Utilisation quotidienne

```bash
npm run dev
```

`http://localhost:5173` s'ouvre. Après avoir étudié et mis à jour tes notes, lance `npm run index`
quand tu veux — même avec l'application ouverte, il n'y a pas de conflit (mode WAL).

Si tu veux une surveillance automatique (facultatif, non activé par défaut) :

```bash
npm run index:watch
```

## Utilisation permanente (sans serveur de développement)

```bash
npm run build
BODY_SIZE_LIMIT=1G node build
```

Sans `BODY_SIZE_LIMIT`, adapter-node limite le corps des requêtes à **512 Ko**
(sa valeur par défaut), et tout envoi de source dépassant cette taille est rejeté avec une erreur 413
avant même d'atteindre la route — un petit `.docx` passe, mais un vrai
`.pdf`/`.pptx`/`.xlsx` ne passe pas. Dans le paquet de bureau, cette variable est
transmise automatiquement au sidecar (`src-tauri/src/lib.rs`) ; quand tu lances
`node build` à la main, c'est à toi de la fournir. Ce mode de lancement ne lit pas `.env` ; tu dois
la passer comme variable d'environnement.

## Bureau (Tauri)

Un paquet qui fait tourner le même serveur dans une fenêtre native plutôt que dans un navigateur, sans
Electron. **Le paquet Windows embarque Node.js 22 et Python 3.12 (python-build-standalone)** :
aucun des deux n'est à installer séparément, l'application utilise toujours le Node embarqué (l'installateur WebView2 est aussi
dans le paquet). Pour discuter, il faut une source de modèles (recommandé : Ollama, ou un autre serveur local / fournisseur cloud) ;
elle n'est pas intégrée au paquet. Dans les paquets macOS/Linux, Node (et Python) s'installent encore à la main, voir plus bas.

```bash
npm run desktop:dev      # native window against the live Vite dev server, HMR works
npm run desktop:build    # builds the package for the operating system you are on
```

**Le numéro de version s'incrémente tout seul.** Avant la compilation, `desktop:build` exécute `scripts/release.mjs --auto` : il examine les commits ([Conventional Commits](https://www.conventionalcommits.org)) depuis le dernier tag `v*`. `fix`/`perf`/`refactor` donnent un correctif (0.1.0 → 0.1.1), `feat` une version mineure (0.1.x → 0.2.0), `!` ou `BREAKING CHANGE` une version majeure (→ 1.0.0) ; `docs`, `chore`, `test` et `ci` ne changent pas la version. L'incrémentation n'a lieu que sur la branche `main` et lorsque les fichiers de version sont propres ; elle crée un commit `chore(release): vX.Y.Z` et un tag `vX.Y.Z`, et pour pousser il faut faire `git push --follow-tags`. À la main : `npm run release` (aperçu : `npm run release -- --dry-run`).

Sous Windows, la sortie de `desktop:build` est : `src-tauri/target/release/bundle/nsis/vault-chat_<version>_x64-setup.exe`
(fichier d'installation NSIS). Les paquets Linux et macOS sont produits avec la même commande, sur leur propre
système d'exploitation (pas de compilation croisée) ; les cibles se trouvent dans `src-tauri/tauri.linux.conf.json`
(`deb`, `appimage`) et `src-tauri/tauri.macos.conf.json` (`app`, `dmg`) — voir la
section « Linux et macOS (nouveau, bêta) » plus bas. Pour des paquets prêts à l'emploi, le workflow `desktop` de GitHub
Actions compile les paquets Windows x64, Linux x64, macOS arm64 et macOS x64
et téléverse pour chacun un artifact nommé `vault-chat-<target>`
(`.github/workflows/desktop.yml` ; les artifacts sont conservés 7 jours). Windows ARM64 est aussi
essayé, mais son échec est pour l'instant attendu et ne fait pas passer le résultat au rouge.
Le workflow se déclenche sur les push vers `main` et la branche `ci`, sur les tags de version `v*`, sur les PR et
manuellement depuis l'onglet Actions (« Run workflow ») ; une simple modification de documentation
(`*.md`, `docs/`) ne lance pas de compilation. Tant que le dépôt est privé, les compilations `main`, tags et PR
sont ignorées (les minutes d'Actions sont limitées) ; pour faire compiler une branche pendant ce temps,
utilise `git push origin <branch>:ci` (avec `--force` si nécessaire) ou un lancement manuel.

Emplacement d'installation et dossier de données sous Windows :
L'installation se fait par utilisateur (sans droits administrateur), sous `%LOCALAPPDATA%\vault-chat\`.
Les données de l'application (historique des discussions, registre des vaults, bibliothèque et index de chaque vault, `config.json`)
sont conservées sous Windows dans `%APPDATA%\Roaming\app.vaultchat.desktop\`
(macOS : `~/Library/Application Support/app.vaultchat.desktop/`, Linux :
`~/.local/share/app.vaultchat.desktop/`) — totalement séparées du dossier `data/` et
non partagées avec le mode navigateur. Le registre des vaults est résolu à partir du `DATA_DIR` d'ici (la
variable d'environnement propre au sidecar, que l'utilisateur ne voit pas) ; la paire unique
`vault_path`/`vault_name` de `config.json` est en revanche autre chose — elle détermine le nom du premier vault
**« default »** installé, et les vaults supplémentaires se créent ensuite depuis Paramètres → Vaults
dans l'application.

Au premier lancement, on te demande de choisir un dossier (sélecteur de dossier natif) — cela sert au nom d'affichage
du vault « default »,
le contenu de la bibliothèque n'y est PAS rattaché (la bibliothèque est toujours un dossier
appartenant à l'application, voir la section « Vaults » ci-dessus). Le choix est écrit dans `config.json`
et n'est plus redemandé aux lancements suivants. Pour changer ce nom plus tard,
utilise **Paramètres → Bureau — Emplacement du vault** (le changement prend effet au prochain
démarrage, il ne redémarre pas le serveur en cours d'exécution).

Comme il appelle directement `node build/index.js`, tout ce qu'exige le mode d'utilisation permanente
(Node 22, variables d'environnement et non `.env`) s'applique aussi ici — voir la note ci-dessus.

## Exécution sur une autre machine Windows

L'installateur Windows embarque Node.js 22 et Python 3.12, mais pas le serveur de modèles local
(comme Ollama) — la source de modèles (Ollama recommandé, un autre serveur local ou un fournisseur cloud)
doit être configurée séparément sur la machine cible. Dans le flux développeur (`npm run dev` / `node build`), Node s'installe encore à la main. Une fois l'installation faite sur la machine cible, `npm run doctor`
(flux développeur) ou la bannière propre à l'application « Serveur local … ne fonctionne pas » /
« Configuration incomplète » (paquet de bureau) indique ce qui manque.

| Composant | Obligatoire | Qui l'installe |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Oui | Embarqué dans le paquet de bureau Windows (l'application l'utilise toujours) ; flux développeur : à la main — https://nodejs.org |
| Ollama + `qwen3:8b` + `bge-m3` | **Recommandé** (un autre serveur local ou un fournisseur cloud convient aussi ; sans embedding, recherche par mots-clés uniquement) | À la main — https://ollama.com, ou l'assistant de configuration |
| WebView2 Runtime | Oui (paquet de bureau uniquement) | Automatique — l'installateur NSIS l'installe, s'il est absent, avec le petit programme d'amorçage inclus (`embedBootstrapper`) ; Internet est nécessaire pendant l'installation |
| Visual C++ Redistributable | Techniquement oui | Généralement déjà présent sous Windows 10/11 ; sinon, à la main |
| Python 3.12+ (version stable) | Non — uniquement pour l'import de PDF/documents/YouTube | Embarqué (3.12) dans le paquet de bureau Windows ; un Python système avec docling ou `PYTHON_BIN`, s'il existe, est préféré. Autres flux : à la main — https://python.org |
| `markitdown` et autres paquets légers (`pip install -r ingest/requirements.txt`) | Non — uniquement pour l'import de PDF/documents/YouTube | Dans le paquet de bureau, la bannière « Installer maintenant » de l'application (crée `python-venv` à partir du Python embarqué, Internet nécessaire) ; autres flux : à la main |
| docling (PDF/OCR lourds) | Non — facultatif | À la main (`pip install docling`) |
| pandoc | Non — uniquement pour la conversion de `.tex` | À la main |

Points d'attention :
- **Windows ARM64 n'est pas pris en charge.** `sqlite-vec` ne propose pour Windows que le
  paquet précompilé `win32-x64` — sur une machine Windows basée sur ARM
  (Snapdragon, etc.), `npm install` échoue pour sqlite-vec.
- **Une mauvaise version de Node s'installe sans bruit et plante à l'exécution.** Comme `engine-strict`
  est désactivé, `npm install` se termine aussi avec Node 20/24, mais le binaire natif de
  `better-sqlite3` est compilé pour l'ABI de Node 22 — l'erreur n'apparaît qu'au
  premier accès à la base de données. `npm run doctor` l'attrape juste après
  l'installation.
- **`secrets.json` n'est pas transférable.** Dans le paquet de bureau, il est
  chiffré en AES-256-GCM ; la clé de chiffrement se trouve dans le magasin du système
  d'exploitation (Windows DPAPI, macOS Keychain, Linux Secret Service) et est liée au
  profil utilisateur/machine — un `secrets.json` copié vers une autre machine ou un autre utilisateur
  ne peut pas être déchiffré et se comporte comme « pas de clé ». Saisis de nouveau les clés API des fournisseurs cloud (DeepSeek/Gemini/Groq/...)
  dans Paramètres → Fournisseurs sur la machine cible.
- **Le contenu des vaults se transfère à la main.** `data/vaults.json` est portable car il redérive
  ses propres chemins à chaque lecture, mais le contenu réel de chaque vault
  (`data/vaults/<id>/library/`, `index.db`, `study.db`) doit être copié séparément —
  ou recréé sur la machine cible par l'import + `npm run index`.
- **Dans le paquet de bureau Windows, seuls les paquets légers manquent pour l'import de PDF/documents/YouTube.**
  Le dossier `ingest/` et Python 3.12 sont inclus dans le paquet d'installation
  (voir `scripts/stage-server.mjs`, `scripts/fetch-python-runtime.mjs`) ; `markitdown`
  et les autres paquets ne sont pas dans le paquet : à la première utilisation, l'application le détecte via `/api/system/python`
  et, dans une bannière orange, le bouton « Installer maintenant » installe à ta place
  `pip install -r ingest/requirements.txt` dans le `python-venv` du dossier de données.
  Si un Python avec docling existe déjà, il est préféré.

## Linux et macOS (nouveau, bêta)

> **Avertissement :** les paquets Linux et macOS sont nouveaux. Ils sont compilés en CI, mais **n'ont pas encore été essayés
> sur une vraie machine Linux/macOS** ; de plus, le paquet macOS est **non signé et non
> notarisé**. Ils sont moins aboutis que sous Windows — si tu rencontres un problème,
> signale-le en joignant le `launch.log` du dossier de données (voir plus bas). Pour macOS,
> la liste d'essais pas à pas : [`docs/macos-deneme-listesi.md`](../docs/macos-deneme-listesi.md) (en turc).

Formats de paquet pris en charge (compilés en CI ; voir « Bureau (Tauri) ») :

| Plateforme | Paquet | Remarque |
|---|---|---|
| Linux x64 | `.deb`, `.AppImage` | Le `.deb` dépend des paquets suivants : `libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`, `libsecret-1-0` (`src-tauri/tauri.linux.conf.json`) |
| macOS (Apple Silicon et Intel) | `vault-chat.app` + `.dmg`, non signé | macOS 11.0 et supérieur (`minimumSystemVersion`) |

Pour compiler depuis les sources sous Linux (liste des paquets Ubuntu 22.04 utilisée en CI) :
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libsecret-1-dev libdbus-1-dev
npm install && npm run desktop:build
```

| Composant | Obligatoire | Comment l'installer sous Linux / macOS |
|---|---|---|
| Node.js 22.x (`>=22 <23`) | Oui — non embarqué dans le paquet | https://nodejs.org, Homebrew (`brew install node@22`), nvm/fnm/Volta ou le gestionnaire de paquets de la distribution |
| Source de modèles (Ollama recommandé, autre serveur local ou fournisseur cloud) | L'une d'elles pour la discussion | À la main — https://ollama.com |
| Python **3.10+** | Non — uniquement pour l'import de PDF/documents/YouTube | macOS : `brew install python@3.12` ; Linux : gestionnaire de paquets de la distribution (sous Debian/Ubuntu, `sudo apt install python3 python3-venv`) |
| pandoc | Non — uniquement pour la conversion de `.tex` | Homebrew ou le gestionnaire de paquets de la distribution |

À savoir :
- **Comment Node est-il trouvé ?** Une application lancée depuis l'interface graphique n'hérite pas du PATH
  du shell. C'est pourquoi `node` est d'abord cherché dans le PATH (y compris celui du shell de session/login),
  puis dans des emplacements connus : `/usr/local/bin`, `/usr/bin`,
  `/opt/homebrew/bin`, `~/.volta/bin`, nvm (`~/.nvm/versions/node`) et les dossiers de versions
  de fnm (`src-tauri/src/platform.rs`, `resolve_node_binary` dans `src-tauri/src/lib.rs`). Si la version majeure du Node trouvé
  n'est pas 22, l'application te prévient au démarrage.
- **« Installer maintenant » pour Python** ne fait pas de `pip install` dans le Python du système
  sous macOS/Linux (il se heurte à la protection « externally managed » de Debian/Homebrew). À la place, il crée dans le dossier de données
  un environnement virtuel propre à l'application (`python-venv`) et y installe les paquets
  (`src/routes/api/system/python/+server.ts`,
  `src/lib/server/python-bin.ts`). Sous Debian/Ubuntu, si le paquet `python3-venv`
  est absent, l'environnement ne peut pas être créé et l'application te le dit. Sous macOS, si les outils en ligne de commande
  (CLT) ne sont pas installés, le substitut `/usr/bin/python3` est ignoré
  (pour ne pas déclencher la fenêtre d'installation). Un interpréteur précis peut aussi être indiqué
  avec la variable d'environnement `PYTHON_BIN`.
- **winget n'existe que sous Windows.** Sous macOS/Linux, l'application n'exécute pas
  elle-même le gestionnaire de paquets ; c'est toi qui lances les commandes de Homebrew / du gestionnaire de paquets
  de la distribution.
- **Les clés API** sont protégées par le magasin du système d'exploitation : sous macOS, le
  Trousseau (service `app.vaultchat.desktop`, compte `secrets-key` ;
  une demande d'autorisation peut apparaître au premier lancement — « Toujours autoriser »), sous Linux,
  Secret Service (GNOME Keyring / KWallet). Sous Linux, si ce service est absent, les clés sont stockées
  sans chiffrement (dans un fichier avec les droits `0600`) et tu vois un avertissement dans Paramètres → Fournisseurs ;
  si tu installes GNOME Keyring ou KWallet et redémarres l'application, elles sont chiffrées. Si la clé existe mais ne peut pas être lue (« verrouillée »), rien n'est
  régénéré ; **Paramètres → Fournisseurs → « Réinitialiser les clés API enregistrées »**
  sauvegarde l'ancien fichier sous le nom `secrets.json.locked-<date>` et redémarre
  l'application. Détails : `SECURITY.md`.
- **Processus d'arrière-plan :** sous Linux, même si l'application plante, le noyau du système d'exploitation envoie `SIGTERM`
  au serveur Node (`PR_SET_PDEATHSIG`). Sous macOS, il n'y a pas une telle
  garantie : le processus du serveur n'est nettoyé qu'à la sortie normale (Cmd+Q) ;
  si l'application plante ou est tuée de force, le processus `node` peut rester en arrière-plan.
- **Fichier journal :** en cas de problème au démarrage, `launch.log` — macOS :
  `~/Library/Application Support/app.vaultchat.desktop/launch.log`, Linux :
  `~/.local/share/app.vaultchat.desktop/launch.log`.

### macOS : ouvrir l'application non signée (Gatekeeper)

Comme l'application n'est ni signée par Apple ni notarisée, macOS la bloque
au premier lancement (« développeur non vérifié » ou « endommagée »).
Fais glisser `vault-chat` du `.dmg` vers **Applications**, puis, dans le Finder, fais un
**clic droit → Ouvrir → Ouvrir** sur l'application. Si elle ne s'ouvre toujours pas, retire l'attribut de quarantaine :

```bash
xattr -dr com.apple.quarantine /Applications/vault-chat.app
```

## Serveur MCP

Un serveur local qui expose les notes de ton vault aux clients MCP comme Claude Code/Desktop —
il n'exige ni paquet ni installation séparés, `mcp/` vit dans ce dépôt, selon le même schéma que
`indexer/`.

**Dans l'application de bureau empaquetée**, le serveur est fourni sous forme d'un paquet en un seul fichier
(`dist-server/mcp/vault-chat-mcp.mjs`, produit par `scripts/build-mcp.mjs` ; automatique dans
`npm run stage:server`) : ni dépôt, ni `tsx`, ni autre installation nécessaires,
le Node 22 du système suffit. La carte **Paramètres → Se connecter à un client MCP** fournit la configuration
prête à l'emploi pointant vers ce fichier. `node <install>/_up_/dist-server/mcp/vault-chat-mcp.mjs --print-config` (sous Windows, le dossier d'installation est `%LOCALAPPDATA%\vault-chat`)
imprime aussi le même bloc. Si `DATA_DIR` n'est pas fourni, le dossier de données de l'application installée
(`%APPDATA%\app.vaultchat.desktop`, sous macOS `~/Library/Application Support/app.vaultchat.desktop`,
sous Linux le même nom dans `$XDG_DATA_HOME` ou `~/.local/share`) est utilisé. Lorsqu'on lance depuis le code source,
la voie `mcp/launch.mjs` reste valable telle quelle. Pour produire le paquet seul : `npm run build:mcp`.

**Outils :**

- `list_vaults` — liste les vaults ouverts à MCP (activation/désactivation par vault : **Paramètres → Vaults**).
- `search_library` — recherche dans le vault ; par défaut (`mode: "auto"`), recherche vectorielle, avec repli sur les mots-clés (FTS5) s'il n'y a pas d'embedding ou pas de résultat. `mode` : `vector`, `keyword` (FTS5 seul, aucun embedding requis) ou `hybrid` (vectoriel + FTS5, reciprocal rank fusion). Accepte les filtres `domain`/`level`.
- `get_note` — lit une note ; `heading` ne renvoie que la section de ce titre, `max_chars`/`offset` permettent une lecture paginée (`hash` est toujours celui du fichier entier).
- `list_domains` — liste les valeurs de domain du vault avec le nombre de notes et la date de dernière modification.
- `list_sources` — liste les sources du vault avec leurs valeurs de domain et de niveau.
- `create_vault` — crée un nouveau vault.
- `import_source` — ajoute un fichier local ou une URL aux **imports en attente** pour l'importer.
- `list_pending_imports` — affiche l'état des imports en attente.
- `edit_note` — modifie une note existante (le `hash` de `get_note` est requis comme `expected_hash` ; le frontmatter ne change pas, la version précédente est conservée comme révision). **Désactivé par défaut** : il ne s'active que via l'interrupteur développeur dans **Paramètres**, l'agent ne peut pas l'activer ; lorsqu'il est désactivé, l'appel renvoie l'erreur `MCP_EDIT_NOTE_DISABLED`.

Les outils d'écriture passent par l'API de l'application, c'est pourquoi **l'application doit être
ouverte** (l'application écrit `mcp-endpoint.json` dans `DATA_DIR`).
La source importée n'entre pas dans la bibliothèque tant que tu ne l'as pas approuvée dans l'application ; l'agent
ne peut ni l'approuver lui-même ni modifier ce réglage. Les fichiers locaux ne sont lus que dans les dossiers
que tu as autorisés dans **Paramètres** ; les URL passent par l'import web
normal. Si tu veux, tu peux activer, par vault, le réglage **approuver automatiquement les imports MCP** : `off` (par défaut, tu approuves tout),
`clean` (uniquement ceux sans avertissement, sans marqueur de revue et qui ne sont pas des doublons)
ou `all` (tout import réussi). `all` intègre à la recherche le contenu apporté par l'agent sans que tu
le voies — tiens compte du risque de prompt injection.

**Installation en une commande.** Depuis le code source (après `npm install`), cette commande fait tout :

```bash
npx vault-chat-mcp setup      # or: npm run mcp:setup
```

Si l'exécution de scripts est désactivée dans Windows PowerShell (`npx.ps1 cannot be loaded`), tape `npx.cmd vault-chat-mcp setup` ou `npm.cmd run mcp:setup`.

1. **Choisit le dossier de données :** `--data-dir` > variable d'environnement `DATA_DIR` (y compris `.env`) > dossier de l'application de bureau installée (s'il existe) > dossier `data/` du dépôt.
2. **L'enregistre auprès des clients MCP qu'il trouve :** Claude Desktop (y compris le fichier de configuration virtuel de la version Microsoft Store), Claude Code (si `claude` est dans le PATH) et LM Studio (si `~/.lmstudio` existe). Il sauvegarde les fichiers sous la forme `<file>.bak-YYYYMMDD-HHMMSS`, ne touche ni aux autres clés ni aux autres serveurs et n'écrase jamais un JSON invalide. Tu dois quitter complètement Claude Desktop puis le relancer. Pour Jan et les autres clients, un bloc de configuration est imprimé à la fin.
3. **Crée un « Örnek Kasa » (vault d'exemple) :** il copie 5 courtes notes de cours (en turc et en anglais), l'ouvre à MCP et l'indexe ; tu peux tout de suite essayer `search_library` / `get_note`. Comme `vaults.json` appartient à l'application, cette étape est ignorée quand l'application est ouverte : ferme l'application et relance la commande. S'il n'y a pas de serveur d'embedding (Ollama), l'index est construit avec la seule recherche par mots-clés (FTS5) ; si le fournisseur que tu as configuré est inaccessible, l'indexation échoue et l'on lance `npm run index -- --vault ornek-kasa` en suivant l'indication affichée.

Options : `--client claude-desktop,claude-code,lm-studio` (n'enregistre que ceux-ci ; crée le dossier s'il n'existe pas), `--data-dir <folder>`, `--no-sample` (pas de vault d'exemple), `--dry-run` (montre ce qu'il ferait sans rien écrire). `npx vault-chat-mcp config` n'imprime que le bloc de configuration. La commande peut être relancée : l'enregistrement à jour et le vault d'exemple existant sont laissés tels quels.

Si tu préfères installer à la main :

**Se connecter.** Les données de l'application de bureau installée se trouvent sous `%APPDATA%\Roaming\app.vaultchat.desktop\`
(voir « Bureau (Tauri) ») ; `DATA_DIR` doit pointer vers ce dossier.
Si tu lances depuis le code source, la valeur par défaut est le dossier `data/` du dépôt. Pour Claude
Code (sans `--scope user`, l'enregistrement n'est lié qu'au répertoire dans lequel la commande
est exécutée) :

```bash
claude mcp add --scope user vault-chat -- node "<this repo>\mcp\launch.mjs"
```

Pour Claude Desktop, afin de générer prêt à l'emploi, avec un `DATA_DIR` et un chemin `node` **absolus**,
le bloc à ajouter à `%APPDATA%\Claude\claude_desktop_config.json` :

```bash
npm run mcp:config
```

La sortie a la forme suivante ; pour lire les données de l'application installée, remplace `DATA_DIR`
par le dossier AppData ci-dessus :

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

`"command"` doit être `node` (ou le chemin absolu de `node` écrit par `npm run mcp:config`),
et non `"npx"`/`"tsx"` — sous Windows, les deux sont des shims `.cmd` et provoquent `ENOENT` chez les clients
qui lancent le processus sans shell.

Vérification :

```bash
npm run mcp:smoke   # tests the tools in a single process, without touching a real model server
```

Quand le serveur tourne, une seule ligne sur stderr suffit au diagnostic : `DATA_DIR=... vaults=N`.
Dans Claude Desktop, cette ligne arrive dans `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`.

## Fournisseurs et capacités des modèles

Le fournisseur utilisé pour la discussion se choisit dans **Paramètres → Fournisseurs**
(ou dans l'assistant lors de la première installation) ; Ollama n'est qu'une option. Les capacités d'un
modèle en appel d'outils (tools) et en raisonnement (reasoning) sont devinées à partir du nom du modèle
(des écritures comme Ollama `qwen3:8b`, llama.cpp `Qwen3-8B-Q4_K_M.gguf`, LM Studio/vLLM
`qwen/qwen3-8b` sont rattachées à la même famille) et proviennent du même tableau pour chaque type de
serveur. Si la déduction est fausse, dans **Paramètres → Fournisseurs →
« gérer la liste des modèles »**, chaque modèle a un interrupteur **Outils** et un interrupteur **Raisonnement** :
ils reflètent la valeur par défaut du tableau et, quand tu les changes, écrivent un
remplacement propre au modèle (`modelCaps` dans `providers.json`). Pour les serveurs compatibles OpenAI marqués
local (`local`) (llama.cpp, LM Studio, vLLM), quand la réflexion est désactivée,
`chat_template_kwargs: { enable_thinking: false }` est ajouté à la requête pour les modèles qui raisonnent (modèle de gabarit qwen3) ;
il n'est jamais envoyé aux fournisseurs cloud.

## Réglages de performance pour les petits GPU

> Cette section ne s'applique que si tu utilises **Ollama** comme serveur de modèles
> (`ollama ps`, variables `OLLAMA_*`, Modelfile). Avec un autre serveur comme LM Studio ou llama.cpp,
> la fenêtre de contexte et le nombre de couches GPU se règlent depuis l'interface
> de ce serveur.

Si le modèle local est lent, regarde d'abord ceci : quand un modèle est chargé, la colonne
`PROCESSOR` de la sortie `ollama ps` indique-t-elle `100% GPU`, ou une répartition comme `18%/82% CPU/GPU` ?
S'il y a répartition, le modèle ne tient pas dans la VRAM et une partie des couches tourne sur le CPU ; la vitesse
dépend en grande partie de la proportion de couches restées sur le CPU. Les réglages ci-dessous
réduisent cette proportion. Ils **ne changent pas la qualité** (mêmes poids, même calcul), ils changent seulement
l'endroit où les couches s'exécutent.

> Tous les chiffres ont été mesurés sur **une seule machine** (RTX 4050 Laptop 6 Go, `qwen3:8b`). Sur un autre
> matériel, le classement peut rester le même mais les chiffres seront différents. Si le modèle tient déjà entièrement sur le GPU
> (`100% GPU`, généralement les cartes de 12 Go et plus), ces réglages n'ont aucun effet.

### 1. Côté Ollama (écrit dans l'environnement d'Ollama)

Trois variables d'environnement au niveau utilisateur, puis ferme Ollama depuis la barre des tâches et rouvre-le :

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION', '1',    'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE',   'q8_0', 'User')
[Environment]::SetEnvironmentVariable('LLAMA_ARG_FIT_TARGET',   '256',  'User')
```

- `OLLAMA_FLASH_ATTENTION=1` et `OLLAMA_KV_CACHE_TYPE=q8_0` : réduisent le cache KV d'environ
  moitié et libèrent de la place dans la VRAM pour les couches du modèle.
- `LLAMA_ARG_FIT_TARGET=256` (Mio) : le moteur d'Ollama (`llama-server`) essaie par défaut de
  laisser libres **1024 Mio** de VRAM ; cette valeur réduit la marge. L'effet mesuré, sur le même
  modèle, est une hausse du nombre de couches et, sur cette machine, une génération ~50 % plus rapide pour `qwen3:8b` Q4_K_M.
  Réduire la marge augmente le risque de manque de mémoire si tu partages la VRAM avec d'autres programmes ;
  si tu observes un problème, augmente la valeur ou supprime la variable.

**À savoir**

- `LLAMA_ARG_FIT_TARGET` n'est **pas un réglage documenté** d'Ollama ; il fonctionne parce qu'Ollama
  transmet son environnement en héritage quand il lance le moteur comme sous-processus. Une mise à jour d'Ollama peut
  le changer. Après une mise à jour, regarde de nouveau `ollama ps`.
- Cette variable affecte **tous les programmes basés sur llama.cpp** de la machine.
- Vérification : charge un modèle et regarde `ollama ps` ; de plus, la ligne
  `free memory target of 256 MiB` doit apparaître dans le journal du serveur d'Ollama
  (`%LOCALAPPDATA%\Ollama\server.log`).
- Annulation : pour chaque variable, `[Environment]::SetEnvironmentVariable('<NAME>', $null, 'User')`,
  puis redémarre Ollama.

### 2. Côté application

| Réglage | Par défaut | Ce qu'il fait |
|---|---|---|
| `OLLAMA_SERVE_CTX` | tableau des modèles (`qwen3` : 8192) | Fenêtre de contexte demandée à Ollama (`num_ctx`), pour tous les modèles |
| `CHAT_RETRIEVAL_K` | 6 (1–50) | Nombre de fragments de source récupérés par question dans la discussion |

- **Où le fournir :** `.env` ne s'applique qu'à **`npm run dev`** (voir `.env.example`).
  **`node build` (« Utilisation permanente ») et l'application empaquetée (Tauri) ne lisent pas `.env`.** Pour `node build`,
  fournis le réglage dans le shell où tu lances cette commande (`OLLAMA_SERVE_CTX=8192 node build`) ; pour l'application
  empaquetée, fournis-le comme **variable d'environnement du système d'exploitation**
  (au niveau `'User'`, comme ci-dessus), puis ferme et rouvre l'application ; le processus du serveur hérite son environnement de l'application.
- **Réduire `OLLAMA_SERVE_CTX` peut être dangereux.** Quand la fenêtre rétrécit, davantage de couches restent sur le GPU
  mais, si le prompt (qui peut monter à ~4k tokens même avec k=6) ne tient pas, Ollama fait glisser le contexte et
  **ne conserve que les 4 premiers tokens** ; les règles système disparaissent silencieusement. Avant de
  descendre sous la valeur par défaut de 8192, regarde si les enregistrements `llm_timing` de `data/app-log.jsonl`
  contiennent `nearCtxLimit: true`.
- **Si tu as beaucoup de VRAM**, augmente les deux ensemble (par ex. `OLLAMA_SERVE_CTX=16384`,
  `CHAT_RETRIEVAL_K=12`) : il répond avec davantage de sources. L'effet de `k` sur la qualité des réponses
  n'est pas mesurable, c'est une question de jugement ; si quelque chose se dégrade, reviens à l'ancienne valeur.

### 3. Quantification plus petite (facultatif)

Si le modèle ne tient pas entièrement sur le GPU, une quantification plus petite (par ex. `IQ4_XS`, ~4,6 Go ; `Q4_K_M`
~5,0 Go) garde davantage de couches sur le GPU. D'après une mesure publiée (quantifications
spécifiques d'un autre éditeur, elle indique une tendance), l'écart de `IQ4_XS` est proche de celui de `Q4_K_M` ;
pour les quantifications 3 bits (`IQ3_M`, `Q3_K_M`), l'écart est multiplié par environ 2 à 3. Aucun test assez puissant pour
distinguer la qualité n'a été fait en local : prends la décision toi-même avec de vraies questions.

**Récupérer directement un GGUF brut.** Les capacités `tools` et `thinking` du `qwen3:8b` officiel viennent du
**gabarit** du modèle ; récupérer un GGUF brut depuis une autre source les fait perdre, et les outils
de skills / le mode réflexion de l'application ne fonctionnent plus. La bonne méthode consiste à prendre le Modelfile du modèle officiel et à ne changer que la ligne
`FROM` :

```powershell
cmd /c "ollama show qwen3:8b --modelfile > Modelfile"
# In the Modelfile, replace the FROM line with the path of the .gguf file you downloaded (with forward slashes),
# do not touch any other line. Then:
ollama create qwen3:8b-iq4xs -f Modelfile
ollama show qwen3:8b-iq4xs      # tools and thinking should appear under Capabilities
```

(`cmd /c` est voulu : l'opérateur `>` de Windows PowerShell 5.1 écrit le fichier en UTF-16 et Ollama
ne peut pas le lire.)

Compare le SHA256 du fichier téléchargé avec la valeur indiquée sur la page de l'éditeur.

### 4. Mesurer

Chaque appel de discussion écrit un enregistrement `llm_timing` dans `data/app-log.jsonl` : `promptTokens`,
`completionTokens`, `promptMs`, `completionMs`, `loadMs`, `numCtx`, `nearCtxLimit`. Uniquement
des nombres, aucun contenu textuel.

## Dépannage

- **Le modèle local est lent** → « Réglages de performance pour les petits GPU » ci-dessus.
- **Avertissement « Serveur local … ne fonctionne pas » / « … fournisseur injoignable »** → Le serveur
  local utilisé par la discussion (Ollama, LM Studio, llama.cpp...) est-il lancé ? Pour Ollama,
  `ollama serve` ; si l'adresse est mauvaise, corrige le `baseUrl` de ce fournisseur dans Paramètres → Fournisseurs
  (`OLLAMA_URL` n'est plus lu).
- **Avertissement « Configuration incomplète » / la discussion ne répond pas** → La chaîne de discussion
  est vide : lance l'assistant de configuration (`/setup/local-server`) ou, dans Paramètres →
  Fournisseurs, ajoute et active un fournisseur, puis choisis son modèle par défaut.
- **La liste des modèles est vide / ModelPicker renvoie une erreur** → Y a-t-il un modèle chargé
  sur le serveur ? (Pour Ollama, `ollama pull qwen3:8b` ; dans LM Studio/llama.cpp, charge un modèle.)
- **Résultats de recherche faibles / seule la recherche par mots-clés fonctionne** → L'embedding
  n'est peut-être pas configuré (recherche sémantique désactivée) ; choisis un modèle
  d'embedding dans Paramètres → Fournisseurs, puis réindexe le vault.
- **Source introuvable / réponses hors sujet** → `npm run index` a-t-il été lancé, l'index est-il à jour ?
  Si tu utilises plusieurs vaults,
  vérifie aussi : le bon vault est-il actif (Paramètres → Vaults), `npm run index`
  a-t-il indexé le vault actif ou un autre (le mauvais vault a peut-être été indiqué
  avec `--vault <id>`) ?
- **Les maths ne s'affichent pas / du code brut comme `f(x)` apparaît** →
  teste le pipeline de `src/lib/markdown.ts` avec un texte d'exemple comme `f(x)`.
- **Le client MCP n'affiche pas « connected » / se ferme aussitôt** → La valeur de `"command"`
  est-elle bien `"node"` (voir la note ci-dessus) ? `npm run mcp:smoke`
  passe-t-il proprement ? Dans Claude Desktop, vérifie l'unique ligne stderr de
  `%APPDATA%\Claude\logs\mcp-server-vault-chat.log` — `DATA_DIR` pointe-t-il là où tu l'attends ?
- **MCP `search_library` ne renvoie aucun résultat alors que la discussion propre à l'application
  trouve** → ils lisent probablement un autre `DATA_DIR`/vault ; regarde les champs
  `indexed`/`noteCount` renvoyés par l'outil `list_vaults`.
- **La liste des modèles ou le test de connexion d'un fournisseur cloud (DeepSeek/OpenRouter/Groq/Google AI Studio/Mistral)
  échoue de façon aléatoire, alors que cette adresse d'API
  s'ouvre sans problème dans le navigateur** → cherche dans `data/app-log.jsonl`, pour ce
  fournisseur, une ligne comme `"listModels: ... fetch failed (SELF_SIGNED_CERT_IN_CHAIN)"`.
  Ce n'est pas un bug dans le code de vault-chat — cela signifie que ton antivirus
  (Kaspersky, ESET, Avast/AVG, Bitdefender, Norton, etc. ont tous une fonction « analyser les
  connexions chiffrées ») s'interpose dans les connexions HTTPS sortantes avec son propre certificat
  racine pour les inspecter, mais que Node.js (contrairement aux navigateurs) n'utilise pas le
  magasin de certificats de Windows et ne fait donc pas confiance à ce certificat. Solution : dans `certmgr.msc` → *Trusted Root
  Certification Authorities*, exporte le certificat racine de ton antivirus
  au format Base-64 `.cer`/`.pem`, puis règle la variable d'environnement `NODE_EXTRA_CA_CERTS`
  sur le chemin de ce fichier et redémarre `npm run dev` (ou
  l'application de bureau). Assouplir la vérification des certificats
  (`NODE_TLS_REJECT_UNAUTHORIZED=0`) n'est **jamais** une solution —
  cela supprime aussi la protection contre une véritable attaque de l'homme du milieu.
