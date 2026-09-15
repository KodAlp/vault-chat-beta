import fs from 'node:fs';
import { env } from '$env/dynamic/private';
import { providersPath } from '../env';
import { OllamaAdapter } from './ollama';
import { OpenAICompatAdapter } from './openai-compat';
import { AnthropicAdapter } from './anthropic';
import { secretStore } from './secrets';
import { readProvidersFile, type ProviderConfigEntry, type ProvidersFile } from './config-store';
import type { ChatRequest, ProviderAdapter, RateLimitSnapshot } from './types';
import { logAppEvent } from '../app-log';
import { chatWithFallbackCore, type FallbackEvent } from './chat-fallback';

let cachedMtime = -1;
let cachedConfig: ProvidersFile | null = null;
let adapters = new Map<string, ProviderAdapter>();

/** mtime-cached like userSkills.ts's loader — cheap stat beats a watcher,
 * and resets the instantiated-adapter cache whenever the file actually
 * changes (e.g. a key was just added via the settings UI, see
 * config-store.ts's writers). */
function loadConfig(): ProvidersFile {
	const p = providersPath();
	let stat: fs.Stats;
	try {
		stat = fs.statSync(p);
	} catch (err) {
		// fs.statSync's raw ENOENT ("ENOENT: no such file or directory,
		// stat 'C:\...\providers.json'") reached every chat/generation call
		// as an unexplained 500 if this file was ever missing (a DATA_DIR
		// override pointing nowhere, the file deleted by hand) — nothing
		// seeds it at runtime outside the Tauri desktop build. This at
		// least says which file and why, instead of a bare stat failure.
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`providers.json okunamadı (${p}): ${reason}`);
	}
	if (cachedConfig && stat.mtimeMs === cachedMtime) return cachedConfig;
	cachedConfig = readProvidersFile();
	cachedMtime = stat.mtimeMs;
	adapters = new Map();
	return cachedConfig;
}

async function buildAdapter(entry: ProviderConfigEntry): Promise<ProviderAdapter> {
	if (entry.kind === 'ollama') {
		// OLLAMA_URL env stays the live override point (matches the existing
		// .env-driven customization apps already relies on) — providers.json's
		// baseUrl is the default when it's unset.
		return new OllamaAdapter(entry.id, env.OLLAMA_URL ?? entry.baseUrl, entry.timeouts);
	}
	const apiKey = await secretStore.get(entry.id);
	if (entry.kind === 'anthropic') {
		return new AnthropicAdapter({
			id: entry.id,
			apiKey,
			timeouts: entry.timeouts
		});
	}
	return new OpenAICompatAdapter({
		id: entry.id,
		baseUrl: entry.baseUrl,
		apiKey,
		reasoningDialect: entry.reasoningDialect,
		timeouts: entry.timeouts
	});
}

export async function getAdapter(providerId: string): Promise<ProviderAdapter> {
	loadConfig();
	const cached = adapters.get(providerId);
	if (cached) return cached;

	const entry = cachedConfig!.providers.find((p) => p.id === providerId);
	if (!entry) throw new Error(`Bilinmeyen provider: ${providerId}`);
	const adapter = await buildAdapter(entry);
	adapters.set(providerId, adapter);
	return adapter;
}

/** Called by the settings UI's key save/delete endpoint. secrets.json is a
 * separate file from providers.json, so loadConfig()'s providers.json-mtime
 * cache never notices a key change — without this, a freshly saved (or
 * removed) API key kept being served by an adapter instance built from the
 * OLD key until providers.json happened to change for an unrelated reason,
 * or the process restarted. */
export function invalidateAdapter(providerId: string): void {
	adapters.delete(providerId);
}

/** Live rate-limit snapshot from the provider's own headers — only available
 * once an adapter for this id has actually been built (i.e. at least one
 * request was made since the process started or the key last changed).
 * Never builds an adapter just to check this — a provider nobody has
 * talked to yet has no live data, and that's a fine, expected null rather
 * than something worth constructing an adapter over. */
export function getRateLimitInfo(providerId: string): RateLimitSnapshot | null {
	loadConfig();
	return adapters.get(providerId)?.getRateLimitInfo?.() ?? null;
}

export function getChain(taskType: string): string[] {
	return loadConfig().chains[taskType] ?? [];
}

/** providers.json's per-provider "Etkin" toggle. Previously read by nothing
 * in this file at all — only listEnabledProviders() below consulted it, and
 * that function's one caller populates model PICKERS, not routing. So
 * disabling a provider hid it from dropdowns while leaving it fully live in
 * every chain; deleteProvider() was the only action that actually removed a
 * provider from routing, which is why "delete the API provider" was the
 * only reliable way to force generation back onto Ollama. chatWithFallback
 * below now filters both the task chain and a pin through this. */
function isProviderEnabled(providerId: string): boolean {
	return getProviderEntry(providerId)?.enabled === true;
}

export function listEnabledProviders(): ProviderConfigEntry[] {
	return loadConfig().providers.filter((p) => p.enabled);
}

function getProviderEntry(providerId: string): ProviderConfigEntry | undefined {
	return loadConfig().providers.find((p) => p.id === providerId);
}

export type { FallbackEvent };

/**
 * The chat route's single gating check for whether it's safe to attach
 * tools to a request: only OllamaAdapter actually implements tool-calling
 * today (see ollama.ts's capsFor — a pure, synchronous lookup, no network
 * call). Every other adapter (cloud OpenAI-compat, Anthropic) has no
 * tool_calls wiring exercised in its wire-format mapping yet, so this
 * fails closed to {tools:false} for them rather than risk a false
 * positive — see the folder-skill plan's "v1 is effectively Ollama-only"
 * scoping note. Never throws; any resolution failure (unknown provider,
 * disk read error) is just "no tools available", same as a real false.
 */
export async function modelCaps(
	pinnedProviderId: string | undefined,
	model: string
): Promise<{ tools: boolean; reasoning: boolean }> {
	try {
		const providerId = pinnedProviderId ?? getChain('chat').find(isProviderEnabled) ?? getChain('chat')[0];
		if (!providerId) return { tools: false, reasoning: false };
		const adapter = await getAdapter(providerId);
		if (adapter instanceof OllamaAdapter) return adapter.capsFor(model);
		return { tools: false, reasoning: false };
	} catch {
		return { tools: false, reasoning: false };
	}
}

/**
 * Thin wrapper: supplies chatWithFallbackCore (chat-fallback.ts) with this
 * module's real, side-effecting implementations — disk-backed config
 * (getChain/isProviderEnabled/getProviderEntry), real adapter construction
 * (getAdapter), and the real app-log write (logFallback). The entire
 * routing policy (pin semantics, "enabled" filtering, no-splice, non-
 * retryable-never-falls-back, skipped-hop handling) lives in that file's
 * doc comment and is exercised by chat-fallback.test.ts against fakes —
 * nothing here needs its own tests beyond "does it wire the real things
 * through", since none of this module is importable under plain
 * `tsx --test` (see chat-fallback.ts's own doc comment for why).
 */
export function chatWithFallback(
	taskType: string,
	req: ChatRequest,
	signal: AbortSignal,
	pinnedProviderId?: string
): AsyncGenerator<FallbackEvent> {
	return chatWithFallbackCore(
		{
			getChain,
			isProviderEnabled,
			getProviderEntry,
			getAdapter,
			logFallback: (message, providerId, errorKind) =>
				logAppEvent({ kind: 'fallback', provider: providerId, message, errorKind })
		},
		taskType,
		req,
		signal,
		pinnedProviderId
	);
}
