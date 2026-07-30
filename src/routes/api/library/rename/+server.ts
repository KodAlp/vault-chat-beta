import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { renameLibraryEntry } from '$lib/server/library';
import { vaultFromId } from '$lib/server/requestVault';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { oldPath: string; newPath: string; vault?: string };
	const v = vaultFromId(body.vault);
	try {
		renameLibraryEntry(v, body.oldPath, body.newPath);
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Yeniden adlandırılamadı');
	}
	return json({ ok: true });
};
