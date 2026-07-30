import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readProvidersFile } from '$lib/server/providers/config-store';
import { secretStore, maskKey } from '$lib/server/providers/secrets';
import type { ProviderStatus } from '$lib/types';

export const GET: RequestHandler = async () => {
	const { providers } = readProvidersFile();
	const connectedIds = new Set(await secretStore.list());

	const status: ProviderStatus[] = await Promise.all(
		providers.map(async (p) => {
			const needsKey = p.kind === 'openai-compat';
			const hasKey = needsKey && connectedIds.has(p.id);
			const key = hasKey ? await secretStore.get(p.id) : null;
			return {
				id: p.id,
				label: p.label,
				kind: p.kind,
				baseUrl: p.baseUrl,
				enabled: p.enabled,
				needsKey,
				keyStatus: hasKey ? 'connected' : 'none',
				mask: key ? maskKey(key) : null
			};
		})
	);

	return json(status);
};
