<p align="center">
  <img src="../static/logo.png" alt="vault-chat 标志" width="140" />
</p>

<h1 align="center">Vault Chat</h1>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <b>简体中文</b> · <a href="README.de.md">Deutsch</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <b>在本地运行、能与你自己的笔记对话的学习助手。</b><br />
  导入你的文档，提问时它会附上来源作答；还能基于同样的来源生成测验、卡片、报告和幻灯片。
</p>

<p align="center">
  <img alt="许可证: Apache-2.0" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-Apache--2.0-blue" />
  <img alt="版本" src="https://img.shields.io/github/v/tag/KodAlp/vault-chat-beta?sort=semver&label=%E7%89%88%E6%9C%AC&color=informational" />
  <img alt="平台" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" />
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" />
  <img alt="SvelteKit" src="https://img.shields.io/badge/SvelteKit-FF3E00?logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-24C8DB?logo=tauri&logoColor=white" />
  <img alt="本地优先" src="https://img.shields.io/badge/%E6%95%B0%E6%8D%AE-%E7%95%99%E5%9C%A8%E6%9C%AC%E5%9C%B0-success" />
</p>

<p align="center">
  <img src="../docs/assets/demo-chat.gif" alt="向知识库提问；本地模型借助笔记中的代码和公式，并附上来源标签，解释二分查找" width="860" />
</p>

## 功能

- **基于来源的对话（RAG）。** 回答只来自你知识库（vault）中的笔记；每条回答下方都会显示用到了哪篇笔记的哪个章节。公式用 KaTeX 渲染，代码带语法高亮。
- **导入各类来源。** PDF、DOCX、PPTX、XLSX、HTML、EPUB、TeX 和 Markdown 文件，以及链接和 Obsidian/Logseq/Joplin/Zettlr 文件夹，都会转换为 Markdown 并加入资料库。对于公式密集的 PDF，使用以 docling 和 MinerU 作为后备的处理流程。
- **学习工具。** 基于同样的来源生成单选测验、SM-2 间隔重复卡片、概念图、带引用的报告和幻灯片；并按主题跟踪你的进度。
- **多个知识库。** 每个知识库都有自己的资料库和搜索索引，互不干扰。
- **本地优先。** 默认使用 Ollama 或任何兼容 OpenAI 的本地服务器（LM Studio、llama.cpp、vLLM、Jan）。云服务商是可选的，默认关闭，并且每次对话都需要单独确认。
- **MCP 服务器。** Claude Code/Desktop 等 MCP 客户端可以在你的知识库中搜索、读取笔记并导入来源；导入的内容在你于应用中确认后（或你为该知识库开启自动确认后）才会进入资料库。
- **23 种界面语言**、明暗主题和暖色调主题，可用桌面版（Tauri）或在浏览器中使用。

## 截图

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/screenshots/home-dark.webp" />
        <img src="../docs/assets/screenshots/home-light.webp" alt="知识库主页：提问框和历史对话" />
      </picture>
      <p align="center"><sub>知识库主页（浅色与深色主题）</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/chat-code.webp" alt="包含代码块和公式、带来源标签的回答" />
      <p align="center"><sub>带来源标签的回答：代码与公式并存</sub></p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="../docs/assets/screenshots/study-panel.webp" alt="学习面板：测验、卡片、报告、导图、幻灯片、进度" />
      <p align="center"><sub>学习面板：测验、卡片、报告、导图、幻灯片</sub></p>
    </td>
    <td width="50%">
      <img src="../docs/assets/screenshots/source-viewer.webp" alt="应用内来源查看器，公式由 KaTeX 渲染" />
      <p align="center"><sub>来源查看器：编辑与历史版本</sub></p>
    </td>
  </tr>
</table>

<sub>截图取自由示例笔记组成的演示知识库，使用本地 <code>qwen3:8b</code> 模型，界面语言为英文。</sub>

## 工作原理

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../docs/assets/architecture-dark.webp" />
  <img src="../docs/assets/architecture-light.webp" alt="Vault Chat 架构：来源、转换器、知识库、应用、模型服务商和客户端" />
</picture>

一切都运行在 `localhost` 上的单个 Node 进程中，不需要 Docker 或外部服务器。你的笔记、索引和对话历史都保留在你自己的机器上。

## 快速开始

```bash
git clone https://github.com/KodAlp/vault-chat-beta.git
cd vault-chat-beta
npm install
npm run dev
```

然后打开 `http://localhost:5173`。首次启动时的安装向导会找到本地模型服务器，并帮你选择对话模型和 embedding 模型。前置条件（Node.js 22 和一个模型来源）、桌面版、MCP 配置和故障排查见下方的详细章节。

如需参与贡献，请见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)；隐私、安全和使用条款见 [`PRIVACY.md`](../PRIVACY.md)、[`SECURITY.md`](../SECURITY.md) 和 [`TERMS.md`](../TERMS.md)。本项目采用 Apache 2.0 许可证（[`LICENSE`](../LICENSE)、[`NOTICE`](../NOTICE)）。

---

# 详细安装

一个本地运行、无需 Docker 的 SvelteKit 学习/对话应用。它对你自己资料库中的
笔记和文档做 RAG；可以与本地模型服务器对话（推荐 Ollama，但不是必需的 ——
LM Studio、llama.cpp、vLLM、Jan 等任何兼容 OpenAI 的服务器也可以），
也可以使用可选的云服务商。单个 Node 进程，
绑定到 `localhost`。

## 前置条件

