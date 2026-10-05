import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { vaultFromUrl } from '$lib/server/requestVault';
import { listPending } from '$lib/server/pending-imports';

/** Everything waiting in the vault's staging area for the user's confirm/cancel — browser uploads and
 * MCP imports alike (see pending-imports.ts). For the "pending imports" UI. */
export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	return json({ vault: v.id, imports: listPending(v) });
};
