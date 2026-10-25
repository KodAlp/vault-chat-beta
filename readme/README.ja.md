<p align="center">
  <img src="../static/logo.png" alt="vault-chat のロゴ" width="140" />
</p>

<h1 align="center">Vault Chat</h1>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.de.md">Deutsch</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <b>日本語</b>
</p>

<p align="center">
  <b>自分のノートと対話できる、ローカルで動く学習アシスタント。</b><br />
  ドキュメントをインポートすると、出典付きで質問に答えます。同じ出典から、テスト、カード、レポート、スライドも作成できます。
</p>

<p align="center">
  <img alt="ライセンス: Apache-2.0" src="https://img.shields.io/badge/%E3%83%A9%E3%82%A4%E3%82%BB%E3%83%B3%E3%82%B9-Apache--2.0-blue" />
  <img alt="バージョン" src="https://img.shields.io/github/v/tag/KodAlp/vault-chat-beta?sort=semver&label=%E3%83%90%E3%83%BC%E3%82%B8%E3%83%A7%E3%83%B3&color=informational" />
  <img alt="プラットフォーム" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" />
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-24C8DB?logo=tauri&logoColor=white" />
  <img alt="ローカルファースト" src="https://img.shields.io/badge/%E3%83%87%E3%83%BC%E3%82%BF-%E3%83%AD%E3%83%BC%E3%82%AB%E3%83%AB%E3%81%AB%E4%BF%9D%E5%AD%98-success" />
</p>

<p align="center">
  <img src="../docs/assets/demo-chat.gif" alt="ボールトに質問すると、ローカルモデルがノート内のコードと数式を使って二分探索を説明し、出典チップを表示する" width="860" />
</p>

## 何ができるか

- **出典に基づくチャット（RAG）。** 回答はボールト（vault）内のノートだけに基づき、各回答の下に、どのノートのどのセクションを使ったかが表示されます。数式は KaTeX、コードはシンタックスハイライト付きで表示されます。
- **あらゆる種類の出典をインポート。** PDF、DOCX、PPTX、XLSX、HTML、EPUB、TeX、Markdown ファイルに加え、リンクや Obsidian/Logseq/Joplin/Zettlr のフォルダも Markdown に変換してライブラリに追加します。数式の多い PDF には、docling と MinerU によるフォールバック付きのパイプラインを使います。
- **学習ツール。** 同じ出典から、選択式テスト、SM-2 方式の間隔反復カード、コンセプトマップ、引用付きレポート、スライドを作成し、トピックごとに進捗を追跡します。
- **複数のボールト。** 各ボールトは独自のライブラリと検索インデックスを持ち、互いに混ざりません。
- **ローカルファースト。** 既定の経路は Ollama または OpenAI 互換のローカルサーバー（LM Studio、llama.cpp、vLLM、Jan）です。クラウドプロバイダーは任意で、既定ではオフであり、チャットごとに別途確認が必要です。
- **MCP サーバー。** Claude Code/Desktop などの MCP クライアントが、ボールト内の検索、ノートの読み取り、出典のインポートを行えます。インポートは、アプリで承認したとき（またはボールトの自動承認をオンにしたとき）にライブラリへ入ります。
- **23 の UI 言語**、ライト/ダークと暖色系のテーマ、デスクトップパッケージ（Tauri）またはブラウザでの利用に対応しています。

## スクリーンショット

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/screenshots/home-dark.webp" />
        <img src="../docs/assets/screenshots/home-light.webp" alt="ボールトのホーム画面: 質問ボックスと過去のチャット" />
      </picture>
      <p align="center"><sub>ボールトのホーム画面（ライトテーマとダークテーマ）</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/chat-code.webp" alt="コードブロックと数式を含み、出典チップが付いた回答" />
      <p align="center"><sub>出典チップ付きの回答: コードと数式を一緒に表示</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="../docs/assets/screenshots/study-panel.webp" alt="学習パネル: テスト、カード、レポート、マップ、スライド、進捗" />
      <p align="center"><sub>学習パネル: テスト、カード、レポート、マップ、スライド</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/source-viewer.webp" alt="アプリ内の出典ビューアー。数式は KaTeX で表示される" />
      <p align="center"><sub>出典ビューアー: 編集と以前のバージョン</sub></p>
    </td>
  </tr>
</table>

<sub>スクリーンショットは、サンプルノートで作成したデモ用ボールトで、ローカルの <code>qwen3:8b</code> モデルを使い、英語 UI で撮影しました。</sub>

## 仕組み

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/architecture-dark.webp" />
  <img src="../docs/assets/architecture-light.webp" alt="Vault Chat のアーキテクチャ: 出典、コンバーター、ボールト、アプリ、モデルプロバイダー、クライアント" />
</picture>

すべてが `localhost` 上の単一の Node プロセスで動きます。Docker や外部サーバーは不要です。ノート、インデックス、チャット履歴は自分のマシンの中にだけ残ります。

## クイックスタート

```bash
git clone https://github.com/KodAlp/vault-chat-beta.git
cd vault-chat-beta
npm install
npm run dev
```

その後 `http://localhost:5173` を開きます。初回起動時のセットアップウィザードがローカルモデルサーバーを見つけ、チャットモデルと埋め込みモデルの選択を手伝います。前提条件（Node.js 22 とモデルの提供元）、デスクトップパッケージ、MCP のセットアップ、トラブルシューティングは、以下の詳細セクションに記載しています。

コントリビュートについては [`CONTRIBUTING.md`](../CONTRIBUTING.md) を、プライバシー、セキュリティ、利用条件については [`PRIVACY.md`](../PRIVACY.md)、[`SECURITY.md`](../SECURITY.md)、[`TERMS.md`](../TERMS.md) を参照してください。プロジェクトは Apache 2.0 ライセンスです（[`LICENSE`](../LICENSE)、[`NOTICE`](../NOTICE)）。

---

# 詳細なセットアップ

ローカルで動く、Docker 不要の SvelteKit 製の学習/チャットアプリです。自分のライブラリにある
ノートやドキュメントに対して RAG を行い、ローカルモデルサーバー（Ollama を推奨しますが必須ではありません。
LM Studio、llama.cpp、vLLM、Jan などの OpenAI 互換サーバーでも動作します）
または任意のクラウドプロバイダーと通信します。Node プロセスは 1 つで、
`localhost` にバインドされます。