1. **Node.js 22**（`>=22 <23`；20 和 24 都不能用 —— 用 `node --version` 查看已安装的版本）。Windows 桌面版自带 Node，因此在那里无需另行安装。
2. **一个对话模型来源** —— **推荐 Ollama**（https://ollama.com），但
   不是必需的。以下任意一种即可：
   - Ollama，
   - 其他兼容 OpenAI 的本地服务器：llama.cpp、LM Studio、vLLM、Jan、
     LocalAI，
   - 云服务商（DeepSeek、Google AI Studio、OpenRouter 等；可选，
     默认关闭，见 `PRIVACY.md`）。

   如果一个都没装，对话将无法使用：应用会显示"Kurulum tamamlanmadı"
   （安装未完成）警告。
3. **Embedding（搜索）模型 —— 可选。** 任何支持 embedding 的
   服务商都可以；如果完全不选，搜索将只使用关键词（FTS），
   语义搜索处于关闭状态。如果你使用 Ollama，推荐的模型是
   `bge-m3` —— 而不是 `nomic-embed-text`（`src/lib/server/embed-config.ts` 中的
   `EMBED_MODEL`；它在土耳其语查询上的结果有可测量的提升，
   理由见 embed-config.ts 自己的注释）。如果你配置了某个 embedding 模型
   却没有在服务器上拉取它，`npm run index` 会报 "model not found" 而失败。

**主要途径：安装向导。** 它会在首次启动时（桌面版）或在
浏览器中通过 `/setup/local-server` 打开，也可以通过
**Ayarlar → Sağlayıcılar** 页面中的"重新运行安装向导"链接打开，分三
步进行：(1) 查找/安装本地服务器，(2) 选择对话模型，(3)
选择 embedding 模型，**或选择"仅关键词搜索"**。如果你想
手动操作，Ollama 的命令如下：
```bash
ollama serve
ollama pull qwen3:8b      # recommended chat model
ollama pull bge-m3        # recommended embedding model (optional)
# optional, for deep sessions:
ollama pull qwen3:30b-a3b
```

要用一条命令验证这些项目，而不是手动逐项检查：
```bash
npm run doctor
```

## 安装

```bash
cd vault-chat-beta
npm install
```

`.env` 文件已经从 `.env.example` 创建好了。必要时打开并检查：

```
CHATS_DB_PATH=./data/chats.db
PUBLIC_VAULT_NAME="My Notes"  # display name of the "default" vault on first launch
```

`OLLAMA_URL` 已不再被读取：Ollama（以及其他服务器）的地址
通过 Ayarlar → Sağlayıcılar 设置，即 `providers.json` 中的
`baseUrl` 字段。

`PUBLIC_VAULT_NAME` 只在首次创建 "default" 知识库时
（见 `migrateVaults.ts`）被读取，作为默认显示名称 —— 之后的
运行中不起作用。来源始终在应用自己的
查看器中打开。来自 Obsidian、Logseq、Joplin、Zettlr 等笔记
应用的 Markdown 文件夹仅仅是导入来源
（**Ayarlar → Kütüphane**）。

`data/providers.json` 是随本仓库一起提供的**种子**文件 —— 全新
安装会发现部分云服务商（DeepSeek、Google AI Studio）
被设为 `enabled: true`。要真正使用它们，仍然需要 (a) 在 `data/secrets.json` 中为
该服务商填入 API 密钥（Ayarlar → Sağlayıcılar），并且 (b) 在每次对话中
单独勾选确认框（见 `PRIVACY.md`）—— 仅仅 `enabled: true` 不会发送任何
数据。如果你不想在界面中看到云服务商这个选项，
可以在你自己的 `data/providers.json` 中把相应条目
设为 `enabled: false`。打包的桌面版则不使用这个文件，而是使用
干净的默认文件 `data/providers.default.json` 作为种子：
所有云服务商关闭、任务链为空、没有 embedding
（仅关键词搜索）—— 这些由安装向导来填写。

## 知识库

应用可以保存**多个知识库（vault）**，而不是只有一个资料库 —— 每个知识库有
自己的来源文件夹和搜索索引，彼此完全隔离
（`data/vaults/<id>/library/`、`data/vaults/<id>/index.db`）。对话历史保存在
一个全局数据库中（`data/chats.db`），每个对话会记录
它属于哪个知识库。

- 创建/删除/重命名知识库，请到 **Ayarlar → Vault'lar**。
- 同一时间只有一个知识库处于"活动"状态 —— 对话界面和索引器始终
  作用于活动知识库。
- **如果你是从旧的（多知识库之前的）安装升级而来**，不需要做任何事 ——
  服务器首次启动时发现 `data/vaults.json` 不存在，就会把
  `LIBRARY_PATH`/`INDEX_DB_PATH`/`STUDY_DB_PATH` 的内容自动迁移到
  `data/vaults/default/` 下，并注册一个名为 "default" 的知识库；
  旧的对话都会关联到这个知识库。**`VAULT_PATH` 是有意不迁移的**
  —— 在旧架构中，它是一个指向实时 Markdown 笔记文件夹
  （例如某个 Obsidian vault）的原地指针（从不复制），而不是应用自己的文件夹。
  如果只设置了 `VAULT_PATH`（像本仓库这样 —— `data/library` 为空，
  真实内容是从 `VAULT_PATH=..` 原地建立索引的），"default" 知识库
  会以**空**状态启动；你需要通过 Ayarlar → Kütüphane 中的导入功能
  手动（重新）导入内容。如果你想手动运行并先预览：
  ```bash
  npm run vault:migrate -- --dry-run   # reports what would be moved, writes nothing
  npm run vault:migrate                # actually moves it
  ```

## 首次建立索引

要能够对话，必须先把活动知识库的内容转换为向量索引：

```bash
npm run index
```

