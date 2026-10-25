import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { vaultFromId } from '#lib/server/requestVault.js';
import { dataDir } from '#lib/server/env.js';
import { scanSource, protectedDirsFor } from '#lib/server/library-import/service.js';
import { AppError, fail } from '#lib/server/app-error.js';

/**
 * Step 1 of the library import: detect the source app's format in a folder
 * and build the import plan. Writes NOTHING. Returns a scanId plus the plan
 * summary (counts, skipped files with reasons, warnings, sample target
 * paths); POST /api/library/import-source/run then imports exactly that
 * plan, so the client never names a file or a path at import time.
 *
 * Protected like every other mutating /api route by hooks.server.ts
 * (loopback Host, same-origin, session token). The folder must pass
 * validateScanRoot (absolute, existing, not the filesystem root, not the
 * app's own data/vault/library dirs) and symlinks are never followed.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { vault?: string; path?: unknown; adapter?: unknown } | null;
	const v = vaultFromId(body?.vault);
	try {
		return json(await scanSource(v, body?.path, body?.adapter, protectedDirsFor(v, dataDir())));
	} catch (err) {
		// Coded failures keep their code/params/status for the client.
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}
};
