import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setActiveVault } from '$lib/server/vaults';

export const POST: RequestHandler = async ({ params }) => {
	try {
		setActiveVault(params.id);
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Vault bulunamadı');
	}
	return json({ ok: true });
};
