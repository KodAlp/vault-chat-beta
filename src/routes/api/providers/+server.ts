import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addProvider, deleteProvider, readProvidersFile, type NewProviderInput } from '$lib/server/providers/config-store';
import { secretStore, maskKey } from '$lib/server/providers/secrets';
import { getRateLimitInfo } from '$lib/server/providers/registry';
import { getLastProviderErrors } from '$lib/server/app-log';
import { EMBED_MODEL } from '$lib/server/embed-config';
import type { ProviderStatus } from '$lib/types';

export const GET: RequestHandler = async () => {
	const { providers } = readProvidersFile();
	const connectedIds = new Set(await secretStore.list());
	const lastErrors = getLastProviderErrors();

	const status: ProviderStatus[] = await Promise.all(
		providers.map(async (p) => {
			const needsKey = p.kind !== 'ollama';
			const hasKey = needsKey && connectedIds.has(p.id);
			const key = hasKey ? await secretStore.get(p.id) : null;
			return mapToStatus(p, hasKey, key, lastErrors[p.id]);
		})
	);

	return json(status);
};

function mapToStatus(
	p: {
		id: string;
		label: string;
		baseUrl: string;
		kind: 'ollama' | 'openai-compat' | 'anthropic';
		enabled: boolean;
		defaultModel?: string;
	},
	hasKey: boolean,
	key: string | null,
	lastError: { ts: string; kind: string } | undefined
): ProviderStatus {
	return {
		id: p.id,
		label: p.label,
		kind: p.kind,
		baseUrl: p.baseUrl,
		enabled: p.enabled,
		needsKey: p.kind !== 'ollama',
		keyStatus: hasKey ? 'connected' : 'none',
		mask: key ? maskKey(key) : null,
		defaultModel: p.defaultModel ?? null,
		// Embedding always runs through Ollama regardless of which provider
		// handles chat — attached only to the ollama entry, not a per-
		// provider concept, so every other kind gets null.
		embedModel: p.kind === 'ollama' ? EMBED_MODEL : null,
		rateLimit: rateLimitFor(p.id, lastError)
	};
}

function rateLimitFor(
	providerId: string,
	lastError: { ts: string; kind: string } | undefined
): ProviderStatus['rateLimit'] {
	const live = getRateLimitInfo(providerId);
	if (live) {
		return {
			source: 'live',
			remainingRequests: live.remainingRequests,
			limitRequests: live.limitRequests,
			resetRequestsAt: live.resetRequestsAt,
			remainingTokens: live.remainingTokens,
			limitTokens: live.limitTokens,
			resetTokensAt: live.resetTokensAt,
			lastHitAt: live.retryAfterAt
		};
	}
	if (lastError?.kind === 'http_429') {
		return { source: 'log', lastHitAt: lastError.ts };
	}
	return null;
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Partial<NewProviderInput> | null;
	if (!body?.label?.trim() || !body?.baseUrl?.trim()) {
		return json({ error: 'label ve baseUrl gerekli' }, { status: 400 });
	}
	const kind = body.kind === 'anthropic' ? 'anthropic' : 'openai-compat';
	const reasoningDialect =
		body.reasoningDialect === 'think-tags' || body.reasoningDialect === 'none'
			? (body.reasoningDialect as 'think-tags' | 'none')
			: 'reasoning_content';
	try {
		const entry = addProvider({ label: body.label, baseUrl: body.baseUrl, kind, reasoningDialect });
		return json(entry, { status: 201 });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Provider eklenemedi' }, { status: 400 });
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { id?: string } | null;
	if (!body?.id) return json({ error: 'id gerekli' }, { status: 400 });
	try {
		deleteProvider(body.id);
		return json({ ok: true });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Provider silinemedi' }, { status: 400 });
	}
};
