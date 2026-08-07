import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { addProvider, deleteProvider, readProvidersFile, type NewProviderInput } from '$lib/server/providers/config-store';
import { secretStore, maskKey } from '$lib/server/providers/secrets';
import type { ProviderStatus } from '$lib/types';

export const GET: RequestHandler = async () => {
	const { providers } = readProvidersFile();
	const connectedIds = new Set(await secretStore.list());

	const status: ProviderStatus[] = await Promise.all(
		providers.map(async (p) => {
			const needsKey = p.kind !== 'ollama';
			const hasKey = needsKey && connectedIds.has(p.id);
			const key = hasKey ? await secretStore.get(p.id) : null;
			return mapToStatus(p, hasKey, key);
		})
	);

	return json(status);
};

function mapToStatus(p: {
	id: string;
	label: string;
	baseUrl: string;
	kind: 'ollama' | 'openai-compat' | 'anthropic';
	enabled: boolean;
}, hasKey: boolean, key: string | null): ProviderStatus {
	return {
		id: p.id,
		label: p.label,
		kind: p.kind,
		baseUrl: p.baseUrl,
		enabled: p.enabled,
		needsKey: p.kind !== 'ollama',
		keyStatus: hasKey ? 'connected' : 'none',
		mask: key ? maskKey(key) : null
	};
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
