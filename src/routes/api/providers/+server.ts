import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addProvider, deleteProvider, readProvidersFile, DEFAULT_OLLAMA_BASE_URL, type NewProviderInput } from '$lib/server/providers/config-store';
import { secretStore, maskKey } from '$lib/server/providers/secrets';
import { getRateLimitInfo } from '$lib/server/providers/registry';
import { getLastProviderErrors } from '$lib/server/app-log';
import { getEmbeddingConfig } from '$lib/server/providers/config-store';
import type { ProviderStatus } from '$lib/types';
import { AppError, fail, toCodedError } from '$lib/server/app-error';
import type { ErrorCode } from '$lib/errors';

export const GET: RequestHandler = async () => {
	const { providers } = readProvidersFile();
	// A locked secret store (L2) must not take the whole providers page down —
	// the settings banner explains it; every provider just shows "no key".
	const connectedIds = new Set(
		await secretStore.list().catch((err: unknown) => {
			if (err instanceof AppError && err.code === 'SECRETS_LOCKED') return [] as string[];
			throw err;
		})
	);
	const lastErrors = getLastProviderErrors();
	// Which provider actually does embedding is now a config
	// choice (GET/PUT /api/embedding), not always 'ollama' — see
	// mapToStatus's embedModel field below.
	const embeddingConfig = getEmbeddingConfig();

	const status: ProviderStatus[] = await Promise.all(
		providers.map(async (p) => {
			const needsKey = p.kind !== 'ollama';
			const hasKey = needsKey && connectedIds.has(p.id);
			const key = hasKey ? await secretStore.get(p.id) : null;
			return mapToStatus(p, hasKey, key, lastErrors[p.id], embeddingConfig);
		})
	);

	return json(status);
};

function mapToStatus(
	p: {
		id: string;
		label: string;
		baseUrl: string;
		kind: 'ollama' | 'openai-compat' | 'anthropic' | 'azure-openai';
		enabled: boolean;
		defaultModel?: string;
		local?: boolean;
	},
	hasKey: boolean,
	key: string | null,
	lastError: { ts: string; kind: string } | undefined,
	embeddingConfig: { providerId: string; model: string } | null
): ProviderStatus {
	return {
		id: p.id,
		label: p.label,
		kind: p.kind,
		baseUrl: p.baseUrl,
		enabled: p.enabled,
		local: p.kind === 'ollama' || p.local === true,
		needsKey: p.kind !== 'ollama',
		keyStatus: hasKey ? 'connected' : 'none',
		mask: key ? maskKey(key) : null,
		defaultModel: p.defaultModel ?? null,
		// Attached to whichever provider is actually CONFIGURED for
		// embedding (getEmbeddingConfig().providerId), not hardcoded to
		// 'ollama': embedding can now be an openai-compat provider instead.
		// Every other provider gets null.
		embedModel: embeddingConfig && p.id === embeddingConfig.providerId ? embeddingConfig.model : null,
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
	const kind =
		body?.kind === 'anthropic' || body?.kind === 'azure-openai' || body?.kind === 'ollama' ? body.kind : 'openai-compat';
	// An Ollama provider needs no base URL typed in — the native default is used when it is left blank.
	const baseUrl = body?.baseUrl?.trim() || (kind === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : '');
	if (!body?.label?.trim() || !baseUrl) {
		fail('VALIDATION_REQUIRED_ALL', { fields: "'label', 'baseUrl'" });
	}
	const reasoningDialect =
		body.reasoningDialect === 'think-tags' || body.reasoningDialect === 'none'
			? (body.reasoningDialect as 'think-tags' | 'none')
			: 'reasoning_content';
	try {
		const entry = addProvider({ label: body.label, baseUrl, kind, reasoningDialect, local: body.local === true });
		return json(entry, { status: 201 });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { id?: string } | null;
	if (!body?.id) fail('VALIDATION_REQUIRED', { field: 'id' });
	try {
		deleteProvider(body.id);
		return json({ ok: true });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		const coded = toCodedError(err);
		fail(coded.code as ErrorCode, coded.params, 400);
	}
};
