import type { ProviderConfigEntry } from './config-store';

/**
 * A model id is provider-scoped data, not a universal name — see
 * config-store.ts's ProviderConfigEntry.defaultModel doc comment. Hop 0 is
 * always a correct (provider, model) pair (either the caller's explicit pin,
 * or the chain head when nothing was pinned), so its requested model is used
 * as-is. Every later hop is only reached because an earlier provider failed;
 * it gets asked for ITS OWN default model, never the failed provider's — and
 * if it has none configured, `null` tells the caller to skip it rather than
 * repeat the "ollama: model 'deepseek-flash' not found" bug this fixes.
 *
 * Split out of registry.ts (rather than defined there) purely so it stays
 * importable from a plain `node:test` run — registry.ts pulls in
 * `$env/dynamic/private`, which only resolves inside SvelteKit/Vite. See
 * registry.test.ts.
 *
 * `requestedModelApplies` (default true) is false when the caller's pin was
 * dropped (disabled / not consented / deleted): then `requestedModel` names a
 * model of the provider the user pinned (e.g. `qwen3:8b`), not of hop 0's
 * provider (the chain head), so hop 0 must resolve like any other hop — its
 * own defaultModel, or `null` to be skipped.
 */
export function resolveHopModel(
	hopIndex: number,
	entry: ProviderConfigEntry | undefined,
	requestedModel: string,
	requestedModelApplies = true
): string | null {
	if (hopIndex === 0 && requestedModelApplies) return requestedModel;
	return entry?.defaultModel ?? null;
}
