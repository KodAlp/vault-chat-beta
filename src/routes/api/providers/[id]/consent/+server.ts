import type { RequestHandler } from './$types';
import { isCloud, readProvidersFile } from '#lib/server/providers/config-store.js';
import { grantProviderConsent, revokeProviderConsent } from '#lib/server/provider-consent.js';
import { fail } from '#lib/server/app-error.js';

/** The model picker's first-use confirmation (ModelPickerRow,
 * GenerationDialog) POSTs here the moment the user accepts sending chat data
 * to a cloud provider; the settings page's own provider card can DELETE to
 * revoke it later. Ollama, and (problem A) a provider the user marked
 * `local`, have no consent state to grant at all (see provider-consent.ts's
 * own doc comment, and config-store.ts's isCloud()) — a client asking for
 * it here is a bug in that client, not a state worth silently accepting. */
function assertCloudProvider(id: string): void {
	const entry = readProvidersFile().providers.find((p) => p.id === id);
	if (!entry) fail('NOT_FOUND', { entity: 'provider', detail: id }, 404);
	if (!isCloud(entry)) fail('PROVIDER_CONSENT_NOT_NEEDED');
}

export const POST: RequestHandler = async ({ params }) => {
	assertCloudProvider(params.id);
	grantProviderConsent(params.id);
	return Response.json({ id: params.id, consented: true });
};

export const DELETE: RequestHandler = async ({ params }) => {
	assertCloudProvider(params.id);
	revokeProviderConsent(params.id);
	return Response.json({ id: params.id, consented: false });
};
