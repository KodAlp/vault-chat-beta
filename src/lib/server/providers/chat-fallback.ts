import { ProviderError, type ChatRequest, type Chunk, type ProviderAdapter, type ProviderErrorKind } from './types';
import { resolveHopModel } from './resolve-hop-model';
import type { ProviderConfigEntry } from './config-store';

export type FallbackEvent = Chunk | { type: 'notice'; message: string };

/**
 * Everything chatWithFallback needs from the outside world, injected —
 * split out of registry.ts for the same reason resolve-hop-model.ts was:
 * registry.ts imports $env/dynamic/private (for buildAdapter()'s
 * OLLAMA_URL), which only resolves inside a SvelteKit/Vite run, so nothing
 * that imports registry.ts can be exercised under plain `tsx --test` —
 * confirmed by resolve-hop-model.ts's own doc comment referencing a
 * "registry.test.ts" that was never actually possible to write. This file
 * has zero such imports (only types from ./types and ./config-store, both
 * type-only here), so chat-fallback.test.ts can run chatWithFallbackCore
 * against fake adapters/config with no real disk or network I/O at all.
 */
export interface ChatFallbackDeps {
	getChain(taskType: string): string[];
	/** registry.ts's providers.json "Etkin" toggle — see its own doc
	 * comment for why routing must actually honor this. */
	isProviderEnabled(providerId: string): boolean;
	getProviderEntry(providerId: string): ProviderConfigEntry | undefined;
	getAdapter(providerId: string): Promise<ProviderAdapter>;
	/** Real implementation (registry.ts) writes to data/app-log.jsonl — the
	 * core only needs "this fallback happened", not how it's recorded.
	 * `errorKind` lets a log reader tell a rate-limit skip apart from a
	 * timeout/outage skip without re-parsing `message` text. */
	logFallback(message: string, providerId: string, errorKind?: ProviderErrorKind): void;
}

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
 * - "Etkin" (isProviderEnabled) filters both the base chain AND a pin —
 *   disabling a provider must actually remove it from routing, not just
 *   hide it from pickers (see registry.ts's isProviderEnabled doc comment
 *   for the bug this fixes: "delete the provider" used to be the only
 *   action with routing consequences).
 *
 * `pinnedProviderId` (Faz 17 — providerId end-to-end) is the explicit
 * choice a user made (the chat header's selector, a settings.svelte.ts
 * default*Provider, or a *GenerationRequest.provider) rather than the
 * task's default chain. A pin is a CONSTRAINT, not a preference: only that
 * provider is tried, the task's chain is not consulted at all, and a
 * retryable failure from it surfaces to the caller as-is instead of
 * silently falling back to a different provider the user did not choose.
 * This was a routing-brief red-team finding (ROUTING-BRIEF.md §"pin vs
 * offline") — the previous "pin goes first, rest of the chain still runs
 * as fallback" behavior meant picking Ollama explicitly did not actually
 * guarantee Ollama would be used, which is exactly the bug İdeas.txt #2
 * reported. Only an ABSENT or disabled/deleted pin falls through to the
 * default chain (see the notice below) — once a pin is live, it is final.
 */
export async function* chatWithFallbackCore(
	deps: ChatFallbackDeps,
	taskType: string,
	req: ChatRequest,
	signal: AbortSignal,
	pinnedProviderId?: string
): AsyncGenerator<FallbackEvent> {
	const baseChain = deps.getChain(taskType).filter(deps.isProviderEnabled);
	const pin = pinnedProviderId && deps.isProviderEnabled(pinnedProviderId) ? pinnedProviderId : undefined;
	if (pinnedProviderId && !pin) {
		const message = `${pinnedProviderId} devre dışı → görev zinciri kullanılıyor`;
		deps.logFallback(message, pinnedProviderId);
		yield { type: 'notice', message };
	}
	const chain = pin ? [pin] : baseChain;
	if (chain.length === 0) {
		throw new Error(`"${taskType}" görev tipi için etkin bir provider zinciri yok`);
	}

	// The earliest REAL failure (a hop that actually ran and errored) — kept
	// so a chain that ends in a skipped hop (no defaultModel configured) can
	// still surface a meaningful error instead of a generic "nothing worked".
	let firstError: unknown;

	for (let i = 0; i < chain.length; i++) {
		const providerId = chain[i];
		const isLast = i === chain.length - 1;
		const model = resolveHopModel(i, deps.getProviderEntry(providerId), req.model);

		if (model === null) {
			const message = `${providerId} için varsayılan model tanımlı değil → atlanıyor`;
			deps.logFallback(message, providerId);
			yield { type: 'notice', message };
			if (isLast) throw firstError ?? new Error(`"${taskType}" için hiçbir sağlayıcıda model çözülemedi`);
			continue;
		}

		const hopReq = i === 0 ? req : { ...req, model };
		let sawText = false;
		try {
			// getAdapter() inside the try, not above it: a pinned-but-since-
			// deleted provider id throws a plain "Bilinmeyen provider" Error
			// here, and that used to escape the whole generator with no
			// fallback at all — isProviderEnabled's pin check above can't
			// catch this case, since a deleted provider is just as absent
			// from providers.json as a merely-unknown one.
			const adapter = await deps.getAdapter(providerId);
			for await (const chunk of adapter.chat(hopReq, signal)) {
				if (chunk.type === 'text') sawText = true;
				yield chunk;
			}
			return;
		} catch (err) {
			if (signal.aborted) throw err;
			if (sawText) throw err;
			if (err instanceof ProviderError && !err.retryable) throw err;

			firstError ??= err;
			if (isLast) throw err;

			const errorKind = err instanceof ProviderError ? err.kind : undefined;
			const nextLabel = deps.getProviderEntry(chain[i + 1])?.label ?? chain[i + 1];
			const message =
				errorKind === 'http_429'
					? `${deps.getProviderEntry(providerId)?.label ?? providerId} hız sınırına takıldı → ${nextLabel}'a geçiliyor`
					: `${providerId} kullanılamıyor (${errorKind ?? 'error'}) → sıradaki modele geçiliyor`;
			deps.logFallback(message, providerId, errorKind);
			yield { type: 'notice', message };
		}
	}
}
