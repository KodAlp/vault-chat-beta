import type { ModelInfo } from './types';

/**
 * What this app knows about a model FAMILY (context window, tool-calling / reasoning support,
 * embedding-only, verified prefix-resume), moved out of ollama.ts so every provider kind shares one table
 * instead of only OllamaAdapter having it. Pure and dependency-free (types only) so it runs under plain
 * `tsx --test`.
 *
 * Lookup is by PREFIX of a normalized model id (see normalizeModelId): the same family is spelled
 * differently by each server — Ollama `qwen3:8b`, llama.cpp `Qwen3-8B-Q4_K_M.gguf` or a path like
 * `C:\models\qwen3-8b.gguf`, LM Studio `qwen/qwen3-8b`, vLLM `Qwen/Qwen3-8B`, OpenRouter
 * `qwen/qwen3-30b-a3b:free` — and all of them must land on the same entry.
 */

/** A per-model, user-set override of the table's capability flags (providers.json `modelCaps`). A flag that
 * is absent falls through to the table. */
export interface ModelCapsOverride {
	tools?: boolean;
	reasoning?: boolean;
}

export interface FamilyInfo {
	ctx: number;
	caps: { tools: boolean; reasoning: boolean };
	/** What the Ollama adapter actually requests via options.num_ctx — an OLLAMA-ONLY concern (no other
	 * provider reads it; a llama.cpp/LM Studio server fixes its own window at load time). Defaults to `ctx`
	 * when omitted (a model with no reason to cap below its real max). */
	serveCtx?: number;
	/** See ModelInfo.embeddingOnly — marks a family as unusable for chat. */
	embeddingOnly?: boolean;
	/** The family was VERIFIED to continue a partial answer from a trailing assistant message (see
	 * resume-plan.ts for what was measured). Set only for families that were actually tried, and only
	 * honored for Ollama (registry.supportsPrefixResume fails closed for everything else). */
	prefixResume?: boolean;
}

/** Keys are in NORMALIZED form (lowercase, `-` as the only separator — see normalizeModelId). */
const MODEL_FAMILY_TABLE: Record<string, FamilyInfo> = {
	// 40960 is qwen3:8b's real max. serveCtx is what we actually ask Ollama to
	// allocate, and on a 6 GB card it is a VRAM decision, not a headroom one.
	//
	// Measured 2026-09-20, RTX 4050 Laptop 6 GB, Ollama 0.32.5, qwen3:8b Q4_K_M
	// (Ollama budgets ~4.5 GiB of the card; the weights alone exceed that, so
	// 100% GPU is unreachable at ANY num_ctx — the question is how many layers
	// the KV cache leaves room for):
	//   16384, f16 KV        → 20/37 layers on GPU, 54% GPU,  7.2 tok/s decode
	//   16384, FA + q8_0 KV  → 23/37 layers,        62% GPU,  9.0 tok/s
	//    8192, FA + q8_0 KV  →                      70% GPU, 12.4 tok/s
	//    6144, FA + q8_0 KV  →                      70% GPU, 12.5 tok/s  (no gain over 8192)
	//    4096, FA + q8_0 KV  →                      73% GPU, 13.3 tok/s  (too tight, see below)
	// 8192 is the knee: everything below it buys <8% decode speed but risks
	// silent front-truncation of the system prompt (the failure that created
	// this table — 2 of 6 turns lost at Ollama's 4096 default). It only holds if
	// the prompt stays well under 8192; api/chat/+server.ts's CHAT_K keeps the
	// retrieved <context> small enough, and the llm_timing app-log records
	// nearCtxLimit so a violation is visible rather than silent.
	qwen3: { ctx: 40960, serveCtx: 8192, caps: { tools: true, reasoning: true }, prefixResume: true },
	// Longer key than 'qwen3' — wins the longest-prefix match, so the embedding variant is never mistaken
	// for the chat family it shares a prefix with.
	'qwen3-embedding': { ctx: 32768, caps: { tools: false, reasoning: false }, embeddingOnly: true },
	'nomic-embed-text': { ctx: 2048, caps: { tools: false, reasoning: false }, embeddingOnly: true },
	// EMBED_MODEL (embed-config.ts) — Ollama's /api/tags lists it right next
	// to chat models with no way to tell them apart otherwise, and picking
	// it in a chat/generation model selector silently fails (no chat
	// template). See the bge-m3 bug report this table entry fixes.
	'bge-m3': { ctx: 8192, caps: { tools: false, reasoning: false }, embeddingOnly: true }
};

