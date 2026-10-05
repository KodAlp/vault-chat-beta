import fs from 'node:fs';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stagingDir } from '$lib/server/library';
import { vaultFromUrl } from '$lib/server/requestVault';
import { deleteMeta } from '$lib/server/pending-imports';

export const POST: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	fs.rmSync(path.join(stagingDir(v), `${params.id}.md`), { force: true });
	// MCP imports also keep a status sidecar next to the note (pending-imports.ts).
	deleteMeta(v, params.id);
	return json({ ok: true });
};
