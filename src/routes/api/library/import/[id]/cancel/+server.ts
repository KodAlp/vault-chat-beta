import fs from 'node:fs';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stagingDir } from '$lib/server/library';
import { vaultFromUrl } from '$lib/server/requestVault';
import { deleteMeta, IMPORT_ID_RE } from '$lib/server/pending-imports';
import { fail } from '$lib/server/app-error';
import { discardStagedNote } from '$lib/server/converted-image-cleanup';

export const POST: RequestHandler = async ({ params, url }) => {
	// params.id goes straight into path.join(stagingDir(v), `${id}.md`) below; a staging id is always a
	// crypto.randomUUID(), so anything else (e.g. "../../x") is rejected exactly like the confirm route does.
	if (!IMPORT_ID_RE.test(params.id)) fail('VALIDATION_INVALID', { field: 'importId' });

	const v = vaultFromUrl(url);
	// Deletes the note and then any converted images only it used; never throws.
	await discardStagedNote(v, path.join(stagingDir(v), `${params.id}.md`));
	// MCP imports also keep a status sidecar next to the note (pending-imports.ts).
	deleteMeta(v, params.id);
	return json({ ok: true });
};
