---
name: model-provider
description: >
  Phase 6 of vault-agent-toolkit: implement the unified model/provider layer.
  Use this skill whenever working on model management, provider adapters,
  external API integration (DeepSeek, OpenAI, Gemini, Kimi), Ollama runtime
  control, API key storage, request cancellation, timeouts, or fallback
  behavior. Also consult it when touching the chat SSE endpoint, since the
  endpoint must route through this layer.
scope: server
---

# Model Provider Layer — Phase 6

The rest of the app must NEVER know which provider it is talking to. One
interface, provider adapters underneath. Decisions already made (do not
reopen them):

- **Ollama stays as the local runtime.** No llama.cpp, no direct GGUF, no
  Hugging Face downloading. Local models are managed by wrapping Ollama's
  API (`/api/tags`, `/api/pull`, OpenAI-compatible `/v1/chat/completions`).
- **Embeddings are OUT of scope.** The embedding model is part of the index
  configuration (sqlite-vec metadata), not this layer. Do not add embedding
  methods to the adapter interface.
- **Routing stays simple.** Per-task-type default provider + per-chat manual
  override. No automatic per-message routing (backlog).
- **Fallback is built on cancellation.** Implement AbortSignal plumbing and
  single-flight FIRST; fallback is a thin policy on top. Fallback without
  reliable cancellation creates the exact race conditions this phase exists
  to eliminate.

## Directory & config layout

```
src/lib/server/providers/
  types.ts          # ProviderAdapter, Chunk, ModelInfo, ProviderError
  registry.ts       # loads data/providers.json, instantiates adapters
  openai-compat.ts  # generic OpenAI-compatible adapter (covers everything)
  normalize.ts      # reasoning/text chunk normalization per provider dialect
  inflight.ts       # single-flight map: chatId -> AbortController
  secrets.ts        # SecretStore interface + json file implementation
  ollama.ts         # extends openai-compat with keep_alive / pull / unload
data/providers.json # provider configs (NO keys in this file)
data/secrets.json   # keys only, gitignored, server-only
```

`providers.json` entry shape:

```json
{
  "id": "deepseek",
  "label": "DeepSeek",
  "baseUrl": "https://api.deepseek.com/v1",
  "kind": "openai-compat",
  "reasoningDialect": "reasoning_content",
  "enabled": false,
  "timeouts": { "connectMs": 5000, "firstTokenMs": 30000, "idleMs": 30000 }
}
```

Ollama entry uses `"reasoningDialect": "think-tags"` and generous
`firstTokenMs` (120000) because cold-loading a 30B MoE model can take a
minute or more on this machine.

## Adapter contract (types.ts)

```ts
export interface ProviderAdapter {
  id: string;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<Chunk>;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<"ok" | "unreachable" | "auth_error">;
}

export type Chunk =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "usage"; prompt: number; completion: number }
  | { type: "done" };

export interface ModelInfo {
  id: string;
  ctx: number;
  caps: { tools: boolean; reasoning: boolean };
}
```

Rules:

- `signal` is REQUIRED, not optional. Every adapter passes it to its
  upstream `fetch`. When aborted, the upstream connection must close (for
  Ollama, closing the connection actually stops generation — this is the
  fix for "background process keeps running after an error").
- Adapters normalize reasoning output in `normalize.ts`:
  - Qwen3 via Ollama streams `<think>...</think>` inline → parse ONCE in
    the stream normalizer, emit `reasoning` chunks; never let raw
    `<think>` tags reach the client (this caused the Phase 0 ThinkingPanel
    bugs — see tasks/bugfix-brief.md).
  - DeepSeek sends a separate `reasoning_content` delta field → map to
    `reasoning` chunks.
- The SSE endpoint consumes only `Chunk`s. The existing
  `stabilizeForStreaming` markdown layer and ThinkingPanel stay
  provider-agnostic and must not be modified for provider reasons.

## Single-flight (inflight.ts)

Server keeps `Map<chatId, AbortController>`. On a new request for a chat:

1. If an entry exists, `abort()` it and delete it.
2. Register a fresh controller before the first upstream byte is requested.
3. Also abort when the client SSE connection closes (`request.signal`).
4. Always delete the entry in a `finally` block.

This two-line rule eliminates the duplicate-generation race. Never start a
second upstream request for the same chat while the first is unaborted.

## Timeouts — three counters, never one

