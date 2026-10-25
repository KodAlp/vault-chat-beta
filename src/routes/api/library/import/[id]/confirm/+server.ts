import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { vaultFromId } from '#lib/server/requestVault.js';
import { AppError, fail } from '#lib/server/app-error.js';
import { IMPORT_ID_RE } from '#lib/server/pending-imports.js';
import { confirmStagedImport } from '#lib/server/import-confirm.js';

/** The user's confirm click. The work itself lives in import-confirm.ts, shared with the app's auto-confirm of MCP imports. */
export const POST: RequestHandler = async ({ params, request }) => {
	// params.id goes straight into path.join(stagingDir(v), `${id}.md`) in the shared function; every real id is a
	// crypto.randomUUID(), so requiring that shape (shared with the cancel route) rejects a traversal id.
	if (!IMPORT_ID_RE.test(params.id)) fail('VALIDATION_INVALID', { field: 'importId' });

	const body = (await request.json()) as { title: string; domain: string; level: string; vault?: string };
	const v = vaultFromId(body.vault);

	try {
		const { path: relPath } = await confirmStagedImport(v, params.id, { title: body.title, domain: body.domain, level: body.level });
		return json({ ok: true, path: relPath });
	} catch (err) {
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}
};
