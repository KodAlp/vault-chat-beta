import path from 'node:path';
import fs from 'node:fs';

/**
 * process.env accessors for server modules that must run both inside
 * SvelteKit (where $env/dynamic/private normally reads these) and outside
 * it — the MCP server (mcp/), which runs via tsx with no Vite runtime at
 * all. $env/dynamic/private is a Vite virtual module and cannot resolve
 * there. See the mcp-server skill for the full rationale.
 *
 * Every accessor is a FUNCTION, not a module-level constant — this matches
 * $env/dynamic/private's actual semantics (dynamic, re-read on every
 * access) and avoids an ESM-hoisting trap: a bootstrap that sets
 * process.env.DATA_DIR and then does `await import('./server.ts')` would
 * otherwise lose to a constant this module captured at its own load time.
 *
 * DATA_DIR/OLLAMA_URL were the first two migrated here (Faz 10's MCP path).
 * Faz 11 adds CHATS_DB_PATH/SKILLS_DIR/PROVIDERS_PATH/SECRETS_PATH — not
 * because MCP needs them, but because their old per-module defaults
 * (`path.join('data', '...')`, cwd-relative) silently diverged from
 * dataDir()'s DATA_DIR-aware resolution: with DATA_DIR set and no explicit
 * override for one of these four, chats.db/skills/providers.json/
 * secrets.json would land in a different directory than vaults.json. Every
 * default below is dataDir()-relative now, so DATA_DIR moves all of it
 * together. An explicit env var still wins over the default either way.
 */
function nonEmpty(v: string | undefined): string | undefined {
	return v && v.length > 0 ? v : undefined;
}

/** Moved from vaults.ts verbatim — same per-call resolution, same
 * mkdirSync side effect (directory creation, not a data write). Keeping
 * this behavior identical is what lets vaults.test.ts's useTmpDataDir()
 * keep working unchanged. */
export function dataDir(): string {
	const raw = nonEmpty(process.env.DATA_DIR);
	const root = raw ? path.resolve(process.cwd(), raw) : path.resolve(process.cwd(), 'data');
	fs.mkdirSync(root, { recursive: true });
	return root;
}

export function ollamaUrl(): string {
	return nonEmpty(process.env.OLLAMA_URL) ?? 'http://127.0.0.1:11434';
}

/** Overrides the context window requested from Ollama (options.num_ctx) for
 * every chat model, replacing providers/ollama.ts's per-family `serveCtx`.
 * A tuning/measurement knob: on a small GPU the window decides how many model
 * layers fit in VRAM, and the right value depends on the model and quantization
 * in use. Unset, empty, non-numeric or non-positive values are ignored, so a
 * typo can never silently shrink every prompt to nothing.
 *
 * Mind the floor: Ollama truncates an over-long prompt from the FRONT, where
 * the system rules live. The `nearCtxLimit` flag in the llm_timing app-log
 * marks calls that came close. */
