import fs from 'node:fs';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stagingDir } from '$lib/server/library';
import { vaultFromUrl } from '$lib/server/requestVault';

export const POST: RequestHandler = async ({ params, url }) => {
	const v = vaultFromUrl(url);
	fs.rmSync(path.join(stagingDir(v), `${params.id}.md`), { force: true });
	return json({ ok: true });
};
