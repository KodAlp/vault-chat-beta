import fs from 'node:fs';
import path from 'node:path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { stagingDir } from '$lib/server/library';

export const POST: RequestHandler = async ({ params }) => {
	fs.rmSync(path.join(stagingDir(), `${params.id}.md`), { force: true });
	return json({ ok: true });
};