const DEFAULT_CAPS = { tools: false, reasoning: false };
const DEFAULT_MODEL_INFO = { ctx: 8192, caps: DEFAULT_CAPS };
const EMBEDDING_ONLY_FALLBACK: FamilyInfo = { ctx: 8192, caps: DEFAULT_CAPS, embeddingOnly: true };

/**
 * One canonical spelling for a model id coming from any server, for the prefix lookup only (callers keep
 * and display the original id):
 *  - lowercase;
 *  - backslashes become `/`, then everything up to the last `/` is dropped (a file path, an org prefix
 *    `qwen/`, `hf.co/Qwen/...`, Ollama's `library/`);
 *  - a trailing `.gguf` is dropped;
 *  - `_` and `:` become `-`, so `Q4_K_M`, `qwen3:8b` and `qwen3-8b` agree and a prefix can end at a `-`.
 *
 * Deliberately NOT stripped: version dots (`qwen2.5` stays `qwen2.5`, which does not start with `qwen3`),
 * quantization and tag suffixes (harmless to a prefix lookup).
 */
export function normalizeModelId(id: string): string {
	let s = id.trim().toLowerCase().replace(/\\/g, '/');
	s = s.slice(s.lastIndexOf('/') + 1);
	s = s.replace(/\.gguf$/, '');
	return s.replace(/[_:]/g, '-');
}

/** Embedding models the table has no entry for: `nomic-embed-text-v1.5`, `mxbai-embed-large`,
 * `text-embedding-3-small`, `snowflake-arctic-embed`, `jina-embeddings-v3` all contain "embed"; the
 * BAAI/Alibaba/E5 families name theirs `bge-*`, `gte-*`, `e5-*`. Applied to the normalized id. */
function looksLikeEmbeddingModel(normalized: string): boolean {
	return normalized.includes('embed') || /^(bge|gte|e5)-/.test(normalized);
}

/** The table entry for the longest family key that prefixes the normalized id, if any. */
export function lookupFamily(id: string): FamilyInfo | undefined {
	const n = normalizeModelId(id);
	let best: string | undefined;
	for (const key of Object.keys(MODEL_FAMILY_TABLE)) {
		if (n.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
	}
	return best ? MODEL_FAMILY_TABLE[best] : undefined;
}

function resolveFamily(id: string): FamilyInfo | undefined {
	const family = lookupFamily(id);
	if (family) return family;
	return looksLikeEmbeddingModel(normalizeModelId(id)) ? EMBEDDING_ONLY_FALLBACK : undefined;
}

/** Table capability flags with the user's per-model override applied (override wins, flag by flag). */
export function capsFor(id: string, override?: ModelCapsOverride): { tools: boolean; reasoning: boolean } {
	const base = resolveFamily(id)?.caps ?? DEFAULT_CAPS;
	return {
		tools: override?.tools ?? base.tools,
		reasoning: override?.reasoning ?? base.reasoning
	};
}

/** True when the id is an embedding-only model (never offered in chat pickers). */
export function isEmbeddingOnly(id: string): boolean {
	return resolveFamily(id)?.embeddingOnly === true;
}

/** Full ModelInfo for the Ollama adapter — keeps the table's extra fields (serveCtx, prefixResume) on the
 * object exactly as ollama.ts always did. */
export function modelInfoFor(id: string, override?: ModelCapsOverride): ModelInfo {
	const info = resolveFamily(id) ?? DEFAULT_MODEL_INFO;
	return { id, ...info, caps: capsFor(id, override) };
}

/** What a generic OpenAI-compatible server's /models entry can be enriched with: capability flags and the
 * embedding-only marker. ctx stays the caller's placeholder — the table's windows describe the model's
 * maximum, not what a local server loaded it with. */
export function compatModelExtras(
	id: string,
	override?: ModelCapsOverride
): { caps: { tools: boolean; reasoning: boolean }; embeddingOnly?: true } {
	return { caps: capsFor(id, override), ...(isEmbeddingOnly(id) ? { embeddingOnly: true as const } : {}) };
}