## 前提条件

1. **Node.js 22**（`>=22 <23`。20 と 24 は動作しません。インストール済みのバージョンは `node --version` で確認できます）。Windows のデスクトップパッケージは Node を内包しているため、そちらでは別途インストールする必要はありません。
2. **チャットモデルの提供元**: **Ollama を推奨**します（https://ollama.com）が、
   必須ではありません。次のいずれかがあれば十分です。
   - Ollama
   - OpenAI 互換のその他のローカルサーバー: llama.cpp、LM Studio、vLLM、Jan、
     LocalAI
   - クラウドプロバイダー（DeepSeek、Google AI Studio、OpenRouter など。任意で、
     既定ではオフ。`PRIVACY.md` を参照）

   どれもインストールされていない場合、チャットは動作しません。アプリは
   「セットアップが完了していません」という警告を表示します。
3. **埋め込み（検索）モデル（任意）。** 埋め込みに対応していれば
   どのプロバイダーでも構いません。何も選ばない場合、検索はキーワード（FTS）のみで
   動作し、意味検索はオフになります。Ollama を使う場合の推奨モデルは
   `bge-m3` で、`nomic-embed-text` ではありません（`src/lib/server/embed-config.ts` の
   `EMBED_MODEL`。トルコ語のクエリで測定可能な形でより良い結果が出ます。
   理由は embed-config.ts 自身のコメントに書かれています）。埋め込み用に設定したモデルを
   サーバーで pull していないと、`npm run index` は "model not found" で失敗します。

**主な方法: セットアップウィザード。** 初回起動時（デスクトップパッケージ）、または
ブラウザの `/setup/local-server` から開けます。また、**設定 → プロバイダー**
ページにある「セットアップウィザードを再実行」リンクからも開け、3 つの
ステップで進みます。(1) ローカルサーバーを検出/インストールする、(2) チャットモデルを選ぶ、(3)
埋め込みモデルを選ぶ、**または「キーワード検索のみ」** を選ぶ。手動で
行いたい場合、Ollama では次のようにします。
```bash
ollama serve
ollama pull qwen3:8b      # recommended chat model
ollama pull bge-m3        # recommended embedding model (optional)
# optional, for deep sessions:
ollama pull qwen3:30b-a3b
```

これらの項目を手動で確認する代わりに、1 つのコマンドで検証するには次のようにします。
```bash
npm run doctor
```

## インストール

```bash
cd vault-chat-beta
npm install
```

`.env` ファイルは `.env.example` からすでに作成されています。必要に応じて開いて確認してください。

```
CHATS_DB_PATH=./data/chats.db
PUBLIC_VAULT_NAME="My Notes"  # display name of the "default" vault on first launch
```

`OLLAMA_URL` はもう読み込まれません。Ollama（およびその他のサーバー）のアドレスは
設定 → プロバイダー、つまり `providers.json` の `baseUrl` フィールドで
指定します。

`PUBLIC_VAULT_NAME` は「default」ボールトを最初に作成するときだけ（`migrateVaults.ts`
を参照）、既定の表示名として読み込まれます。以降の
実行では効果がありません。出典は常にアプリ自身の
ビューアーで開きます。Obsidian、Logseq、Joplin、Zettlr などのノート
アプリから来る Markdown フォルダは、あくまでインポート元の
1 つにすぎません（**設定 → ライブラリ**）。

`data/providers.json` はこのリポジトリに同梱されている**シード**ファイルです。新規の
インストールでは、クラウドプロバイダー（DeepSeek、Google AI Studio）の一部が
`enabled: true` になっています。これらを実際に使うには、それでも (a) そのプロバイダー用の
API キーを `data/secrets.json` に登録すること（設定 →
プロバイダー）、(b) チャットごとに別のチェックボックスを承諾すること
（`PRIVACY.md` を参照）が必要です。`enabled: true` というだけではデータは一切
送信されません。クラウドプロバイダーを UI の選択肢としても
表示したくない場合は、自分の `data/providers.json` で該当するエントリを
`enabled: false` にできます。パッケージ版のデスクトップ版はこのファイルではなく、
クリーンな既定値である `data/providers.default.json` をシードとして
使います。すべてのクラウドプロバイダーがオフ、タスクチェーンは空、埋め込みなし
（キーワード検索のみ）で、セットアップウィザードがこれらを設定します。

## ボールト

アプリは単一のライブラリではなく**複数のボールト**を保持できます。それぞれが
独自の出典フォルダと検索インデックスを持ち、互いに完全に分離されています
（`data/vaults/<id>/library/`、`data/vaults/<id>/index.db`）。チャット履歴は 1 つの
グローバル DB（`data/chats.db`）に残り、各チャットは自分がどのボールトに属するかを
記録します。

- ボールトの作成/削除/名前変更は **設定 → ボールト** で行います。
- 同時に「アクティブ」になるボールトは 1 つだけです。チャット画面とインデクサーは常に
  アクティブなボールトを対象に動作します。
- **古い（複数ボールト以前の）インストールから移行する場合**、何もする必要は
  ありません。サーバーは初回起動時に `data/vaults.json` がないことを検出し、
  `LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH` の中身を自動的に
  `data/vaults/default/` の下へ移して「default」という名前のボールトを登録します。
  古いチャットはすべてこのボールトに紐づきます。**`VAULT_PATH` は意図的に
  移されません**。旧アーキテクチャでは、これは稼働中の Markdown ノートフォルダ
  （例: Obsidian のボールト）をその場で指すポインターであり（コピーはされませんでした）、アプリが所有するフォルダではありませんでした。
  `VAULT_PATH` だけが設定されている場合（このリポジトリのように、`data/library` は空で、
  実際のコンテンツは `VAULT_PATH=..` からその場でインデックスされています）、「default」ボールトは
  **空**の状態で始まります。内容は設定 → ライブラリのインポートで
  手動で（再）インポートする必要があります。これをプレビュー付きで手動実行
  したい場合は次のようにします。
  ```bash
  npm run vault:migrate -- --dry-run   # reports what would be moved, writes nothing
  npm run vault:migrate                # actually moves it
  ```

## 初回のインデックス作成

