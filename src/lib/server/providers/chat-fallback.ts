import { ProviderError, type ChatRequest, type Chunk, type ProviderAdapter, type ProviderErrorKind } from './types';
import { resolveHopModel } from './resolve-hop-model';
import type { ProviderConfigEntry } from './config-store';
import { AppError } from '../app-error';
import type { ErrorParams } from '../../errors';

/** `message` stays a human-readable (Turkish, log-friendly) string — it is
 * what api/chat/+server.ts's own `logAppEvent({kind:'fallback', ...})` call
 * records — while `code`/`params` are what the client actually renders
 * (see server-error.ts's localizeError). Every yield below sets both. */
export type FallbackEvent =
	| Chunk
	| { type: 'notice'; message: string; code?: string; params?: ErrorParams };

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
	/** İ2 (Aşama 8, 2026-09-23): true for Ollama always (local, nothing
	 * ever leaves the device) — for a cloud provider, true only once the
	 * user has explicitly consented via the model picker's first-use
	 * prompt (provider-consent.ts). Filtered exactly like isProviderEnabled
	 * — both the base chain AND a pin — so a provider the user has not
	 * consented to can never be reached even as a silent chain fallback,
	 * not just when explicitly pinned. The client is expected to gate
	 * provider selection with the same prompt before ever sending a
	 * request; this is the server-side backstop, not the primary UX. */
	isProviderConsented(providerId: string): boolean;
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
	const baseChain = deps.getChain(taskType).filter(deps.isProviderEnabled).filter(deps.isProviderConsented);
	const pinEnabled = pinnedProviderId ? deps.isProviderEnabled(pinnedProviderId) : false;
	const pinConsented = pinnedProviderId ? deps.isProviderConsented(pinnedProviderId) : false;
	const pin = pinEnabled && pinConsented ? pinnedProviderId : undefined;
	if (pinnedProviderId && !pin) {
		// `reason` is a code-ish token, not prose — the client resolves it to
		// localized text itself (Chat.fallbackReason_<reason>) before handing
		// the whole notice to formatCodedError, same as NOT_FOUND's `entity`.
		const reason: 'disabled' | 'not_consented' = !pinEnabled ? 'disabled' : 'not_consented';
		const logReason = reason === 'disabled' ? 'devre dışı' : 'henüz onaylanmadı';
		const message = `${pinnedProviderId} ${logReason} → görev zinciri kullanılıyor`;
		deps.logFallback(message, pinnedProviderId);
		yield {
			type: 'notice',
			message,
			code: 'CHAT_FALLBACK_PINNED_UNAVAILABLE',
			params: { provider: pinnedProviderId, reason }
		};
	}
	const chain = pin ? [pin] : baseChain;
	if (chain.length === 0) {
		throw new AppError('CHAT_NO_CHAIN', { taskType });
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
			// A continuation request is only valid against the provider that wrote the
			// partial answer; skipping to another one is not an option.
			if (req.continuation) throw firstError ?? new AppError('CHAT_CONTINUATION_UNAVAILABLE', { taskType });
			const message = `${providerId} için varsayılan model tanımlı değil → atlanıyor`;
			deps.logFallback(message, providerId);
			yield {
				type: 'notice',
				message,
				code: 'CHAT_FALLBACK_NO_DEFAULT_MODEL',
				params: { provider: providerId }
			};
			if (isLast) throw firstError ?? new AppError('CHAT_NO_MODEL_RESOLVED', { taskType });
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
			// A continuation must not hop: the next provider would read the partial
			// answer as a finished earlier turn and answer from scratch (see
			// ChatRequest.continuation). The caller falls back to a full restart.
			if (req.continuation) throw err;

			firstError ??= err;
			if (isLast) throw err;

			const errorKind = err instanceof ProviderError ? err.kind : undefined;
			const providerLabel = deps.getProviderEntry(providerId)?.label ?? providerId;
			const nextLabel = deps.getProviderEntry(chain[i + 1])?.label ?? chain[i + 1];
			if (errorKind === 'http_429') {
				const message = `${providerLabel} hız sınırına takıldı → ${nextLabel}'a geçiliyor`;
				deps.logFallback(message, providerId, errorKind);
				yield {
					type: 'notice',
					message,
					code: 'CHAT_FALLBACK_RATE_LIMITED',
					params: { from: providerLabel, to: nextLabel }
				};
			} else {
				const message = `${providerId} kullanılamıyor (${errorKind ?? 'error'}) → sıradaki modele geçiliyor`;
				deps.logFallback(message, providerId, errorKind);
				yield {
					type: 'notice',
					message,
					code: 'CHAT_FALLBACK_UNAVAILABLE',
					params: { provider: providerId, kind: errorKind ?? 'error' }
				};
			}
		}
	}
}
