import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDeck, deleteDeck } from '#lib/server/study-db.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import { fail } from '#lib/server/app-error.js';

/** GET lives at ./cards/+server.ts (deck + its cards together, what the
 * review page actually needs) — this route only adds DELETE, mirroring
 * mindmaps/[id]/+server.ts's shape. */
export const DELETE: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { vault?: string };
	const v = vaultFromId(body.vault);
	if (!getDeck(v, params.id)) fail('NOT_FOUND', { entity: 'deck' }, 404);
	deleteDeck(v, params.id);
	return json({ ok: true });
};