チャットを始める前に、アクティブなボールトの内容をベクトルインデックスに変換する必要があります。

```bash
npm run index
```

これはアクティブなボールトのライブラリにあるすべての `.md` ファイルをスキャンし、
frontmatter のないものは警告を出してスキップし、残りを分割して
設定済みの埋め込みモデル（推奨: `bge-m3`）で埋め込み、そのボールトの
`index.db` に書き込みます。埋め込みが設定されていない場合（キーワード検索のみの
モード）はベクトルの手順をスキップし、チャンクとキーワード（FTS）データは引き続き書き込まれます。sha256
ベースの増分処理で、変更のないファイルはスキップします。`pdf2md.py` と同じ考え方です。

フラグ:
- `npm run index -- --vault <id>`: アクティブなボールトの代わりに、指定したボールトを
  インデックスします（id は 設定 → ボールト に表示される識別子です）。
- `npm run index -- --full`: すべてを最初から再インデックスします（埋め込みモデルを
  変更した場合はこれを使います）。
- `npm run index -- --dry-run`: 何も書き込まずに、何が変わるかをレポートします。

## 日常の使い方

```bash
npm run dev
```

`http://localhost:5173` が開きます。勉強してノートを更新したあとは、いつでも
`npm run index` を実行してください。アプリを開いたままでも競合は起きません（WAL モード）。

自動監視が必要な場合（任意で、既定ではありません）:

```bash
npm run index:watch
```

## 常用する場合（開発サーバーなし）

```bash
npm run build
BODY_SIZE_LIMIT=1G node build
```

`BODY_SIZE_LIMIT` がないと、adapter-node はリクエストボディを **512 KB** に
制限し（これが adapter 自身の既定値です）、このサイズを超える出典のアップロードはすべて、
ルートに到達する前に 413 で拒否されます。小さな `.docx` は通りますが、実際の
`.pdf`/`.pptx`/`.xlsx` は通りません。デスクトップパッケージではこの変数が sidecar に
自動で渡されます（`src-tauri/src/lib.rs`）。`node build` を手動で
実行する場合は、自分で指定する必要があります。この方法は `.env` を読み込まないため、
環境変数として渡す必要があります。

## デスクトップ（Tauri）

同じサーバーをブラウザの代わりにネイティブウィンドウで動かす、Electron を
使わないパッケージです。**Windows パッケージは Node.js 22 と Python 3.12（python-build-standalone）を
内包しています**。どちらも別途インストールする必要はなく、アプリは常に内蔵の Node を使います（WebView2 のインストーラーも
パッケージに含まれます）。チャットにはモデルの提供元（推奨: Ollama、または別のローカルサーバー/クラウドプロバイダー）
が必要で、パッケージには含まれません。macOS/Linux のパッケージでは Node（と Python）は今も手動でインストールします。下記を参照してください。

```bash
npm run desktop:dev      # native window against the live Vite dev server, HMR works
npm run desktop:build    # builds the package for the operating system you are on
```

