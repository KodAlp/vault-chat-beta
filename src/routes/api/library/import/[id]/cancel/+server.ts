import fs from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { stagingDir } from '#lib/server/library.js';
import { vaultFromUrl } from '#lib/server/requestVault.js';
import { deleteMeta, IMPORT_ID_RE } from '#lib/server/pending-imports.js';
import { fail } from '#lib/server/app-error.js';
import { discardStagedNote } from '#lib/server/converted-image-cleanup.js';

export const POST: RequestHandler = async ({ params, url }) => {
	// params.id goes straight into path.join(stagingDir(v), `${id}.md`) below; a staging id is always a
	// crypto.randomUUID(), so anything else (e.g. "../../x") is rejected exactly like the confirm route does.
	if (!IMPORT_ID_RE.test(params.id)) fail('VALIDATION_INVALID', { field: 'importId' });

	const v = vaultFromUrl(url);
	// Deletes the note and then any converted images only it used; never throws.
	await discardStagedNote(v, path.join(stagingDir(v), `${params.id}.md`));
	// MCP imports also keep a status sidecar next to the note (pending-imports.ts).
	deleteMeta(v, params.id);
	return Response.json({ ok: true });
};
