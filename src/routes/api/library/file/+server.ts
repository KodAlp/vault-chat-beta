import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readLibraryFile, deleteLibraryEntry } from '$lib/server/library';
import { vaultFromUrl, vaultFromId } from '$lib/server/requestVault';

export const GET: RequestHandler = async ({ url }) => {
	const v = vaultFromUrl(url);
	const path = url.searchParams.get('path');
	if (!path) error(400, 'path gerekli');
	try {
		return json({ path, raw: readLibraryFile(v, path) });
	} catch (err) {
		error(404, err instanceof Error ? err.message : 'Dosya bulunamadı');
	}
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { path: string; vault?: string };
	const v = vaultFromId(body.vault);
	try {
		deleteLibraryEntry(v, body.path);
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Silinemedi');
	}
	return json({ ok: true });
};
