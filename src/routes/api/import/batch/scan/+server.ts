import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { vaultFromId } from '$lib/server/requestVault';
import { dataDir } from '$lib/server/env';
import { libraryRoot } from '$lib/server/library';
import { validateScanRoot, scanFolder } from '$lib/server/folder-scan';
import { scanRegistry } from '$lib/server/scan-registry';
import { AppError, fail } from '$lib/server/app-error';

/**
 * Folder scan for the Linux desktop app, whose webview cannot pick folders
 * (see BatchUploadDialog.svelte). The Tauri dialog gives the client an
 * absolute path; this walks it and returns the importable file list plus a
 * scanId. Files are then imported one at a time through POST /api/import/batch
 * with { scanId, relPath }, which resolves them ONLY inside the scanned root.
 *
 * Protected like every other mutating /api route by hooks.server.ts (loopback
 * Host, same-origin, session token) — this adds no weaker path. The root must
 * be an absolute existing directory that is not the filesystem root, the
 * app's data dir or the vault; symlinks are never followed (folder-scan.ts).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { vault?: string; root?: unknown } | null;
	const v = vaultFromId(body?.vault);
	try {
		const protectedDirs = [dataDir(), v.dir, libraryRoot(v)];
		const rootReal = validateScanRoot(body?.root, protectedDirs);
		const result = scanFolder(rootReal, protectedDirs);
		const scanId = scanRegistry.add(
			v.id,
			rootReal,
			result.entries.filter((e) => !e.skip).map((e) => e.relPath)
		);
		return json({ scanId, folderName: result.folderName.normalize('NFC'), entries: result.entries });
	} catch (err) {
		// Coded failures keep their code/params/status for the client.
		if (err instanceof AppError) fail(err.code, err.params, err.status);
		throw err;
	}
};