| Counter      | Meaning                              | Local default | Cloud default |
|--------------|--------------------------------------|---------------|---------------|
| connectMs    | TCP/TLS connect + headers            | 5 s           | 5 s           |
| firstTokenMs | request sent → first content chunk   | 120 s         | 30 s          |
| idleMs       | max silence BETWEEN chunks mid-stream| 30 s          | 30 s          |

A single flat timeout is forbidden: it either kills legitimate cold model
loads locally or lets dead streams hang forever. `idleMs` is what catches
the "request died mid-stream but never closed" failure mode: reset a timer
on every chunk; on expiry, abort via the same AbortController and emit a
typed error.

## Error taxonomy & fallback policy

Classify every failure into `ProviderError { kind, providerId, retryable }`:

- retryable: network error, connect/firstToken/idle timeout, HTTP 429, 5xx
- NOT retryable: 401/403 (auth), 400 (bad request), context-length exceeded
  → surface to the user immediately with the provider name and reason; do
  not try the next provider (the same oversized prompt will fail there too,
  and auth errors need user action).

Fallback chains are configured per task type in `providers.json`, e.g.
`"chains": { "chat": ["ollama"], "ingest": ["deepseek", "ollama"] }`.

Hard rule — **no silent switching after first token**:

- Failure BEFORE the first `text` chunk → abort, move to the next provider
  in the chain, and emit a `notice` SSE event ("deepseek unavailable →
  switched to local model") that the UI renders as a small inline note.
- Failure AFTER the first `text` chunk → do NOT continue with another
  provider. Keep the partial answer visible, show the typed error, and
  offer a "retry with <next provider>" action. A half-DeepSeek,
  half-Qwen answer is worse than a visible failure.

## SecretStore (secrets.ts)

```ts
interface SecretStore {
  get(providerId: string): Promise<string | null>;
  set(providerId: string, key: string): Promise<void>;
  delete(providerId: string): Promise<void>;
  list(): Promise<string[]>; // provider ids only, never values
}
```

- Implementation now: `data/secrets.json`, server-only, in `.gitignore`.
- Keys NEVER reach the client. No endpoint returns a key. The settings API
  exposes only `{ providerId, connected: boolean, mask: "sk-…1a2b" }`
  (mask = first 3 + last 4 chars, computed server-side).
- "Test connection" button calls the server, which calls `health()`.
- Do not add DPAPI/keychain now; the interface exists so the Phase 7 Tauri
  build can swap in a keychain implementation and migrate secrets.json in
  one file.

## Ollama-specific responsibilities (ollama.ts)

- **Model swap discipline:** 32 GB RAM fits ONE large model. When the
  active local model changes, unload the old one first
  (`keep_alive: 0` request), then load the new one. Never let 8B and
  30B-A3B coexist in RAM.
- **Shared mutex with ingest:** model load/unload and Phase 5's
  one-at-a-time conversion queue contend for the same RAM/CPU. Route both
  through the existing single job mutex ("the user's RAM belongs to Ollama
  first" — see skills/source-ingest). A model swap waits for a running
  conversion and vice versa.
- `listModels()` maps `/api/tags`; `ctx` and caps come from a small static
  table keyed by model family, with a conservative default (8192, no
  tools) for unknown models.
- Model download (`/api/pull`) streams progress; expose it as SSE the same
  way import progress works in Phase 5.

## Settings UI requirements (minimal)

- Provider list: enabled toggle, base URL (readonly for built-ins), key
  status (`connected ✓` / mask / "add key"), test button, per-task default
  chain selection.
- Chat header: current model/provider selector = per-chat override; resets
  to task default for new chats.
- Notices from fallback render inline in the transcript, styled like
  system notes, not like assistant text.

## Definition of done

- [ ] All chat traffic (chat, quiz/flashcard generation, ingest summaries)
      goes through the registry; no direct Ollama fetches remain outside
      `providers/`.
- [ ] Killing the client tab mid-stream stops Ollama generation within
      idleMs (verify with `ollama ps` / GPU load).
- [ ] Sending a new message while one streams aborts the old one; no
      interleaved chunks in the transcript (regression test).
- [ ] Wrong API key → immediate typed auth error naming the provider; no
      fallback attempt.
- [ ] Unreachable cloud provider on `ingest` chain → visible notice + local
      model completes the task.
- [ ] Mid-stream provider death → partial answer preserved + retry action;
      never a spliced two-provider answer.
- [ ] `git grep -i "sk-"` in client bundle output finds nothing;
      secrets.json is gitignored.

## Out of scope (do not implement)

Embedding provider selection; Hugging Face downloads; llama.cpp runtime;
automatic per-message routing; multi-user profiles; encrypted key storage
(Phase 7).