export function serveCtxOverride(): number | undefined {
	const raw = nonEmpty(process.env.OLLAMA_SERVE_CTX);
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Chat's default retrieval breadth. 6 was measured on a 6 GB laptop GPU, where a
 * bigger <context> both slows decoding and no longer fits the 8192 window. */
export const DEFAULT_CHAT_RETRIEVAL_K = 6;
/** Upper bound for CHAT_RETRIEVAL_K. Past this the prompt cannot fit any
 * realistic window anyway (each chunk is up to ~2k characters). */
export const MAX_CHAT_RETRIEVAL_K = 50;

/** How many chunks chat retrieves per question (CHAT_RETRIEVAL_K). A
 * hardware knob like serveCtxOverride(): a machine with plenty of VRAM can
 * afford a wider context, a small GPU cannot. Unset, empty, non-numeric or
 * out-of-range values fall back to the default rather than being clamped, so
 * a typo can never silently turn retrieval off (k=0) or flood the prompt.
 *
 * Raising it grows the prompt: raise OLLAMA_SERVE_CTX with it, and watch the
 * `nearCtxLimit` flag in the llm_timing app-log. */
export function chatRetrievalK(): number {
	const raw = nonEmpty(process.env.CHAT_RETRIEVAL_K);
	if (!raw) return DEFAULT_CHAT_RETRIEVAL_K;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 && n <= MAX_CHAT_RETRIEVAL_K ? n : DEFAULT_CHAT_RETRIEVAL_K;
}

export function chatsDbPath(): string {
	return nonEmpty(process.env.CHATS_DB_PATH) ?? path.join(dataDir(), 'chats.db');
}

export function skillsDir(): string {
	return nonEmpty(process.env.SKILLS_DIR) ?? path.join(dataDir(), 'skills');
}

export function providersPath(): string {
	return nonEmpty(process.env.PROVIDERS_PATH) ?? path.join(dataDir(), 'providers.json');
}

export function secretsPath(): string {
	return nonEmpty(process.env.SECRETS_PATH) ?? path.join(dataDir(), 'secrets.json');
}

/** F14-2 — where model-catalog.ts caches the OpenRouter/models.dev fetch (TTL'd, atomic write). */
export function modelCatalogPath(): string {
	return nonEmpty(process.env.MODEL_CATALOG_PATH) ?? path.join(dataDir(), 'model-catalog.json');
}

/** İ2 (Aşama 8) — provider-consent.ts's persisted "which cloud providers has
 * the user explicitly consented to send chat data to" set. */
export function providerConsentPath(): string {
	return nonEmpty(process.env.PROVIDER_CONSENT_PATH) ?? path.join(dataDir(), 'provider-consent.json');
}

/** F14-3 — a model whose catalog release date (or, failing that, its live `created` field) is older than
 * this many months is filtered out of the clean list. Closed by user decision at 12, adjustable. Unset,
 * empty, non-integer or non-positive values fall back to the default. */
export function modelMaxAgeMonths(): number {
	const raw = nonEmpty(process.env.MODEL_MAX_AGE_MONTHS);
	if (!raw) return 12;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : 12;
}

/** Set only when launched via the Tauri desktop build — spawn_sidecar()
 * (src-tauri/src/lib.rs) generates/DPAPI-unwraps a 32-byte key once per
 * launch and hands it through here, hex-encoded, since Node has no other
 * channel to that Rust code (it's a separate sidecar process, not the
 * webview — Tauri's own IPC bridge doesn't reach it). Absent under plain
 * `npm run dev` (no Tauri involved at all) or if DPAPI setup failed — both
 * treated as a normal, handled case by secrets.ts, not an error. */
export function secretsKeyHex(): string | undefined {
	return nonEmpty(process.env.SECRETS_KEY_HEX);
}

/**
 * Güvenlik sertleştirme — the packaged desktop build's per-launch session
 * token. spawn_sidecar() (src-tauri/src/lib.rs) generates a fresh 64-hex-char
 * token on every launch and hands it through this env var, the same way it
 * hands secretsKeyHex() through SECRETS_KEY_HEX — the sidecar has no other
 * channel from the Rust side. The webview's first navigation is
 * `http://127.0.0.1:{port}/?vc_session={token}`; hooks.server.ts's `handle`
 * turns that into a session cookie (see session-gate.ts) so every later
 * request from the SAME webview is recognized without the token sitting in
 * the address bar or browser history forever.
 *
 * Absent under plain `npm run dev`, `npm test`, and the MCP server (tsx,
 * never spawned by Rust) — hooks.server.ts must behave EXACTLY as before
 * this feature existed in that case: no cookie, no redirect, no 401, no
 * change at all. Read via nonEmpty() like every other accessor here (so a
 * literal empty string counts as "not configured"), but — unlike
 * chatRetrievalK() etc. — hooks.server.ts reads this ONCE at module load
 * into a top-level constant rather than per-request: the value cannot
 * change for the lifetime of this process (Rust sets it once, before spawn,
 * never afterwards), and re-reading process.env on every single request
 * (including every static asset) would be pure waste. Kept as a function
 * here anyway, matching this module's own contract, so a test can still
 * simulate "set" vs "unset" by mutating process.env before calling it.
 */
export function sessionToken(): string | undefined {
	return nonEmpty(process.env.VC_SESSION_TOKEN);
}
