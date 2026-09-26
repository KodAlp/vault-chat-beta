import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readProvidersFile } from '$lib/server/providers/config-store';
import { grantProviderConsent, revokeProviderConsent } from '$lib/server/provider-consent';
import { fail } from '$lib/server/app-error';

/** İ2 (Aşama 8) — the model picker's first-use confirmation (ModelPickerRow,
 * GenerationDialog) POSTs here the moment the user accepts sending chat data
 * to a cloud provider; the settings page's own provider card can DELETE to
 * revoke it later. Ollama has no consent state to grant at all (see
 * provider-consent.ts's own doc comment) — a client asking for it here is a
 * bug in that client, not a state worth silently accepting. */
function assertCloudProvider(id: string): void {
	const entry = readProvidersFile().providers.find((p) => p.id === id);
	if (!entry) fail('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	if (entry.kind === 'ollama') fail('PROVIDER_CONSENT_NOT_NEEDED');
}

export const POST: RequestHandler = async ({ params }) => {
	assertCloudProvider(params.id);
	grantProviderConsent(params.id);
	return json({ id: params.id, consented: true });
};

export const DELETE: RequestHandler = async ({ params }) => {
	assertCloudProvider(params.id);
	revokeProviderConsent(params.id);
	return json({ id: params.id, consented: false });
};
