import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importLogPath } from '#lib/server/library.js';
import { vaultFromId } from '#lib/server/requestVault.js';
import { linkManifestPath, loadRetryableUrls } from '#lib/server/link-manifest.js';

/** Links that failed in earlier batches and never imported since — feeds the
 * "load failed links" shortcut in LinksImportDialog. */
export const GET: RequestHandler = ({ url }) => {
	const v = vaultFromId(url.searchParams.get('vault'));
	return json({ links: loadRetryableUrls(linkManifestPath(v), importLogPath(v)) });
};