它会扫描活动知识库资料库中的所有 `.md` 文件，
对没有 frontmatter 的文件给出警告并跳过，其余的切块后
用已配置的 embedding 模型（推荐：`bge-m3`）做嵌入，并写入该知识库的
`index.db`。如果没有配置 embedding（仅关键词
模式），则跳过向量步骤；分块和关键词（FTS）数据仍然会写入。它基于 sha256
增量运行 —— 跳过未变化的文件，与 `pdf2md.py` 的逻辑相同。

参数：
- `npm run index -- --vault <id>` —— 为指定的知识库建立索引，而不是
  活动知识库（id 是 Ayarlar → Vault'lar 中显示的标识）。
- `npm run index -- --full` —— 全部从头重新建立索引（如果 embedding 模型
  改变了，就用它）。
- `npm run index -- --dry-run` —— 不写入任何内容，只报告会有什么变化。

## 日常使用

```bash
npm run dev
```

`http://localhost:5173` 会打开。学习并更新笔记之后，随时
运行 `npm run index` —— 即使应用开着也不会冲突（WAL 模式）。

如果你想要自动监视（可选，非默认）：

```bash
npm run index:watch
```

## 持久运行（不使用开发服务器）

```bash
npm run build
BODY_SIZE_LIMIT=1G node build
```

没有 `BODY_SIZE_LIMIT` 时，adapter-node 会把请求体限制在 **512 KB**
（它自己的默认值），任何超过这个大小的来源上传，在到达
路由之前就会被 413 拒绝 —— 小的 `.docx` 能通过，但真正的
`.pdf`/`.pptx`/`.xlsx` 不行。在桌面版中，这个变量会
自动传给 sidecar（`src-tauri/src/lib.rs`）；手动运行 `node build` 时
需要你自己提供。这种运行方式不读取 `.env`，你需要把它
作为环境变量传入。

## 桌面版（Tauri）

一个让同一服务器在原生窗口而不是浏览器中运行、
且不使用 Electron 的软件包。**Windows 版自带 Node.js 22 和 Python 3.12（python-build-standalone）**：
二者都无需另行安装，应用始终使用内置的 Node（WebView2 安装程序也
包含在包内）。对话需要一个模型来源（推荐：Ollama，或其他本地服务器 / 云服务商），
它不会打包进软件包。macOS/Linux 版仍需手动安装 Node（和 Python），见下文。

```bash
npm run desktop:dev      # native window against the live Vite dev server, HMR works
npm run desktop:build    # builds the package for the operating system you are on
```

