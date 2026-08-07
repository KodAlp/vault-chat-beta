import fs from 'node:fs';
import { env } from '$env/dynamic/private';
import { providersPath } from '../env';
import { OllamaAdapter } from './ollama';
import { OpenAICompatAdapter } from './openai-compat';
import { AnthropicAdapter } from './anthropic';
import { secretStore } from './secrets';
import { readProvidersFile, type ProviderConfigEntry, type ProvidersFile } from './config-store';
import { ProviderError, type ChatRequest, type Chunk, type ProviderAdapter } from './types';
import { logAppEvent } from '../app-log';

let cachedMtime = -1;
let cachedConfig: ProvidersFile | null = null;
let adapters = new Map<string, ProviderAdapter>();

/** mtime-cached like userSkills.ts's loader — cheap stat beats a watcher,
 * and resets the instantiated-adapter cache whenever the file actually
 * changes (e.g. a key was just added via the settings UI, see
 * config-store.ts's writers). */
function loadConfig(): ProvidersFile {
	const p = providersPath();
	const stat = fs.statSync(p);
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

export function getChain(taskType: string): string[] {
	return loadConfig().chains[taskType] ?? [];
}

export function listEnabledProviders(): ProviderConfigEntry[] {
	return loadConfig().providers.filter((p) => p.enabled);
}

export type FallbackEvent = Chunk | { type: 'notice'; message: string };

/**
 * Walks a task's provider chain per the skill's fallback policy:
 * - Failure BEFORE the first `text` chunk → abort, try the next provider,
 *   surface a `notice` the caller can render inline.
 * - Failure AFTER the first `text` chunk → stop. Never splice a partial
 *   answer from one provider onto another's continuation.
 * - A genuine caller-initiated abort (signal.aborted) is never treated as
 *   a failure to fall back from — it propagates as-is.
 * - A NON-retryable failure (auth, bad_request, context_length) never falls
 *   back either, regardless of chain position: a wrong API key or an
 *   oversized prompt will fail identically on the next provider, and the
 *   user needs to see the real cause immediately, not a masked provider
 *   switch (skill's "no silent switching after first token" rule extends to
 *   "no silent switching on a non-retryable error at all").
 */
export async function* chatWithFallback(
	taskType: string,
	req: ChatRequest,
	signal: AbortSignal
): AsyncGenerator<FallbackEvent> {
	const chain = getChain(taskType);
	if (chain.length === 0) {
		throw new Error(`"${taskType}" görev tipi için tanımlı provider zinciri yok`);
	}

	for (let i = 0; i < chain.length; i++) {
		const providerId = chain[i];
		const adapter = await getAdapter(providerId);
		let sawText = false;
		try {
			for await (const chunk of adapter.chat(req, signal)) {
				if (chunk.type === 'text') sawText = true;
				yield chunk;
			}
			return;
		} catch (err) {
			if (signal.aborted) throw err;
			if (sawText) throw err;
			if (err instanceof ProviderError && !err.retryable) throw err;

			const isLast = i === chain.length - 1;
			if (isLast) throw err;

			const reason = err instanceof ProviderError ? err.kind : 'error';
			const message = `${providerId} kullanılamıyor (${reason}) → sıradaki modele geçiliyor`;
			logAppEvent({ kind: 'fallback', provider: providerId, message });
			yield { type: 'notice', message };
		}
	}
}
