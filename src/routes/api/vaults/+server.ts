import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVaults, createVault, getActiveVaultId } from '$lib/server/vaults';

export const GET: RequestHandler = async () => {
	return json({ vaults: listVaults(), activeVaultId: getActiveVaultId() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { name: string };
	if (!body.name?.trim()) error(400, "'name' gerekli");
	try {
		const vault = createVault(body.name);
		return json({ vault });
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Vault oluşturulamadı');
	}
};