**版本号会自动递增。** `desktop:build` 在构建之前运行 `scripts/release.mjs --auto`：它会查看自上一个 `v*` 标签以来的提交（[Conventional Commits](https://www.conventionalcommits.org)）。`fix`/`perf`/`refactor` 对应补丁版本（0.1.0 → 0.1.1），`feat` 对应次版本（0.1.x → 0.2.0），`!` 或 `BREAKING CHANGE` 对应主版本（→ 1.0.0）；`docs`、`chore`、`test`、`ci` 不改变版本。升级只在 `main` 分支上、且版本文件干净时进行，会生成 `chore(release): vX.Y.Z` 提交和 `vX.Y.Z` 标签；推送请用 `git push --follow-tags`。手动方式：`npm run release`（预览：`npm run release -- --dry-run`）。

在 Windows 上，`desktop:build` 的产物是：`src-tauri/target/release/bundle/nsis/vault-chat_<version>_x64-setup.exe`
（NSIS 安装文件）。Linux 和 macOS 的软件包用同一条命令、在各自的
操作系统上生成（不支持交叉编译）；目标位于 `src-tauri/tauri.linux.conf.json`
（`deb`、`appimage`）和 `src-tauri/tauri.macos.conf.json`（`app`、`dmg`）—— 见下方
"Linux 和 macOS（新增，测试版）"一节。对于现成的软件包，GitHub
Actions 中的 `desktop` 工作流会构建 Windows x64、Linux x64、macOS arm64 和 macOS x64
软件包，并为每个上传一个名为 `vault-chat-<target>` 的 artifact
（`.github/workflows/desktop.yml`；artifact 保留 7 天）。Windows ARM64 也
在尝试，但目前预计会失败，且不会把结果标红。
该工作流会在推送到 `main` 和 `ci` 分支、`v*` 版本标签、PR 时，
以及从 Actions 标签页手动（"Run workflow"）运行；仅文档变更
（`*.md`、`docs/`）不会触发构建。仓库为私有时，`main`、标签和 PR 构建
会被跳过（Actions 分钟数有限）；这期间想构建某个分支，
可用 `git push origin <branch>:ci`（必要时加 `--force`）或手动运行。

Windows 的安装位置和数据文件夹：
安装是按用户的（无需管理员权限），位于 `%LOCALAPPDATA%\vault-chat\`
之下。应用数据（对话历史、知识库注册表、每个知识库的
资料库/索引、`config.json`）在 Windows 上保存在 `%APPDATA%\Roaming\app.vaultchat.desktop\`
（macOS：`~/Library/Application Support/app.vaultchat.desktop/`，Linux：
`~/.local/share/app.vaultchat.desktop/`）下 —— 与 `data/` 文件夹完全分开，不与
浏览器方式共享。知识库注册表依据这里的 `DATA_DIR` 解析（sidecar 自己的
环境变量，用户看不到）；而 `config.json` 中唯一的
`vault_path`/`vault_name` 对则是另一回事 —— 它决定最初安装的 **"default"**
知识库的名称，额外的知识库之后在应用内 Ayarlar → Vault'lar 中
创建。

首次启动时会要求你选择一个文件夹（原生文件夹选择器）—— 这是为了
确定 "default" 知识库的显示名称，
资料库内容并不会关联到那里（资料库始终是属于应用的
文件夹，见上面的"知识库"一节）。所选内容会写入 `config.json`，
之后的启动不会再询问。以后要更改这个名称，请使用
**Ayarlar → Masaüstü — Kasa Konumu**（更改在下次
启动时生效，不会重启正在运行的服务器）。

由于它直接调用 `node build/index.js`，持久运行方式所要求的
一切（Node 22、使用环境变量而非 `.env`）在这里同样
适用 —— 见上面的说明。

## 在另一台 Windows 机器上运行

Windows 安装程序自带 Node.js 22 和 Python 3.12，但不带本地模型服务器
（如 Ollama）—— 模型来源（推荐 Ollama、其他本地服务器或云服务商）
必须在目标机器上另行设置。在开发流程中（`npm run dev` / `node build`），Node 仍需手动安装。在目标机器上安装之后，`npm run doctor`
（开发流程）或应用自己的 "Yerel sunucu … çalışmıyor" /
"Kurulum tamamlanmadı" 横幅（桌面版）会告诉你缺少什么。

| 组件 | 是否必需 | 由谁安装 |
|---|---|---|
| Node.js 22.x（`>=22 <23`） | 是 | Windows 桌面版内置（应用始终使用它）；开发流程：手动 —— https://nodejs.org |
| Ollama + `qwen3:8b` + `bge-m3` | **推荐**（其他本地服务器或云服务商也可以；没有 embedding 则只有关键词搜索） | 手动 —— https://ollama.com，或通过安装向导 |
| WebView2 Runtime | 是（仅桌面版） | 自动 —— 如果没有，NSIS 安装程序会用其中的小型引导程序（`embedBootstrapper`）安装；安装过程中需要联网 |
| Visual C++ Redistributable | 技术上需要 | 通常 Windows 10/11 上已有；缺少时手动安装 |
| Python 3.12+（稳定版） | 否 —— 仅用于 PDF/文档/YouTube 导入 | Windows 桌面版内置（3.12）；如果有带 docling 的系统 Python 或 `PYTHON_BIN`，则优先使用它。其他流程：手动 —— https://python.org |
| `markitdown` 及其他轻量包（`pip install -r ingest/requirements.txt`） | 否 —— 仅用于 PDF/文档/YouTube 导入 | 桌面版中由应用自己的 "Şimdi kur" 横幅安装（用内置 Python 创建 `python-venv`，需要联网）；其他流程：手动 |
| docling（重型 PDF/OCR） | 否 —— 可选 | 手动（`pip install docling`） |
| pandoc | 否 —— 仅用于 `.tex` 转换 | 手动 |

注意事项：
- **不支持 ARM64 Windows。** `sqlite-vec` 在 Windows 上只有
  `win32-x64` 预编译包 —— 在基于 ARM 的 Windows 机器
  （Snapdragon 等）上，`npm install` 会因 sqlite-vec 而失败。
- **错误的 Node 版本会被静默安装，到运行时才出错。** 由于 `engine-strict`
  是关闭的，`npm install` 用 Node 20/24 也能完成，但
  `better-sqlite3` 的原生二进制是针对 Node 22 的 ABI 编译的 —— 错误只会在
  第一次访问数据库时出现。`npm run doctor` 在安装后
  立刻就能发现这一点。
- **`secrets.json` 不能迁移。** 在桌面版中，它用 AES-256-GCM
  加密；加密密钥存放在操作系统的密钥库中（Windows
  DPAPI、macOS Keychain、Linux Secret Service），并且绑定到用户/机器配置文件 ——
  复制到另一台机器/另一个用户的 `secrets.json`
  无法解密，表现得就像"没有密钥"。云服务商（DeepSeek/Gemini/Groq/...）的 API 密钥
  请在目标机器上通过 Ayarlar → Sağlayıcılar 重新输入。
- **知识库内容需要手动迁移。** `data/vaults.json` 每次读取时都会重新推导自己的
  路径，所以是可以移植的，但每个知识库的实际内容
  （`data/vaults/<id>/library/`、`index.db`、`study.db`）需要另外复制 ——
  或者在目标机器上通过导入 + `npm run index` 重新
  生成。
- **在 Windows 桌面版中，PDF/文档/YouTube 导入只缺少轻量
  包。** `ingest/` 文件夹和 Python 3.12 已包含在安装包中
  （见 `scripts/stage-server.mjs`、`scripts/fetch-python-runtime.mjs`）；`markitdown`
  及其他包不在包内，首次使用时应用会通过 `/api/system/python`
  检测到这一点，并在橙色横幅中用 "Şimdi kur" 按钮替你把
  `pip install -r ingest/requirements.txt` 安装到数据文件夹中的 `python-venv`。
  如果已经有带 docling 的 Python，则优先使用它。

## Linux 和 macOS（新增，测试版）

> **警告：** Linux 和 macOS 的软件包是新的。它们在 CI 中构建，但**尚未在真实的
> Linux/macOS 机器上试用过**；此外 macOS 软件包**没有签名，也没有
> 公证（notarize）**。成熟度不如 Windows —— 如果
> 遇到问题，请附上数据文件夹中的 `launch.log`（见下文）反馈。关于 macOS
> 的分步试用清单：[`docs/macos-deneme-listesi.md`](../docs/macos-deneme-listesi.md)（土耳其语）。

支持的软件包格式（在 CI 中构建；见"桌面版（Tauri）"）：

| 平台 | 软件包 | 说明 |
|---|---|---|
| Linux x64 | `.deb`、`.AppImage` | `.deb` 依赖以下软件包：`libwebkit2gtk-4.1-0`、`libgtk-3-0`、`libayatana-appindicator3-1`、`libsecret-1-0`（`src-tauri/tauri.linux.conf.json`） |
| macOS（Apple Silicon 和 Intel） | `vault-chat.app` + `.dmg`，未签名 | macOS 11.0 及以上（`minimumSystemVersion`） |

在 Linux 上从源码构建（CI 中使用的 Ubuntu 22.04 软件包列表）：
```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf libsecret-1-dev libdbus-1-dev
npm install && npm run desktop:build
```

| 组件 | 是否必需 | 在 Linux / macOS 上如何安装 |
|---|---|---|
| Node.js 22.x（`>=22 <23`） | 是 —— 未内置于软件包 | https://nodejs.org、Homebrew（`brew install node@22`）、nvm/fnm/Volta 或发行版的包管理器 |
| 模型来源（推荐 Ollama，或其他本地服务器、云服务商） | 对话需要其中一个 | 手动 —— https://ollama.com |
| Python **3.10+** | 否 —— 仅用于 PDF/文档/YouTube 导入 | macOS：`brew install python@3.12`；Linux：发行版的包管理器（Debian/Ubuntu 上用 `sudo apt install python3 python3-venv`） |
| pandoc | 否 —— 仅用于 `.tex` 转换 | Homebrew 或发行版的包管理器 |

你需要了解：
- **如何找到 Node？** 从图形界面启动的应用不会继承
  shell 的 PATH。因此 `node` 会先在 PATH 中查找（包括会话/登录 shell 的 PATH），
  然后在已知位置查找：`/usr/local/bin`、`/usr/bin`、
  `/opt/homebrew/bin`、`~/.volta/bin`、nvm（`~/.nvm/versions/node`）和 fnm
  版本文件夹（`src-tauri/src/platform.rs`、`src-tauri/src/lib.rs` 中的
  `resolve_node_binary`）。如果找到的 Node 主版本不是 22，应用会在
  启动时给出警告。
- **Python 的 "Şimdi kur"** 在 macOS/Linux 上不会向系统 Python 执行 `pip install`
  （会被 Debian/Homebrew 的 "externally managed" 保护拦住）。它会改为在数据
  文件夹中创建一个属于应用的虚拟环境（`python-venv`），并把软件包安装到
  那里（`src/routes/api/system/python/+server.ts`、
  `src/lib/server/python-bin.ts`）。在 Debian/Ubuntu 上，如果没有
  `python3-venv` 包，就无法创建环境，应用会告诉你这一点。在 macOS 上，如果没有安装命令行
  工具（CLT），则会跳过 `/usr/bin/python3` 这个占位程序
  （避免触发安装弹窗）。也可以通过 `PYTHON_BIN` 环境变量指定某个
  解释器。
- **winget 仅限 Windows。** 在 macOS/Linux 上，应用不会自己
  运行包管理器；Homebrew / 发行版包管理器的命令由你自己
  运行。
- **API 密钥**由操作系统的密钥库保护：在 macOS 上是
  钥匙串（服务 `app.vaultchat.desktop`，账户 `secrets-key`；
  首次启动时可能会弹出权限询问 —— "始终允许"），在 Linux 上是
  Secret Service（GNOME Keyring / KWallet）。在 Linux 上，如果没有这个服务，密钥会
  以未加密方式（保存在权限为 `0600` 的文件中）存放，你会在 Ayarlar → Sağlayıcılar 中
  看到一条警告；安装 GNOME Keyring 或 KWallet 并重启应用后，
  它们就会被加密。如果密钥存在但无法读取（"已锁定"），则不会
  重新生成任何内容；**Ayarlar → Sağlayıcılar → "Kayıtlı API anahtarlarını
  sıfırla"** 会把旧文件备份为 `secrets.json.locked-<date>`，然后
  重启应用。详情：`SECURITY.md`。
- **后台进程：** 在 Linux 上，即使应用崩溃，操作系统内核也会向 Node
  服务器发送 `SIGTERM`（`PR_SET_PDEATHSIG`）。在 macOS 上没有这样的
  保证：只有正常退出（Cmd+Q）时才会清理服务器进程；
  如果应用崩溃或被强制结束，`node` 进程可能会留在后台。
- **日志文件：** 启动出问题时看 `launch.log` —— macOS：
  `~/Library/Application Support/app.vaultchat.desktop/launch.log`，Linux：
  `~/.local/share/app.vaultchat.desktop/launch.log`。

### macOS：打开未签名的应用（Gatekeeper）

由于应用没有经过 Apple 签名，也没有通过公证，
macOS 在首次启动时会阻止它（"无法验证开发者"或"已损坏"）。
把 `vault-chat` 从 `.dmg` 拖到 **Applications**，然后在 Finder 中对应用
**右键 → 打开 → 打开**。如果仍然打不开，请移除隔离标记：

```bash
xattr -dr com.apple.quarantine /Applications/vault-chat.app
```

## MCP 服务器

一个把你知识库中的笔记开放给 Claude Code/Desktop 等 MCP 客户端的本地
服务器 —— 不需要单独的软件包或安装，`mcp/` 就在本仓库中，
与 `indexer/` 采用相同的结构。

**在打包的桌面应用中**，服务器以单文件包的形式提供
（`dist-server/mcp/vault-chat-mcp.mjs`，由 `scripts/build-mcp.mjs` 生成；`npm run stage:server`
中会自动完成）：不需要仓库、`tsx` 或其他安装，
系统中的 Node 22 就够了。**Ayarlar → MCP istemcisine bağla** 卡片会提供指向该文件的
现成配置。`node <install>/_up_/dist-server/mcp/vault-chat-mcp.mjs --print-config`（在 Windows 上安装文件夹为 `%LOCALAPPDATA%\vault-chat`）
也会输出同样的配置块。如果没有提供 `DATA_DIR`，则使用已安装应用的数据文件夹
（`%APPDATA%\app.vaultchat.desktop`，macOS 上为 `~/Library/Application Support/app.vaultchat.desktop`，
Linux 上为 `$XDG_DATA_HOME` 或 `~/.local/share` 下的同名文件夹）。从源码
运行时，`mcp/launch.mjs` 这条路径仍然适用。单独生成该软件包：`npm run build:mcp`。

**工具：**

- `list_vaults` —— 列出对 MCP 开放的知识库（按知识库开启/关闭：**Ayarlar → Kasalar**）。
- `search_library` —— 在知识库中搜索；默认（`mode: "auto"`）为向量搜索，如果没有 embedding 或没有结果，则回退到关键词（FTS5）。`mode`：`vector`、`keyword`（仅 FTS5，不需要 embedding）或 `hybrid`（向量 + FTS5，reciprocal rank fusion）。支持 `domain`/`level` 过滤。
- `get_note` —— 读取一篇笔记；`heading` 只返回该标题下的章节，`max_chars`/`offset` 提供分页读取（`hash` 始终是整个文件的哈希）。
- `list_domains` —— 列出知识库中的 domain 值，附带笔记数量和最后修改时间。
- `list_sources` —— 列出知识库中的来源，附带 domain 和 level 值。
- `create_vault` —— 创建新的知识库。
- `import_source` —— 把本地文件或 URL 加入**待处理**队列以供导入。
- `list_pending_imports` —— 显示待处理导入的状态。
- `edit_note` —— 编辑已有的笔记（需要把 `get_note` 的 `hash` 值作为 `expected_hash`；frontmatter 不会改变，旧版本会作为修订保存）。**默认关闭**：只能通过 **Ayarlar** 中的开发者开关打开，代理无法打开；关闭时调用会返回 `MCP_EDIT_NOTE_DISABLED` 错误。

写入类工具通过应用的 API 工作，因此**应用必须处于
运行状态**（应用会在 `DATA_DIR` 中写入 `mcp-endpoint.json`）。
被导入的来源在你于应用中确认之前不会进入资料库；代理
无法自己确认，也无法更改该设置。本地文件只会从你在
**Ayarlar** 中允许的文件夹读取；URL 会走普通的网页
导入流程。如果你愿意，可以按知识库开启**自动确认 MCP 导入**
设置：`off`（默认，一切由你确认）、`clean`（仅限无警告、
无需审查标记、非重复的内容）
或 `all`（每一次成功的导入）。`all` 会让代理带来的内容在你
看到之前就加入搜索 —— 请考虑 prompt injection 的风险。

**一条命令完成配置。** 从源码（`npm install` 之后）运行下面这条命令即可完成所有事情：

```bash
npx vault-chat-mcp setup      # or: npm run mcp:setup
```

如果 Windows PowerShell 中禁止运行脚本（`npx.ps1 cannot be loaded`），请输入 `npx.cmd vault-chat-mcp setup` 或 `npm.cmd run mcp:setup`。

1. **选择数据文件夹：** `--data-dir` > `DATA_DIR` 环境变量（包括 `.env`）> 已安装桌面应用的文件夹（如果有）> 仓库的 `data/` 文件夹。
2. **注册到它找到的 MCP 客户端：** Claude Desktop（包括 Microsoft Store 版本的虚拟配置文件）、Claude Code（如果 `claude` 在 PATH 中）和 LM Studio（如果存在 `~/.lmstudio`）。它会把文件备份为 `<file>.bak-YYYYMMDD-HHMMSS`，不会触碰其他键和其他服务器；绝不会覆盖无效的 JSON。你需要完全关闭并重启 Claude Desktop。对于 Jan 和其他客户端，会在末尾输出配置块。
3. **创建 "Örnek Kasa"（示例知识库）：** 复制 5 篇简短的课程笔记（土耳其语和英语），对 MCP 开放并建立索引；你可以立即试用 `search_library` / `get_note`。由于 `vaults.json` 属于应用，应用运行时会跳过这一步：请关闭应用后重新运行命令。如果没有嵌入服务器（Ollama），索引只会用关键词（FTS5）搜索来建立；如果你配置的服务商无法访问，索引会报错，请按屏幕上的提示运行 `npm run index -- --vault ornek-kasa`。

选项：`--client claude-desktop,claude-code,lm-studio`（只注册这些；文件夹不存在则创建）、`--data-dir <folder>`、`--no-sample`（不创建示例知识库）、`--dry-run`（不写入任何内容，只显示将要做什么）。`npx vault-chat-mcp config` 只输出配置块。该命令可以重复运行：最新的注册信息和已有的示例知识库会保持原样。

如果你想手动配置：

**连接。** 已安装桌面应用的数据位于 `%APPDATA%\Roaming\app.vaultchat.desktop\`
之下（见"桌面版（Tauri）"）；`DATA_DIR` 必须指向这个文件夹。
如果从源码运行，默认是仓库的 `data/` 文件夹。对于 Claude
Code（不带 `--scope user` 时，注册仅绑定到运行命令所在的目录）：

```bash
claude mcp add --scope user vault-chat -- node "<this repo>\mcp\launch.mjs"
```

对于 Claude Desktop，要生成可添加到 `%APPDATA%\Claude\claude_desktop_config.json` 的、
带有**绝对路径** `DATA_DIR` 和 `node` 路径的现成配置块：

```bash
npm run mcp:config
```

输出格式如下；要读取已安装应用的数据，请把 `DATA_DIR`
换成上面的 AppData 文件夹：

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

`"command"` 必须是 `node`（或 `npm run mcp:config` 输出的 `node` 绝对路径），
而不是 `"npx"`/`"tsx"` —— 在 Windows 上这两者都是 `.cmd` shim，
在不经 shell 直接 spawn 的客户端上会报 `ENOENT`。

验证：

```bash
npm run mcp:smoke   # tests the tools in a single process, without touching a real model server
```

服务器运行时，诊断只需要一行 stderr：`DATA_DIR=... vaults=N`。
在 Claude Desktop 中，这一行会写入 `%APPDATA%\Claude\logs\mcp-server-vault-chat.log`。

## 服务商与模型能力

对话使用哪个服务商，在 **Ayarlar → Sağlayıcılar**
（或首次安装时的向导）中选择；Ollama 只是其中一个选项。模型的
工具调用（tools）和推理（reasoning）能力，是根据模型
名称推断出来的（Ollama 的 `qwen3:8b`、llama.cpp 的 `Qwen3-8B-Q4_K_M.gguf`、LM Studio/vLLM 的
`qwen/qwen3-8b` 等写法会映射到同一个系列），并且对每种服务器
类型都来自同一张表。如果推断有误，在 **Ayarlar → Sağlayıcılar →
"model listesini yönet"** 一节中，每个模型都有 **Araçlar** 和 **Akıl
yürütme** 开关：它们显示表中的默认值，修改后会写入针对该模型的
覆盖设置（`providers.json` 中的 `modelCaps`）。在标记为本地（`local`）的兼容 OpenAI 的服务器（llama.cpp、
LM Studio、vLLM）上，关闭思考时，对于会推理的模型，请求中
会加入 `chat_template_kwargs: { enable_thinking: false }`（qwen3 模板）；
它永远不会发送给云服务商。

## 小显存 GPU 的性能设置

> 本节仅在你使用 **Ollama** 作为模型服务器时适用
> （`ollama ps`、`OLLAMA_*` 变量、Modelfile）。在 LM Studio、llama.cpp 等
> 其他服务器上，上下文窗口和 GPU 层数的设置要在该服务器自己的
> 界面中进行。

如果本地模型很慢，先看这一点：模型加载后，`ollama ps` 输出中的
`PROCESSOR` 列是 `100% GPU`，还是像 `18%/82% CPU/GPU` 这样的拆分？
如果是拆分，说明模型放不进显存，一部分层在 CPU 上运行；速度
很大程度上取决于留在 CPU 上的层所占的比例。下面的设置会
降低这个比例。它们**不会改变质量**（相同的权重、相同的计算），只改变
层在哪里运行。

> 所有数字都是在**一台机器上**测得的（RTX 4050 Laptop 6 GB，`qwen3:8b`）。在其他硬件上
> 排序可能相同，但数字会不同。如果模型本来就能完全放进 GPU
> （`100% GPU`，通常是 12 GB 以上的显卡），这些设置就没有任何效果。

### 1. Ollama 一侧（写入 Ollama 的环境）

三个用户级环境变量，然后从任务栏关闭 Ollama 并重新打开：

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_FLASH_ATTENTION', '1',    'User')
[Environment]::SetEnvironmentVariable('OLLAMA_KV_CACHE_TYPE',   'q8_0', 'User')
[Environment]::SetEnvironmentVariable('LLAMA_ARG_FIT_TARGET',   '256',  'User')
```

- `OLLAMA_FLASH_ATTENTION=1` 和 `OLLAMA_KV_CACHE_TYPE=q8_0`：把 KV 缓存
  减小约一半，为显存中的模型层腾出空间。
- `LLAMA_ARG_FIT_TARGET=256`（MiB）：Ollama 的引擎（`llama-server`）默认会
  尝试空出 **1024 MiB** 显存；这个值会缩小这块余量。实测效果是，在同一
  模型上层数增加，并且在这台机器上 `qwen3:8b` Q4_K_M 的
  生成速度约快 50%。缩小余量会增加显存不足的风险，如果你
  与其他程序共用显存；遇到问题就调高该值或删除该变量。

**你需要了解**

- `LLAMA_ARG_FIT_TARGET` **不是 Ollama 官方文档中的设置**；它之所以有效，是因为 Ollama
  把引擎作为子进程启动时会继承其环境。Ollama 的更新
  可能会改变这一点。更新之后请重新查看 `ollama ps`。
- 这个变量会影响机器上**所有基于 llama.cpp 的程序**。
- 验证：加载一个模型并查看 `ollama ps`；此外，Ollama 的服务器日志
  （`%LOCALAPPDATA%\Ollama\server.log`）中应该出现 `free memory target of 256 MiB` 这一行。
- 撤销：对每个变量执行 `[Environment]::SetEnvironmentVariable('<NAME>', $null, 'User')`，
  然后重启 Ollama。

### 2. 应用一侧

| 设置 | 默认值 | 作用 |
|---|---|---|
| `OLLAMA_SERVE_CTX` | 模型表（`qwen3`：8192） | 向 Ollama 请求的上下文窗口（`num_ctx`），对所有模型生效 |
| `CHAT_RETRIEVAL_K` | 6（1–50） | 对话中每个问题取回的来源片段数量 |

- **在哪里设置：** `.env` 仅对 **`npm run dev`** 有效（见 `.env.example`）。
  **`node build`（"持久运行"）和打包（Tauri）的应用不读取 `.env`。** 对于 `node build`，
  请在运行该命令的 shell 中设置（`OLLAMA_SERVE_CTX=8192 node build`）；对于打包的
  应用，请设置为**操作系统环境变量**（如上面的 `'User'` 级别），
  然后关闭并重新打开应用；服务器进程会从应用继承环境。
- **调低 `OLLAMA_SERVE_CTX` 可能有风险。** 窗口变小后会有更多层留在 GPU 上，
  但如果 prompt（即使 k=6 也可能增长到约 4k token）放不下，Ollama 会移动上下文，
  并且**只保留最前面的 4 个 token**；系统规则会被悄悄丢掉。在低于默认的 8192 之前，
  请先查看 `data/app-log.jsonl` 中的 `llm_timing` 记录里
  是否出现 `nearCtxLimit: true`。
- **如果你的显存充足**，可以把两者一起调高（例如 `OLLAMA_SERVE_CTX=16384`、
  `CHAT_RETRIEVAL_K=12`）：这样会基于更多来源作答。`k` 对回答质量的影响
  无法测量，属于主观判断；如果有什么变差，就改回原值。

### 3. 更小的量化（可选）

如果模型无法完全放进 GPU，更小的量化（例如 `IQ4_XS`，约 4.6 GB；`Q4_K_M`
约 5.0 GB）能让更多层留在 GPU 上。根据已发布的一项测量（另一个
发布者的自定义量化，仅反映趋势），`IQ4_XS` 的偏差与 `Q4_K_M` 接近；
在 3-bit 量化（`IQ3_M`、`Q3_K_M`）下，偏差增加约 2-3 倍。本地没有做过足以
区分质量的测试：请用真实的问题自行判断。

**直接拉取原始 GGUF。** 官方 `qwen3:8b` 的 `tools` 和 `thinking` 能力来自模型的
**模板**；从其他来源拉取原始 GGUF 会丢失这些能力，应用的
skill 工具/思考模式就无法工作。正确的做法是取官方模型的 Modelfile，只修改 `FROM`
这一行：

```powershell
cmd /c "ollama show qwen3:8b --modelfile > Modelfile"
# In the Modelfile, replace the FROM line with the path of the .gguf file you downloaded (with forward slashes),
# do not touch any other line. Then:
ollama create qwen3:8b-iq4xs -f Modelfile
ollama show qwen3:8b-iq4xs      # tools and thinking should appear under Capabilities
```

（有意使用 `cmd /c`：Windows PowerShell 5.1 的 `>` 运算符会把文件写成 UTF-16，而 Ollama
无法读取。）

请把你下载的文件的 SHA256 与发布者页面上的值进行比对。

### 4. 测量

每次对话调用都会向 `data/app-log.jsonl` 写入一条 `llm_timing` 记录：`promptTokens`、
`completionTokens`、`promptMs`、`completionMs`、`loadMs`、`numCtx`、`nearCtxLimit`。只有
数字，没有文本内容。

## 故障排查

- **本地模型很慢** → 见上面的"小显存 GPU 的性能设置"。
- **"Yerel sunucu … çalışmıyor" 警告 / "… sağlayıcısına ulaşılamıyor"** → 对话
  使用的本地服务器（Ollama、LM Studio、llama.cpp 等）是否已启动？对 Ollama 来说是
  `ollama serve`；如果地址不对，请在 Ayarlar → Sağlayıcılar 中修正该服务商的
  `baseUrl`（`OLLAMA_URL` 已不再被读取）。
- **"Kurulum tamamlanmadı" 警告 / 对话没有响应** → 对话链
  为空：运行安装向导（`/setup/local-server`），或在 Ayarlar →
  Sağlayıcılar 中添加并启用一个服务商，再选择它的默认模型。
- **模型列表为空 / ModelPicker 报错** → 服务器上是否加载了
  模型？（对 Ollama 执行 `ollama pull qwen3:8b`；在 LM Studio/llama.cpp 中加载一个模型。）
- **搜索结果较差 / 只有关键词搜索在工作** → 可能没有配置
  embedding（语义搜索已关闭）；请在 Ayarlar → Sağlayıcılar 中选择一个
  embedding 模型，然后重新为知识库建立索引。
- **找不到来源 / 回答不相关** → 是否运行了 `npm run index`，索引是否是最新的？
  如果你使用多个知识库，
  还要检查：活动的是不是正确的知识库（Ayarlar → Vault'lar），`npm run index`
  建立索引的是活动知识库还是另一个知识库（可能通过 `--vault <id>`
  传错了知识库）？
- **数学公式没有渲染 / 显示出 `f(x)` 这样的裸代码** →
  用 `f(x)` 这样的示例文本测试 `src/lib/markdown.ts` 流水线。
- **MCP 客户端没有显示 "connected" / 立即关闭** → `"command"`
  的值确实是 `"node"` 吗（见上面的说明）？`npm run mcp:smoke`
  能正常通过吗？在 Claude Desktop 中，检查 `%APPDATA%\Claude\logs\mcp-server-vault-chat.log` 中
  那一行 stderr —— `DATA_DIR` 指向的是你预期的位置吗？
- **MCP `search_library` 没有返回结果，但应用自己的对话
  能找到** → 它们可能读取的是不同的 `DATA_DIR`/知识库；请查看 `list_vaults`
  工具返回的 `indexed`/`noteCount` 字段。
- **云服务商（DeepSeek/OpenRouter/Groq/Google AI Studio/Mistral）
  的模型列表或连接测试随机失败，而在浏览器中
  该 API 地址能正常打开** → 在 `data/app-log.jsonl` 中查找该服务商的
  类似 `"listModels: ... fetch failed (SELF_SIGNED_CERT_IN_CHAIN)"` 的
  行。这不是 vault-chat 代码中的错误 —— 而是你的杀毒软件
  （Kaspersky、ESET、Avast/AVG、Bitdefender、Norton 等都有"扫描加密
  连接"功能）用自己的根证书插入并检查出站 HTTPS 连接，
  但 Node.js（与浏览器不同）不使用 Windows 证书库，
  因而不信任该证书。解决办法：在 `certmgr.msc` → *Trusted Root
  Certification Authorities* 中，把杀毒软件的根证书
  导出为 Base-64 `.cer`/`.pem`，然后把 `NODE_EXTRA_CA_CERTS`
  环境变量设置为该文件的路径，并重启 `npm run dev`（或
  桌面应用）。放宽证书验证
  （`NODE_TLS_REJECT_UNAUTHORIZED=0`）**绝不是**解决办法 ——
  它同时会移除对真正中间人攻击的防护。
