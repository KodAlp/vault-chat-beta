import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { renameLibraryEntry } from '$lib/server/library';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { oldPath: string; newPath: string };
	try {
		renameLibraryEntry(body.oldPath, body.newPath);
	} catch (err) {
		error(400, err instanceof Error ? err.message : 'Yeniden adlandırılamadı');
	}
	return json({ ok: true });
};
