---
name: svelte-vault-chat
description: Build and extend the local SvelteKit chat application that serves as the interactive teaching layer over the Obsidian vault, backed by Ollama (Qwen3 8B / 30B-A3B). Use this skill whenever the user works on the chat app, mentions the Svelte/SvelteKit frontend, Ollama streaming, chat UI, message rendering, LaTeX/KaTeX/math display problems (e.g. f(x) not rendering), code highlighting, model switching, or replacing Khoj. Also use it when creating new routes, components, or server endpoints inside the chat app project, even if the user does not name the skill explicitly.
---

# Svelte Vault Chat

A local-first SvelteKit chat application over the Obsidian vault. No Docker, no
external services: one Node process talking to Ollama at `localhost:11434`.
Retrieval is handled by the companion skill `vault-rag-index` — this skill owns
the app itself: routes, streaming, rendering, and UI conventions.

> **The app now lives in its own repo**, separate from this vault repo —
> not as a subfolder of it (corrected 2026-09-23: this used to hardcode one
> developer's local checkout path, which means nothing on another machine).
> This skill's own `.claude/skills/` should really be invoked from *that*
> repo going forward; the tree below is kept for reference but its root
> path no longer resolves from here.
>
> **Corrected 2026-09-23: "Project structure" below is the pre-build MVP
> skeleton, not the current app.** The real app has grown to a multi-vault
> registry, provider/model management, study artifacts (quiz/cards), memory,
> smalltalk gating, an MCP server, and many more routes/components than shown
> — see `vault-registry`, `model-provider`, `study-artifacts`, `mcp-server`
> and `frontend-revamp` skills for the phases that actually built those. Use
> the tree below only for the constraints it illustrates (no Docker/daemon,
> local-only, Windows-first), not as a map of what exists today.

## Non-negotiable constraints

1. **RAM is precious.** Ollama (Qwen3 30B-A3B) needs headroom. Never introduce
   Docker, Postgres, Redis, Electron, or any resident background service. If a
   dependency requires a daemon, find a file-based alternative.
2. **Math must render correctly.** The entire reason this app replaces Khoj is
   broken math rendering. Every change to the message pipeline must preserve
   the rendering rules in the "Rendering pipeline" section. When in doubt, test
   with the acid strings listed there.
3. **Local only.** No telemetry, no external APIs, no auth. The app binds to
   localhost.
4. **Windows-first.** The user develops on Windows/PowerShell. Scripts must be
   cross-platform Node (`npm run ...`), never bash-only. Paths must use
   `path.join`, never hardcoded `/` or `\\`.

## Project structure

```
vault-chat/
├── src/
│   ├── lib/
│   │   ├── components/
│   │   │   ├── Chat.svelte           # message list + composer
│   │   │   ├── Message.svelte        # single message, calls renderMarkdown()
│   │   │   ├── ModelPicker.svelte    # qwen3:8b ↔ qwen3:30b-a3b
│   │   │   └── SourceList.svelte     # RAG citations (vault note links)
│   │   ├── server/
│   │   │   ├── ollama.ts             # chat + embedding calls, streaming
│   │   │   └── retrieve.ts           # thin wrapper over vault-rag-index DB
│   │   ├── markdown.ts               # THE rendering pipeline (see below)
│   │   └── types.ts                  # ChatMessage, RetrievedChunk, ...
│   ├── routes/
│   │   ├── +page.svelte              # chat UI
│   │   └── api/
│   │       ├── chat/+server.ts       # POST → SSE stream
│   │       └── models/+server.ts     # GET → installed Ollama models
├── static/
├── .env                              # DATA_DIR, OLLAMA_URL (corrected 2026-09-23 —
│                                      #   VAULT_PATH/INDEX_DB_PATH are gone; a single
│                                      #   fixed index path made no sense once Faz 8's
│                                      #   vault registry made index.db per-vault, see
│                                      #   src/lib/server/env.ts for what's actually read)
└── package.json
```

Keep this layout. New features get new components under `lib/components/` and
new endpoints under `routes/api/` — do not grow `+page.svelte` into a monolith.

## Ollama integration

- Base URL from `OLLAMA_URL` env var, default `http://localhost:11434`.
- Use the **native** Ollama API (`/api/chat`), not the OpenAI-compat shim —
  the native API exposes `keep_alive` and better streaming metadata.
- Always pass `keep_alive: "10m"` so the model is not reloaded per message,
  but never `-1` (would pin RAM forever).
- Streaming: the server endpoint reads Ollama's NDJSON stream and re-emits it
  as SSE (`text/event-stream`). Send `{delta}` events per token and one final
  `{done, sources}` event carrying RAG citations.
- Model switching is a UI concern only: the model id travels in the request
  body. Default `qwen3:8b`; the user picks `qwen3:30b-a3b` for deep sessions.
- On connection failure, return a friendly error telling the user to check
  that `ollama serve` is running — never a raw stack trace in the UI.

## Rendering pipeline (`src/lib/markdown.ts`)

This is the heart of the app. One exported function, used by `Message.svelte`
and nowhere else:

```ts
export function renderMarkdown(raw: string): string
```

Pipeline order — do not reorder:

1. **Protect code.** Extract fenced code blocks and inline code into
   placeholders first, so later steps never touch code.
2. **Normalize math delimiters.** Local models emit inconsistent delimiters.
   Convert `\(...\)` → `$...$` and `\[...\]` → `$$...$$` before parsing.
   Also handle the common failure of bare LaTeX in prose: do NOT attempt to
   auto-wrap heuristically — instead the system prompt sent to Ollama (see
   below) instructs the model to always use `$`/`$$`.
3. **Parse markdown** with `markdown-it` (`html: false`, `linkify: true`).
4. **Render math** with `@vscode/markdown-it-katex` (or `markdown-it-katex`
   fork that supports `$$` blocks), `throwOnError: false`, `output: "html"`.
5. **Highlight code** via `markdown-it`'s `highlight` option using `shiki`
   (theme `github-dark`/`github-light` following app theme). Lazy-load shiki
   once at module scope, not per message.
6. **Sanitize** the final HTML with `dompurify` (jsdom build on server or
   render client-side), allowing KaTeX's `math`/`annotation`/`svg` tags.
7. **Restore code placeholders.**

Import `katex/dist/katex.min.css` globally in `+layout.svelte`.

**Acid test strings** — after any change to this file, render all of these and
verify visually:

- `Tanım: $f(x) = \sin(\omega t)$ periyodik bir sinyaldir.`
- `$$X(j\omega) = \int_{-\infty}^{\infty} x(t) e^{-j\omega t}\,dt$$`
- `\(H(s) = \frac{1}{s+1}\)` (must normalize and render)
- A fenced ```python block containing `$x = 5$` (must stay literal)
- Inline code `` `$PATH` `` (must stay literal)

## System prompt sent to Ollama

Keep it in `src/lib/server/prompt.ts` as a template. It must instruct the
model to:

- answer in the user's language (Turkish in practice),
- write ALL math strictly inside `$...$` / `$$...$$` (never `\(`, never bare),
- cite retrieved vault notes by their `topic` frontmatter field when used,
- say explicitly when retrieved context does not cover the question.

Retrieved chunks are injected as a fenced `<context>` section above the user
question, each chunk prefixed with its source path and frontmatter summary
(`topic`, `domains`, `depth`).

## UI conventions

- Minimal, fast, keyboard-first. `Enter` sends, `Shift+Enter` newlines.
- Render the assistant message progressively during streaming, but run the
  full markdown pipeline only on the accumulated text per animation frame
  (throttle ~50ms) — never per token.
- Show RAG sources as collapsible chips under each answer, linking with the
  `obsidian://open?vault=...&file=...` URI scheme so clicks open Obsidian.
- Dark/light theme via `prefers-color-scheme`; KaTeX and shiki themes must
  follow.
- All user-facing strings in Turkish.

## Known gotchas (found the hard way)

- **`$state` array deep-proxy trap.** `messages.push(obj)` where `messages` is
  `$state<ChatMessage[]>([])` stores a *proxied copy* of `obj` in the array —
  your original `obj` reference stays pointed at the unproxied original.
  Mutating that stale reference afterward (e.g. `assistantMessage.content =
  chunk` in a streaming loop) updates nothing the UI reads from: the request
  completes fine, the UI just never shows it. Always re-grab the reference
  from the array after pushing: `messages.push({...}); const msg =
  messages[messages.length - 1];` — then mutate `msg`, not the pre-push
  object. This was the root cause of a very confusing "network request
  succeeds but nothing renders" bug — it looks exactly like a networking or
  server problem and isn't one.
- **`renderMarkdown()` is async and fires on every content update during
  streaming** (many times/sec) — calls can resolve out of order because the
  first call (empty content, at message creation) is the one that pays for
  shiki's one-time highlighter bootstrap and can resolve *after* later,
  faster calls. Guard with a per-message monotonic call-id and only apply the
  result if it's still the latest call; otherwise a late-resolving empty
  render can wipe real streamed content off the screen.
- **Vite dev server host binding on Windows**: default `host` resolution can
  bind to whichever address "localhost" resolves to first (IPv6 `::1` was
  observed here), which some Windows setups (VPN/AV interfering with IPv6
  loopback) can't reach from the browser even though the app is loopback-only
  either way. Pin `server.host: '127.0.0.1'` in `vite.config.ts` explicitly.
- **Vite auto-restarts the whole dev server** when it detects
  `.svelte-kit/tsconfig.json` changing — which happens every time
  `svelte-check`/`svelte-kit sync` runs while `npm run dev` is live. This
  kills any in-flight streaming connection (`net::ERR_CONNECTION_RESET` in
  the browser) and drops the HMR websocket. Not a bug, but avoid running
  `svelte-check` against a live dev session mid-debugging, and if it
  happens, a hard refresh is required to reconnect.

## Dependencies (keep it lean)

`markdown-it`, KaTeX plugin, `katex`, `shiki`, `dompurify`, `better-sqlite3`
(read-only access to the index DB). Nothing else without a stated reason.
`adapter-node` for production builds (`node build` to run).

## When asked to add features

Before writing code: check whether the feature belongs to this skill (app) or
to `vault-rag-index` (chunking, embeddings, retrieval quality). Indexing logic
never lives inside the SvelteKit app beyond the thin read-only wrapper in
`lib/server/retrieve.ts`.