**バージョン番号は自動で上がります。** `desktop:build` はビルドの前に `scripts/release.mjs --auto` を実行します。直近の `v*` タグ以降のコミット（[Conventional Commits](https://www.conventionalcommits.org)）を見て、`fix`/`perf`/`refactor` はパッチ（0.1.0 → 0.1.1）、`feat` はマイナーバージョン（0.1.x → 0.2.0）、`!` または `BREAKING CHANGE` はメジャーバージョン（→ 1.0.0）を意味します。`docs`、`chore`、`test`、`ci` ではバージョンは変わりません。バージョンアップは `main` ブランチで、かつバージョンファイルがクリーンな場合にのみ行われ、`chore(release): vX.Y.Z` コミットと `vX.Y.Z` タグが作られます。送信するには `git push --follow-tags` を使います。手動の場合: `npm run release`（プレビュー: `npm run release -- --dry-run`）。

Windows での `desktop:build` の出力: `src-tauri/target/release/bundle/nsis/vault-chat_<version>_x64-setup.exe`
（NSIS インストーラー）。Linux と macOS のパッケージは同じコマンドで、それぞれの
OS 上で生成します（クロスコンパイルはありません）。ターゲットは `src-tauri/tauri.linux.conf.json`
（`deb`、`appimage`）と `src-tauri/tauri.macos.conf.json`（`app`、`dmg`）にあります。下記の
「Linux と macOS（新機能、ベータ）」セクションを参照してください。ビルド済みパッケージについては、GitHub
Actions の `desktop` ワークフローが Windows x64、Linux x64、macOS arm64、macOS x64 の
パッケージをビルドし、それぞれに `vault-chat-<target>` という名前のアーティファクトを
アップロードします（`.github/workflows/desktop.yml`。アーティファクトは 7 日間保存されます）。Windows ARM64 も
試行されていますが、今のところ失敗が想定されており、結果を赤にはしません。
ワークフローは `main` と `ci` ブランチへの push、`v*` リリースタグ、PR、
Actions タブからの手動実行（「Run workflow」）で動作します。ドキュメントのみの変更
（`*.md`、`docs/`）ではビルドは始まりません。リポジトリが非公開の間は `main`、タグ、PR の
ビルドはスキップされます（Actions の分数に限りがあるため）。その間にブランチをビルドさせるには、
`git push origin <branch>:ci`（必要なら `--force`）または手動実行を使います。

Windows でのインストール先とデータフォルダ:
インストールはユーザー単位（管理者権限は不要）で、`%LOCALAPPDATA%\vault-chat\`
の下に入ります。アプリのデータ（チャット履歴、ボールトレジストリ、各ボールトの
ライブラリ/インデックス、`config.json`）は、Windows では `%APPDATA%\Roaming\app.vaultchat.desktop\`
（macOS: `~/Library/Application Support/app.vaultchat.desktop/`、Linux:
`~/.local/share/app.vaultchat.desktop/`）の下に保存されます。`data/` フォルダとは完全に分離されており、ブラウザ版の方法とは
共有されません。ボールトレジストリは、ここにある `DATA_DIR` を基準に解決されます（sidecar
自身の環境変数であり、ユーザーには見えません）。一方 `config.json` にある単一の
`vault_path`/`vault_name` のペアは別のもので、最初に作られる**「default」**
ボールトの名前を決めます。追加のボールトは、あとからアプリ内の 設定 → ボールト で
作成します。

初回起動時にフォルダの選択を求められます（ネイティブのフォルダ選択ダイアログ）。これは「default」
ボールトの表示名のために尋ねられるもので、
ライブラリの内容はそこに紐づき**ません**（ライブラリは常にアプリが所有する
フォルダです。上の「ボールト」セクションを参照）。選択は `config.json` に書き込まれ、
次回以降の起動では再度尋ねられません。この名前をあとから変更するには
**設定 → デスクトップ — ボールトの場所** を使います（変更は次回の
起動で有効になり、稼働中のサーバーは再起動されません）。

`node build/index.js` を直接呼び出すため、常用する場合の方法で
必要になるもの（Node 22、`.env` ではなく環境変数）はここでも
同様に当てはまります。上の注記を参照してください。

## 別の Windows マシンで実行する

Windows インストーラーは Node.js 22 と Python 3.12 を内包していますが、ローカルモデルサーバー
（Ollama など）は含みません。モデルの提供元（推奨は Ollama、別のローカルサーバー、またはクラウドプロバイダー）
は、対象のマシンで別途設定する必要があります。開発者向けの方法（`npm run dev` / `node build`）では Node は今も手動でインストールします。対象マシンへのインストール後、`npm run doctor`
（開発者向けの方法）またはアプリ自身の「ローカルサーバー … 動作していません」/
「セットアップが完了していません」バナー（デスクトップパッケージ）が、足りないものを教えてくれます。

| コンポーネント | 必須か | 誰がインストールするか |
|---|---|---|
| Node.js 22.x（`>=22 <23`） | はい | Windows デスクトップパッケージには内蔵されており（アプリは常にそれを使います）、開発者向けの方法では手動: https://nodejs.org |
| Ollama + `qwen3:8b` + `bge-m3` | **推奨**（別のローカルサーバーやクラウドプロバイダーでも可。埋め込みがない場合はキーワード検索のみ） | 手動: https://ollama.com、またはセットアップウィザード |
| WebView2 Runtime | はい（デスクトップパッケージのみ） | 自動: NSIS インストーラーが、なければ内蔵の小さなブートストラッパー（`embedBootstrapper`）でインストールします。インストール中にインターネットが必要です |
| Visual C++ Redistributable | 技術的にはい | 通常 Windows 10/11 にはすでに入っています。なければ手動 |
| Python 3.12+（安定版） | いいえ。PDF/ドキュメント/YouTube のインポートにのみ必要 | Windows デスクトップパッケージには内蔵（3.12）。docling 入りのシステム Python または `PYTHON_BIN` があればそちらが優先されます。その他の方法: 手動 https://python.org |
| `markitdown` とその他の軽量パッケージ（`pip install -r ingest/requirements.txt`） | いいえ。PDF/ドキュメント/YouTube のインポートにのみ必要 | デスクトップパッケージではアプリ自身の「今すぐインストール」バナー（内蔵 Python から `python-venv` を作成。インターネットが必要）、その他の方法: 手動 |
| docling（重い PDF/OCR） | いいえ。任意 | 手動（`pip install docling`） |
| pandoc | いいえ。`.tex` 変換にのみ必要 | 手動 |

注意点:
- **ARM64 の Windows はサポートされていません。** `sqlite-vec` の Windows 向けビルド済み
  パッケージは `win32-x64` のみです。ARM ベースの Windows マシン
  （Snapdragon など）では、`npm install` が sqlite-vec で失敗します。
- **間違った Node バージョンでも、インストールは黙って成功し、実行時に失敗します。**
  `engine-strict` がオフなので、`npm install` は Node 20/24 でも完了しますが、
  `better-sqlite3` のネイティブバイナリは Node 22 の ABI 向けにビルドされているため、エラーは
  最初のデータベースアクセスで初めて出ます。`npm run doctor` はこれをインストール
  直後に検出します。
- **`secrets.json` は移行できません。** デスクトップパッケージでは
  AES-256-GCM で暗号化され、暗号鍵は OS のストア（Windows
  DPAPI、macOS キーチェーン、Linux Secret Service）にあり、ユーザー/マシンの
  プロファイルに紐づいています。別のマシン/ユーザーにコピーした `secrets.json` は
  復号できず、「キーなし」のように扱われます。クラウドプロバイダー（DeepSeek/Gemini/Groq/...）の API キーは
  対象マシンの 設定 → プロバイダー で入力し直してください。
- **ボールトの内容は手動で移します。** `data/vaults.json` は自身のパスを読み込みの
  たびに再導出するので持ち運べますが、各ボールトの実際の内容
  （`data/vaults/<id>/library/`、`index.db`、`study.db`）は別にコピーするか、
  対象マシンでインポート + `npm run index` を行って
  再作成する必要があります。
- **Windows デスクトップパッケージで PDF/ドキュメント/YouTube のインポートに足りないのは、軽量
  パッケージだけです。** `ingest/` フォルダと Python 3.12 はインストールパッケージに含まれます
  （`scripts/stage-server.mjs`、`scripts/fetch-python-runtime.mjs` を参照）。`markitdown`
  とその他のパッケージはパッケージに含まれておらず、初回利用時にアプリが `/api/system/python`
  経由でこれを検知し、オレンジ色のバナーの「今すぐインストール」ボタンで
  `pip install -r ingest/requirements.txt` をデータフォルダの `python-venv` に
  代わりにインストールします。docling 入りの Python がすでにあれば、それが優先されます。

## Linux と macOS（新機能、ベータ）

> **警告:** Linux と macOS のパッケージは新しいものです。CI ではビルドされていますが、**まだ実際の
> Linux/macOS マシンでは試されていません**。また macOS パッケージは**署名も
> 公証（notarize）もされていません**。Windows ほど成熟していません。問題が
> あれば、データフォルダの `launch.log`（下記）を添えて報告してください。macOS
> 向けの手順付きテスト一覧: [`docs/macos-deneme-listesi.md`](../docs/macos-deneme-listesi.md)（トルコ語）。

サポートされるパッケージ形式（CI でビルドされます。「デスクトップ（Tauri）」を参照）:

| プラットフォーム | パッケージ | 備考 |
|---|---|---|
| Linux x64 | `.deb`、`.AppImage` | `.deb` は次のパッケージに依存します: `libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`、`libsecret-1-0`（`src-tauri/tauri.linux.conf.json`） |
| macOS（Apple Silicon と Intel） | `vault-chat.app` + `.dmg`、署名なし | macOS 11.0 以上（`minimumSystemVersion`） |

Linux でソースからビルドするには（CI の Ubuntu 22.04 パッケージ一覧）:
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libsecret-1-dev libdbus-1-dev
npm install && npm run desktop:build
```

| コンポーネント | 必須か | Linux / macOS でのインストール方法 |
|---|---|---|
| Node.js 22.x（`>=22 <23`） | はい。パッケージには内蔵されていません | https://nodejs.org、Homebrew（`brew install node@22`）、nvm/fnm/Volta、またはディストリビューションのパッケージマネージャー |
| モデルの提供元（Ollama を推奨。別のローカルサーバーやクラウドプロバイダーでも可） | チャットにはどれか 1 つ | 手動: https://ollama.com |
| Python **3.10+** | いいえ。PDF/ドキュメント/YouTube のインポートにのみ必要 | macOS: `brew install python@3.12`、Linux: ディストリビューションのパッケージマネージャー（Debian/Ubuntu では `sudo apt install python3 python3-venv`） |
| pandoc | いいえ。`.tex` 変換にのみ必要 | Homebrew またはディストリビューションのパッケージマネージャー |

知っておくべきこと:
- **Node はどう見つけるか？** GUI から起動したアプリはシェルの PATH を
  継承しません。そのため `node` はまず PATH（ログインシェルの PATH を含む）で、
  次に既知の場所で探されます: `/usr/local/bin`、`/usr/bin`、
  `/opt/homebrew/bin`、`~/.volta/bin`、nvm（`~/.nvm/versions/node`）、fnm の
  バージョンフォルダ（`src-tauri/src/platform.rs`、`src-tauri/src/lib.rs` の
  `resolve_node_binary`）。見つかった Node のメジャーバージョンが 22 でない場合、アプリは
  起動時に警告します。
- **Python の「今すぐインストール」** は macOS/Linux ではシステムの Python に `pip install`
  しません（Debian/Homebrew の「externally managed」保護に引っかかるため）。代わりにデータ
  フォルダにアプリ専用の仮想環境（`python-venv`）を作成し、パッケージを
  そこにインストールします（`src/routes/api/system/python/+server.ts`、
  `src/lib/server/python-bin.ts`）。Debian/Ubuntu で `python3-venv` パッケージが
  ない場合は環境を作成できず、アプリがその旨を伝えます。macOS でコマンドライン
  ツール（CLT）がインストールされていない場合、`/usr/bin/python3` のプレースホルダーは
  スキップされます（インストールのダイアログが出ないようにするためです）。`PYTHON_BIN` 環境変数で特定の
  インタープリターを指定することもできます。
- **winget は Windows のみ。** macOS/Linux ではアプリはパッケージマネージャーを
  自分では実行しません。Homebrew / ディストリビューションのパッケージマネージャーのコマンドは
  自分で実行します。
- **API キー** は OS のストアで保護されます。macOS ではキーチェーン
  （サービス `app.vaultchat.desktop`、アカウント `secrets-key`。
  初回起動時に許可を尋ねられることがあります。「常に許可」）、Linux では
  Secret Service（GNOME Keyring / KWallet）です。Linux でこのサービスがない場合、キーは
  暗号化されずに（`0600` 権限のファイルに）保存され、設定 → プロバイダー に
  警告が表示されます。GNOME Keyring または KWallet をインストールしてアプリを再起動すると
  暗号化されます。キーはあるのに読み取れない（「ロック」されている）場合は何も
  再生成されません。**設定 → プロバイダー →「保存済みの API キーをリセット」** は
  古いファイルを `secrets.json.locked-<date>` としてバックアップし、
  アプリを再起動します。詳細: `SECURITY.md`。
- **バックグラウンドプロセス:** Linux では、アプリがクラッシュしても OS カーネルが Node
  サーバーに `SIGTERM` を送ります（`PR_SET_PDEATHSIG`）。macOS にはそのような
  保証はありません。通常終了（Cmd+Q）の場合にのみサーバープロセスが片付けられ、
  アプリがクラッシュしたり強制終了されたりすると、`node` プロセスが残ることがあります。
- **ログファイル:** 起動の問題には `launch.log` を使います。macOS:
  `~/Library/Application Support/app.vaultchat.desktop/launch.log`、Linux:
  `~/.local/share/app.vaultchat.desktop/launch.log`。

### macOS: 署名のないアプリを開く（Gatekeeper）

アプリは Apple による署名も公証も受けていないため、
macOS は初回起動時にブロックします（「開発元を検証できません」または「壊れている」）。
`.dmg` から `vault-chat` を **Applications** にドラッグし、Finder でアプリを
**右クリック → 開く → 開く** とします。それでも開かない場合は、隔離属性を削除します。

```bash
xattr -dr com.apple.quarantine /Applications/vault-chat.app
```

## MCP サーバー

ボールト内のノートを Claude Code/Desktop などの MCP クライアントに公開する、ローカルの
サーバーです。別パッケージやセットアップは不要で、`mcp/` はこのリポジトリ内の
`indexer/` と同じ構成で存在します。

**パッケージ版のデスクトップアプリでは**、サーバーは単一ファイルのバンドルとして付属します
（`dist-server/mcp/vault-chat-mcp.mjs`。`scripts/build-mcp.mjs` が生成し、`npm run stage:server`
の中で自動実行されます）。リポジトリ、`tsx`、その他のセットアップは不要で、
システムの Node 22 があれば十分です。**設定 → MCP クライアントに接続** カードが、このファイルを
指す設定をそのまま提供します。`node <install>/_up_/dist-server/mcp/vault-chat-mcp.mjs --print-config`（Windows ではインストールフォルダは `%LOCALAPPDATA%\vault-chat`）
でも同じブロックを出力できます。`DATA_DIR` を指定しない場合は、インストール済みアプリのデータフォルダ
（`%APPDATA%\app.vaultchat.desktop`、macOS では `~/Library/Application Support/app.vaultchat.desktop`、
Linux では `$XDG_DATA_HOME` または `~/.local/share` の下の同名フォルダ）が使われます。ソースコード
から実行する場合は、`mcp/launch.mjs` を使う方法がそのまま有効です。バンドルを単独で生成するには: `npm run build:mcp`。

**ツール:**

- `list_vaults`: MCP に公開されているボールトを一覧表示します（ボールトごとのオン/オフ: **設定 → ボールト**）。
- `search_library`: ボールトを検索します。既定（`mode: "auto"`）はベクトル検索で、埋め込みがない場合や結果が出ない場合はキーワード（FTS5）にフォールバックします。`mode`: `vector`、`keyword`（FTS5 のみ。埋め込み不要）、または `hybrid`（ベクトル + FTS5、reciprocal rank fusion）。`domain`/`level` フィルターを受け付けます。
- `get_note`: ノートを読み取ります。`heading` はその見出しのセクションだけを、`max_chars`/`offset` はページ単位の読み取りを返します（`hash` は常にファイル全体のものです）。
- `list_domains`: ボールト内の domain 値を、ノート数と最終更新時刻とともに一覧表示します。
- `list_sources`: ボールト内の出典を、domain と level の値とともに一覧表示します。
- `create_vault`: 新しいボールトを作成します。
- `import_source`: ローカルファイルまたは URL を、インポート対象として**保留中**に追加します。
- `list_pending_imports`: 保留中のインポートの状態を表示します。
- `edit_note`: 既存のノートを編集します（`get_note` の `hash` の値が `expected_hash` として必要です。frontmatter は変更されず、以前のバージョンはリビジョンとして保存されます）。**既定ではオフです**: **設定** にある開発者向けスイッチでのみオンにでき、エージェントはオンにできません。オフの間に呼び出すと `MCP_EDIT_NOTE_DISABLED` エラーになります。

書き込み系のツールはアプリの API 経由で動作するため、**アプリが
起動している**必要があります（アプリは `DATA_DIR` 内に `mcp-endpoint.json` を書き込みます）。
インポートされた出典は、アプリで承認するまでライブラリには入りません。エージェントは
自分で承認することも、設定を変更することもできません。ローカルファイルは
**設定** で許可したフォルダからのみ読み取られ、URL は通常のウェブ
インポートを経由します。希望すれば、ボールトごとに **MCP のインポートを
自動承認する** 設定をオンにできます。`off`（既定。すべて自分で
承認します）、`clean`（警告がなく、レビューのフラグがなく、重複でないものだけ）、
または `all`（成功したすべてのインポート）です。`all` はエージェントが持ち込んだ内容を、あなたが
確認する前に検索へ含めてしまうため、プロンプトインジェクションのリスクを考慮してください。

**1 コマンドでのセットアップ。** ソースコードから（`npm install` の後）、次のコマンドがすべてを行います。

```bash
npx vault-chat-mcp setup      # or: npm run mcp:setup
```

Windows PowerShell でスクリプトの実行が無効になっている場合（`npx.ps1 cannot be loaded`）は、`npx.cmd vault-chat-mcp setup` または `npm.cmd run mcp:setup` と入力します。

1. **データフォルダを選びます:** `--data-dir` > `DATA_DIR` 環境変数（`.env` を含む）> インストール済みのデスクトップアプリのフォルダ（あれば）> リポジトリの `data/` フォルダ。
2. **見つかった MCP クライアントに登録します:** Claude Desktop（Microsoft Store 版の仮想設定ファイルを含む）、Claude Code（`claude` が PATH にある場合）、LM Studio（`~/.lmstudio` がある場合）。ファイルのバックアップを `<file>.bak-YYYYMMDD-HHMMSS` として作成し、他のキーや他のサーバーには触れず、不正な JSON は決して上書きしません。Claude Desktop は完全に終了してから再起動する必要があります。Jan やその他のクライアント向けには、最後に設定ブロックが出力されます。
3. **「サンプルボールト」を作成します:** 5 つの短い講義ノート（トルコ語と英語）をコピーし、MCP に公開してインデックスします。すぐに `search_library` / `get_note` を試せます。`vaults.json` はアプリが所有するため、アプリが起動している間はこの手順はスキップされます。アプリを閉じてからコマンドを再実行してください。埋め込みサーバー（Ollama）がない場合、インデックスはキーワード（FTS5）検索のみで構築されます。設定したプロバイダーにアクセスできない場合はインデックス作成がエラーになり、画面に表示されるヒントに従って `npm run index -- --vault ornek-kasa` を実行します。

オプション: `--client claude-desktop,claude-code,lm-studio`（これらだけを登録します。フォルダがなければ作成します）、`--data-dir <folder>`、`--no-sample`（サンプルボールトなし）、`--dry-run`（何も書き込まずに実行内容を表示します）。`npx vault-chat-mcp config` は設定ブロックのみを出力します。コマンドは再実行できます。最新の登録と既存のサンプルボールトはそのまま残されます。

手動でセットアップしたい場合:

**接続。** インストール済みのデスクトップアプリのデータは `%APPDATA%\Roaming\app.vaultchat.desktop\`
の下にあります（「デスクトップ（Tauri）」を参照）。`DATA_DIR` はこのフォルダを指す必要があります。
ソースコードから実行している場合の既定は、リポジトリの `data/` フォルダです。Claude
Code の場合（`--scope user` を付けないと、登録はコマンドを実行したディレクトリにのみ
紐づきます）:

```bash
claude mcp add --scope user vault-chat -- node "<this repo>\mcp\launch.mjs"
```

Claude Desktop 用に `%APPDATA%\Claude\claude_desktop_config.json` へ追加するブロックを、
**絶対パス**の `DATA_DIR` と `node` のパスですぐに使える形で生成するには:

```bash
npm run mcp:config
```

出力は次の形式です。インストール済みアプリのデータを読み込ませるには、`DATA_DIR` を
上記の AppData フォルダに置き換えてください。

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

`"command"` は `node`（または `npm run mcp:config` が出力する絶対パスの `node`）
である必要があり、`"npx"`/`"tsx"` ではいけません。Windows ではどちらも `.cmd` の shim であり、
シェルなしで spawn するクライアントでは `ENOENT` になります。

検証:

```bash
npm run mcp:smoke   # tests the tools in a single process, without touching a real model server
```

サーバーが起動している間の診断には、stderr の 1 行で十分です: `DATA_DIR=... vaults=N`。
Claude Desktop では、この行は `%APPDATA%\Claude\logs\mcp-server-vault-chat.log` に出力されます。

## プロバイダーとモデルの機能

チャットにどのプロバイダーを使うかは **設定 → プロバイダー**
（または初回セットアップのウィザード）で選びます。Ollama は選択肢の 1 つにすぎません。モデルの
ツール呼び出し（tools）と推論（reasoning）の機能は、モデル名
（Ollama の `qwen3:8b`、llama.cpp の `Qwen3-8B-Q4_K_M.gguf`、LM Studio/vLLM の
`qwen/qwen3-8b` といった表記は同じファミリーに対応づけられます）から推定され、サーバーの
種類によらず同じテーブルから得られます。推定が間違っている場合は **設定 → プロバイダー →
「モデルリストを管理」** セクションに、各モデルの **ツール** と **推論**
のスイッチがあります。これらはテーブルの既定値を表示し、
変更するとモデル固有の上書き（`providers.json` の
`modelCaps`）が書き込まれます。ローカル（`local`）と指定された OpenAI 互換サーバー（llama.cpp、
LM Studio、vLLM）では、思考をオフにしたとき、推論するモデルに対して
リクエストに `chat_template_kwargs: { enable_thinking: false }` が追加されます（qwen3 テンプレート）。
クラウドプロバイダーには決して送信されません。

## 小さな GPU 向けのパフォーマンス設定

> このセクションは、モデルサーバーとして **Ollama** を使っている場合にのみ該当します
> （`ollama ps`、`OLLAMA_*` 変数、Modelfile）。LM Studio や llama.cpp など
> 他のサーバーでは、コンテキストウィンドウと GPU レイヤーの設定はそのサーバー自身の
> UI から行います。

ローカルモデルが遅い場合は、まず次を見てください。モデルがロードされている状態で `ollama ps` の出力の
`PROCESSOR` 列が `100% GPU` か、それとも `18%/82% CPU/GPU` のような分割か。
分割されている場合、モデルは VRAM に収まらず、レイヤーの一部が CPU で動いています。速度は
主に CPU に残ったレイヤーの割合で決まります。以下の設定はこの割合を
下げます。これらは**品質を変えません**（同じ重み、同じ計算）。変わるのは
レイヤーがどこで動くかだけです。

> すべての数値は**1 台のマシン**で測定したものです（RTX 4050 Laptop 6 GB、`qwen3:8b`）。他のハードウェアでは
> 順位は同じでも数値は異なります。モデルがすでに完全に GPU に収まる場合
> （`100% GPU`、通常は 12 GB 以上のカード）、これらの設定は効果がありません。

### 1. Ollama 側（Ollama の環境に書き込む）

ユーザーレベルの環境変数を 3 つ設定し、その後タスクバーから Ollama を終了して再度開きます。

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION', '1',    'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE',   'q8_0', 'User')
[Environment]::SetEnvironmentVariable('LLAMA_ARG_FIT_TARGET',   '256',  'User')
```

- `OLLAMA_FLASH_ATTENTION=1` と `OLLAMA_KV_CACHE_TYPE=q8_0`: KV キャッシュを約半分に
  減らし、VRAM にモデルのレイヤー用の余地を作ります。
- `LLAMA_ARG_FIT_TARGET=256`（MiB）: Ollama のエンジン（`llama-server`）は既定で
  **1024 MiB** の VRAM を空けておこうとします。この値はその余裕を小さくします。測定された効果は、同じ
  モデルでのレイヤー数の増加と、このマシンの `qwen3:8b` Q4_K_M で約 50% 速い
  生成です。余裕を小さくすると、VRAM を他のプログラムと共有している場合にメモリ不足の
  リスクが高まります。問題が出たら値を上げるか、変数を削除してください。

**知っておくべきこと**

- `LLAMA_ARG_FIT_TARGET` は Ollama の**文書化された設定ではありません**。Ollama がエンジンを子プロセスとして
  起動するときに環境を継承させるため機能しています。Ollama のアップデートで
  変わる可能性があります。アップデート後は `ollama ps` をもう一度確認してください。
- この変数はマシン上の**llama.cpp ベースのすべてのプログラム**に影響します。
- 検証: モデルをロードして `ollama ps` を確認します。さらに Ollama のサーバーログ
  （`%LOCALAPPDATA%\Ollama\server.log`）に `free memory target of 256 MiB` の行が表示されるはずです。
- 元に戻す: 各変数について `[Environment]::SetEnvironmentVariable('<NAME>', $null, 'User')`
  を実行し、その後 Ollama を再起動します。

### 2. アプリ側

| 設定 | 既定値 | 内容 |
|---|---|---|
| `OLLAMA_SERVE_CTX` | モデルテーブル（`qwen3`: 8192） | Ollama に要求するコンテキストウィンドウ（`num_ctx`）。すべてのモデルが対象 |
| `CHAT_RETRIEVAL_K` | 6（1–50） | チャットで質問ごとに取得する出典チャンクの数 |

- **どこで指定するか:** `.env` は **`npm run dev`** にのみ有効です（`.env.example` を参照）。
  **`node build`（「常用する場合」）とパッケージ版（Tauri）のアプリは `.env` を読み込みません。** `node build`
  の場合は、そのコマンドを実行するシェルで設定を渡します（`OLLAMA_SERVE_CTX=8192 node build`）。パッケージ版
  アプリの場合は**OS の環境変数**として設定し（上記と同じ `'User'` レベル）、
  アプリを閉じてから開き直します。サーバープロセスはアプリから環境を継承します。
- **`OLLAMA_SERVE_CTX` を下げるのは危険な場合があります。** ウィンドウが小さくなると、より多くのレイヤーが
  GPU に残りますが、プロンプト（k=6 でも約 4k トークンになることがあります）が収まらない場合、Ollama はコンテキストを
  シフトし、**先頭の 4 トークンしか保持しません**。システムルールは黙って失われます。既定の 8192 を下回る
  前に、`data/app-log.jsonl` の `llm_timing` レコードで `nearCtxLimit: true` に
  なっていないか確認してください。
- **VRAM に余裕がある場合は**、両方を一緒に上げます（例: `OLLAMA_SERVE_CTX=16384`、
  `CHAT_RETRIEVAL_K=12`）。より多くの出典を使って回答します。`k` が回答の品質に与える影響は
  測定できず、判断の問題です。何か悪化したら元の値に戻してください。

### 3. より小さい量子化（任意）

モデルが完全に GPU に収まらない場合、より小さい量子化（例: `IQ4_XS`、約 4.6 GB。`Q4_K_M` は
約 5.0 GB）にすると、より多くのレイヤーを GPU に置けます。公開されている測定（別の
公開元の独自量子化によるもので、傾向を示します）によると、`IQ4_XS` の乖離は `Q4_K_M` に近く、
3-bit の量子化（`IQ3_M`、`Q3_K_M`）では乖離が約 2〜3 倍に増えます。ローカルでは品質の差を
識別できるだけの強力なテストは行っていません。実際の質問を使って、自分で判断してください。

**生の GGUF を直接 pull する。** 公式の `qwen3:8b` の `tools` と `thinking` の機能はモデルの
**テンプレート**に由来します。別の出典から生の GGUF を pull するとこれらが失われ、アプリの
スキルツールや思考モードが動作しません。正しい方法は、公式モデルの Modelfile を取得して、`FROM`
行だけを変更することです。

```powershell
cmd /c "ollama show qwen3:8b --modelfile > Modelfile"
# In the Modelfile, replace the FROM line with the path of the .gguf file you downloaded (with forward slashes),
# do not touch any other line. Then:
ollama create qwen3:8b-iq4xs -f Modelfile
ollama show qwen3:8b-iq4xs      # tools and thinking should appear under Capabilities
```

（`cmd /c` は意図的です。Windows PowerShell 5.1 の `>` 演算子はファイルを UTF-16 で書き込み、Ollama は
それを読み取れないためです。）

ダウンロードしたファイルの SHA256 を、公開元のページに記載された値と比較してください。

### 4. 計測する

各チャット呼び出しは `data/app-log.jsonl` に `llm_timing` レコードを書き込みます: `promptTokens`、
`completionTokens`、`promptMs`、`completionMs`、`loadMs`、`numCtx`、`nearCtxLimit`。数値のみで、
テキストの内容は含まれません。

## トラブルシューティング

- **ローカルモデルが遅い** → 上の「小さな GPU 向けのパフォーマンス設定」を参照してください。
- **「ローカルサーバー … 動作していません」の警告 /「… プロバイダーに到達できません」** → チャットが
  使うローカルサーバー（Ollama、LM Studio、llama.cpp など）は起動していますか？ Ollama なら
  `ollama serve` を実行します。アドレスが間違っている場合は、設定 → プロバイダー で該当プロバイダーの
  `baseUrl` を修正してください（`OLLAMA_URL` はもう読み込まれません）。
- **「セットアップが完了していません」の警告 / チャットが応答しない** → チャットチェーンが
  空です。セットアップウィザード（`/setup/local-server`）を実行するか、設定 →
  プロバイダー でプロバイダーを追加して有効にし、既定のモデルを選んでください。
- **モデルリストが空 / ModelPicker がエラーになる** → サーバーにロード済みのモデルは
  ありますか？（Ollama なら `ollama pull qwen3:8b`。LM Studio/llama.cpp ではモデルをロードしてください。）
- **検索結果が弱い / キーワードしか動作していない** → 埋め込みが
  設定されていない可能性があります（意味検索がオフ）。設定 → プロバイダー で
  埋め込みモデルを選び、その後ボールトを再インデックスしてください。
- **出典が見つからない / 回答が的外れ** → `npm run index` は実行しましたか？ インデックスは最新ですか？
  複数のボールトを使っている場合は
  さらに確認してください。正しいボールトがアクティブか（設定 → ボールト）、`npm run index` が
  アクティブなボールトをインデックスしたのか、それとも別のボールトをインデックスしたのか
  （`--vault <id>` に間違ったボールトを渡している可能性があります）。
- **数式が表示されない / `f(x)` のような生のコードが表示される** →
  `src/lib/markdown.ts` のパイプラインを `f(x)` のようなサンプル文字列で試してください。
- **MCP クライアントが「connected」と表示しない / すぐ終了する** → `"command"`
  の値は本当に `"node"` ですか（上の注記を参照）？ `npm run mcp:smoke`
  は問題なく通りますか？ Claude Desktop では `%APPDATA%\Claude\logs\mcp-server-vault-chat.log` にある
  stderr の 1 行を確認してください。`DATA_DIR` は想定した場所を指していますか？
- **MCP の `search_library` が結果を返さないが、アプリ自身のチャットは
  見つけられる** → おそらく異なる `DATA_DIR`/ボールトを読んでいます。`list_vaults`
  ツールが返す `indexed`/`noteCount` フィールドを確認してください。
- **クラウドプロバイダー（DeepSeek/OpenRouter/Groq/Google AI Studio/Mistral）の
  モデルリストや接続テストがランダムに失敗するが、ブラウザでは
  その API アドレスが問題なく開く** → `data/app-log.jsonl` でそのプロバイダーについて
  `"listModels: ... fetch failed (SELF_SIGNED_CERT_IN_CHAIN)"` のような
  行を探してください。これは vault-chat のコードのバグではありません。ウイルス対策ソフト
  （Kaspersky、ESET、Avast/AVG、Bitdefender、Norton など、いずれにも「暗号化された
  接続をスキャン」する機能があります）が、送信される HTTPS 接続に自社のルート
  証明書で割り込んで検査しているものの、Node.js は（ブラウザとは
  異なり）Windows の証明書ストアを使わないため、この証明書を信頼していない
  ということです。解決策: `certmgr.msc` → *Trusted Root
  Certification Authorities* からウイルス対策ソフトのルート証明書を
  Base-64 の `.cer`/`.pem` としてエクスポートし、`NODE_EXTRA_CA_CERTS`
  環境変数をそのファイルのパスに設定して、`npm run dev`（またはデスクトップ
  アプリ）を再起動します。証明書の検証を緩めること
  （`NODE_TLS_REJECT_UNAUTHORIZED=0`）は**決して**解決策では
  ありません。本物の中間者攻撃に対する保護も取り除いてしまうからです。
