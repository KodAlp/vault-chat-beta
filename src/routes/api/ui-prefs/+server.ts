import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readUiPrefs, writeUiPrefs, type UiPrefs } from '$lib/server/ui-prefs-store';
import { fail } from '$lib/server/app-error';

/** Desktop-launch persistence for locale/theme/model picks — see
 * ui-prefs-store.ts's doc comment for why localStorage alone isn't enough
 * under the Tauri build's random sidecar port. */
export const GET: RequestHandler = async () => {
	return json(readUiPrefs());
};

/** Sanitization happens inside writeUiPrefs()/sanitizeSettings() — this only
 * rejects a body that isn't even a JSON object, same "invalid JSON / wrong
 * shape" 400 every other PUT route in this app uses. */
export const PUT: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		fail('VALIDATION_INVALID', { field: 'body' }, 400);
	}
	return json(writeUiPrefs(body as UiPrefs));
};
