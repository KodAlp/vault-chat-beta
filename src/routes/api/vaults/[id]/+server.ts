import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { describeVaultDeletion, deleteVault, listVaults, renameVault } from '$lib/server/vaults';
import { countChatsForVault, deleteChatsForVault } from '$lib/server/chats-db';
import { closeVaultIndexDb } from '$lib/server/retrieve';
import { closeVaultStudyDb } from '$lib/server/study-db';

/** Preview for the delete-confirm dialog — how many chats would be lost.
 * Never deletes anything by itself. */
export const GET: RequestHandler = async ({ params }) => {
	try {
		const info = describeVaultDeletion(params.id, countChatsForVault);
		return json(info);
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Vault bulunamadı');
	}
};

export const PATCH: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as { name: string };
	if (!body.name?.trim()) error(400, "'name' gerekli");
	try {
		const vault = renameVault(params.id, body.name);
		return json({ vault });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Vault bulunamadı');
	}
};

/** Requires an explicit confirm — a bare DELETE call from a stray retry or
 * script must not destroy data. The client is expected to have already
 * shown the GET preview above before sending this. */
export const DELETE: RequestHandler = async ({ params, url }) => {
	if (url.searchParams.get('confirm') !== 'true') {
		error(400, "Silme onayı gerekli ('confirm=true')");
	}
	if (listVaults().length <= 1) {
		error(400, 'Son vault silinemez — uygulama her zaman en az bir vault gerektirir');
	}
	try {
		deleteChatsForVault(params.id);
		// Must close both cached DB connections BEFORE deleteVault removes the
		// vault's directory — Windows refuses to delete a file with an open
		// handle (EBUSY), and retrieve.ts/study-db.ts each cache one
		// better-sqlite3 connection per vault for the process lifetime.
		closeVaultIndexDb(params.id);
		closeVaultStudyDb(params.id);
		deleteVault(params.id);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Vault silinemedi';
		error(message.startsWith('Bilinmeyen vault') ? 404 : 500, message);
	}
	return json({ ok: true });
};
